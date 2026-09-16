/**
 * CLI entry point for `teamai hook-dispatch <event> --tool <tool> [--matcher <m>]`.
 * Reads STDIN once, fans out to all matching handlers, writes at most one
 * handler's output to STDOUT. STDOUT is reserved for the AI-tool hook JSON
 * payload; all log lines go to STDERR (see setStderrOnly below).
 *
 * Foreground vs background:
 *   Handlers that may return output the host injects back into the session run
 *   inline (foreground). Pure side-effect handlers (version check, dashboard,
 *   local-agent) are marked `background` and run in a detached child process so
 *   a slow registry/network call cannot delay the host's hook completion —
 *   critical for CodeBuddy's 10s hook timeout. Detaching also survives the
 *   caller's process.exit(0) (index.ts), which otherwise kills in-process
 *   fire-and-forget work before it finishes.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTeamaiEntryScript } from './builtin-hooks.js';
import { createDispatcher, type Dispatcher } from './hook-dispatch.js';
import { buildHandlerRegistry, filterHandlersForConfig } from './hook-handlers.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { log, setStderrOnly } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';

/**
 * Max time to wait for STDIN EOF before proceeding with whatever was received.
 *
 * `for await (process.stdin)` only ends when the host closes the pipe (EOF). If
 * the host (e.g. CodeBuddy) writes the hook payload but never closes STDIN — or
 * opens the pipe without sending EOF — the read would hang until the host aborts
 * the hook with "Hook timed out after 10000ms" (error 3003), all *before* any
 * handler timeout can engage. Racing a short deadline lets us continue with the
 * payload we already buffered (a healthy host EOFs within milliseconds, so this
 * never triggers in normal use).
 */
const STDIN_READ_TIMEOUT_MS = 1_000;

/**
 * Read STDIN fully, but never block longer than STDIN_READ_TIMEOUT_MS waiting
 * for EOF. Returns empty string if STDIN is a TTY. On timeout, returns whatever
 * chunks were already received (typically the full payload minus a missing EOF).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  const readAll = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STDIN_READ_TIMEOUT_MS);
    // Don't let this timer itself keep the event loop alive.
    timer.unref();
  });
  try {
    await Promise.race([readAll, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Swallow late read errors/rejections so an aborted read can't crash the hook.
  readAll.catch(() => {});
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Start the detached child that re-runs this same dispatch for background-only
 * handlers, feeding it the already-consumed STDIN. The returned function settles
 * the launch: it must be awaited before the hook returns, so this process — and
 * with it the host's job object — stays alive until the child really exists.
 *
 * On Windows detaching alone does not free the child — it would still inherit
 * the hook's job object — so it is created through WMI first (see
 * trySpawnDetachedViaWmi) and only falls back to the plain spawn below.
 */
function spawnBackground(
  event: string,
  tool: string,
  matcher: string,
  raw: string,
  cwd?: string,
): () => Promise<void> {
  // `argv[1]` is the running CLI, but some sandboxed hook launchers leave it
  // empty — same fallback the pushed-command runner uses.
  const entry = process.argv[1] ?? resolveTeamaiEntryScript() ?? '';
  const args = [entry, 'hook-dispatch', event, '--tool', tool, '--bg-only'];
  if (matcher && matcher !== '*') {
    args.push('--matcher', matcher);
  }
  if (process.platform !== 'win32') return () => spawnPlainDetached(process.execPath, args, raw, cwd);
  return async () => {
    if (!await trySpawnDetachedViaWmi(process.execPath, args, cwd, raw)) {
      await spawnPlainDetached(process.execPath, args, raw, cwd);
    }
  };
}

/** Plain `detached: true` child, awaiting the STDIN flush before the caller may exit. */
async function spawnPlainDetached(
  command: string,
  args: string[],
  stdin: string,
  cwd?: string,
): Promise<void> {
  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      ...(cwd ? { cwd } : {}),
    });
    child.on('error', () => {});
    await new Promise<void>((resolve) => {
      if (!child.stdin) return resolve();
      child.stdin.on('error', () => resolve());
      child.stdin.end(stdin, () => resolve());
    });
    child.unref();
  } catch {
    // Never let a spawn failure surface to the host — background work is best-effort.
  }
}

/**
 * Create a detached child through the WMI service instead of CreateProcess.
 *
 * Windows hosts (WorkBuddy/CodeBuddy) run hook commands inside a job object and
 * terminate that job the moment the hook's direct child exits, so a child of
 * ours — even a `detached: true` one, which only gets DETACHED_PROCESS and
 * CREATE_NEW_PROCESS_GROUP — dies with the hook. Leaving a job requires
 * CREATE_BREAKAWAY_FROM_JOB, which node never passes; a process created by the
 * WMI service is outside our job by construction. Costs ~0.3s (PowerShell
 * startup + the provider round trip), overlapped with the foreground pass.
 *
 * Two details this depends on:
 *   - Win32_ProcessStartup.ShowWindow = 0 hides the new console AT CREATION.
 *     `-WindowStyle Hidden` only hides it once PowerShell has started (the
 *     window still flashes), and the provider rejects CREATE_NO_WINDOW with
 *     ReturnValue 21.
 *   - the creating PowerShell runs with `windowsHide` (CREATE_NO_WINDOW), so not
 *     even it flashes.
 *
 * WMI has no STDIN pipe, so `stdin` travels as a temp file named on the command
 * line (`--stdin-file`); the child reads and removes it (readStdinFile).
 *
 * @returns true when the child was created; false when WMI refused or failed —
 *   the caller then falls back to the plain detached spawn.
 */
export async function trySpawnDetachedViaWmi(
  command: string,
  args: string[],
  cwd: string | undefined,
  stdin: string,
): Promise<boolean> {
  const payloadFile = path.join(os.tmpdir(), `teamai-hook-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(payloadFile, stdin, 'utf8');
  } catch {
    return false;
  }

  const commandLine = [command, ...args, '--stdin-file', payloadFile].map(quoteWindowsArg).join(' ');
  const dir = psLiteral(cwd ?? '');

  // Two spellings of the same provider call. The type accelerator is the fast
  // one (~0.3s); the cmdlet form is the fallback for hosts that run hooks under
  // a PowerShell policy or a constrained language mode, where the accelerator
  // itself is rejected — measured: WorkBuddy's hook environment refuses the
  // accelerator while the provider is reachable.
  const attempts = [
    [
      "$s = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
      '$s.ShowWindow = 0',
      `$r = ([wmiclass]'Win32_Process').Create(${psLiteral(commandLine)}, ${dir}, $s)`,
      'if ($r.ReturnValue -ne 0) { Write-Output ("ReturnValue=" + $r.ReturnValue); exit 1 }',
    ].join('; '),
    [
      // ShowWindow is uint16 on the class: an int is rejected as a type
      // mismatch, the embedded startup instance never reaches the provider.
      '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(commandLine)}; CurrentDirectory = ${dir}; ProcessStartupInformation = $s }`,
      'if ($r.ReturnValue -ne 0) { Write-Output ("ReturnValue=" + $r.ReturnValue); exit 1 }',
    ].join('; '),
  ];

  const failures: string[] = [];
  for (const script of attempts) {
    const outcome = await runPowerShell(script);
    if (outcome.ok) return true;
    failures.push(outcome.detail);
    // A provider refusal is definitive — the cmdlet form would return the same
    // value. Only a script that never reached the call is worth retrying, since
    // that is what an accelerator/policy rejection looks like.
    if (outcome.detail.includes('ReturnValue=')) break;
  }

  fs.rmSync(payloadFile, { force: true });
  // Loud on purpose: a silent fallback here is exactly how the bug this path
  // exists for looked in the field (work never ran, nothing was logged).
  log.debug(`hook-dispatch: WMI escape unavailable (${failures.join('; ')}) - falling back to the plain detached spawn`);
  return false;
}

/** Run one PowerShell attempt, keeping a little output for the log line. */
function runPowerShell(script: string): Promise<{ ok: boolean; detail: string }> {
  let ps;
  try {
    ps = spawn(
      windowsPowerShell(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return Promise.resolve({ ok: false, detail: (e as Error).message });
  }
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-200);
  };
  ps.stdout?.on('data', collect);
  ps.stderr?.on('data', collect);
  return new Promise((resolve) => {
    ps.on('error', (e) => resolve({ ok: false, detail: e.message }));
    ps.on('exit', (code) => {
      const tail = output.trim().replace(/\s+/g, ' ').slice(-160);
      resolve({ ok: code === 0, detail: code === 0 ? '' : `exit ${code}${tail ? `: ${tail}` : ''}` });
    });
  });
}

/**
 * Windows PowerShell by absolute path. The hook inherits whatever PATH its host
 * hands over — measured: WorkBuddy's leaves `spawn('powershell.exe')` failing,
 * which would quietly degrade every escape to an in-job spawn. Falls back to a
 * PATH lookup only when the file is genuinely not there.
 */
function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/** Encode a value as a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote one CreateProcess argument, leaving plain paths and flags untouched. */
function quoteWindowsArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Read the STDIN payload a parent could not pipe, and remove it. The Windows/WMI
 * spawn path has no STDIN pipe, so the parent hands the payload over as a temp
 * file.
 */
function readStdinFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    log.debug(`hook-dispatch: could not read STDIN file ${file}: ${(e as Error).message}`);
    return '';
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Parse STDIN JSON and normalize the event name for downstream handlers. */
function parseStdin(raw: string, event: string): Record<string, unknown> | null {
  let stdin: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      stdin = JSON.parse(raw);
    } catch {
      log.debug(`hook-dispatch: failed to parse STDIN JSON for event=${event}`);
      return null;
    }
  }

  // WorkBuddy/CodeBuddy may pass hook_event_name: "" — normalize to the
  // CLI-derived event name so downstream handlers (parseHookEvent, etc.)
  // can correctly determine the event type.
  if (!stdin.hook_event_name) {
    const EVENT_MAP: Record<string, string> = {
      'session-start': 'SessionStart',
      'stop': 'Stop',
      'post-tool-use': 'PostToolUse',
      'prompt-submit': 'UserPromptSubmit',
    };
    stdin.hook_event_name = EVENT_MAP[event] ?? event;
  }
  const cwd = resolveHookCwd(stdin);
  if (cwd) stdin.cwd = cwd;
  return stdin;
}

/** Run one dispatch pass and log any handler errors (never to STDOUT). */
async function runDispatch(
  dispatcher: Dispatcher,
  event: string,
  matcher: string,
  stdin: Record<string, unknown>,
  tool: string,
  mode: 'foreground' | 'background',
): Promise<string | null> {
  const result = await dispatcher.dispatch(event, matcher, stdin, tool, mode);
  for (const err of result.errors) {
    log.debug(`hook-dispatch: handler "${err.handlerName}" failed: ${err.error.message}`);
  }
  return result.output;
}

/**
 * Main CLI handler for hook-dispatch.
 *
 * @param options Internal-only switches, set by the detached child's own spawn
 *   or by its parent: `bgOnly` runs only background handlers and never spawns
 *   again (prevents recursion), `stdinFile` carries the payload the Windows
 *   spawn path cannot pipe.
 */
export async function hookDispatchCli(
  event: string,
  tool: string,
  matcher: string,
  options: { bgOnly?: boolean; stdinFile?: string } = {},
): Promise<void> {
  const { bgOnly = false, stdinFile } = options;
  setStderrOnly(true);
  try {
    const raw = stdinFile ? readStdinFile(stdinFile) : await readStdin();
    const stdin = parseStdin(raw, event);
    if (stdin === null) return;

    // Provider-config gate: HTTP-only teams must not receive git-provider-only
    // hook prompts (contribute / mr-hint / votes). Prefer the project-scope
    // config when the host tells us the working directory (#264), so
    // filterHandlersForConfig can honour a project-level repo.kind.
    const { loadLocalConfig, detectProjectConfig } = await import('./config.js');
    const cwd = resolveHookCwd(stdin);
    if (cwd) {
      try {
        process.chdir(cwd);
      } catch (e) {
        log.debug(`hook-dispatch: chdir to ${cwd} failed: ${(e as Error).message}`);
      }
    }
    const localConfig = (cwd ? await detectProjectConfig(cwd) : null) ?? await loadLocalConfig();
    const handlers = filterHandlersForConfig(buildHandlerRegistry(), localConfig);
    const dispatcher = createDispatcher({ handlers });

    // Detached child: run the fire-and-forget handlers, then exit. No output is
    // wired back to the host (the parent already returned).
    if (bgOnly) {
      await runDispatch(dispatcher, event, matcher, stdin, tool, 'background');
      return;
    }

    // Parent: kick off background handlers in a detached process first so they
    // start working while we run the inline (foreground) pass.
    let settleBackground: (() => Promise<void>) | undefined;
    if (dispatcher.hasBackground(event, matcher)) {
      // Preserve one fallback ID across the parent and detached child. Without
      // this, hosts that omit session_id produce different PID-based IDs and
      // the foreground and post-pull paths can claim the same hint twice.
      if (typeof stdin.session_id !== 'string' || !stdin.session_id) {
        stdin.session_id = deriveSessionId(stdin, { includeCwd: true });
      }
      settleBackground = spawnBackground(event, tool, matcher, JSON.stringify(stdin), cwd);
    }

    const output = await runDispatch(dispatcher, event, matcher, stdin, tool, 'foreground');

    if (output) {
      await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
    }

    // The Windows escape overlaps the foreground pass, so this only waits out
    // its remainder — the process must outlive the launch, because its exit is
    // what takes the host's job object (and the child inside it) down.
    await settleBackground?.();
  } catch (e) {
    log.warn(`hook-dispatch: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
