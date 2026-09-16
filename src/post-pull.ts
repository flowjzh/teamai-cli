/**
 * Team-defined post-pull scripts (`scripts.postPull` in teamai.yaml).
 *
 * The team repo owns its deployment, but the CLI only knows the surfaces it
 * implements (skills, rules, hooks, MCP, env, docs). `scripts.postPull` is the
 * way to add a step of the team's own: a Node entrypoint (the CLI runs it with
 * its own node, no shell) for extra model or policy files, a silent first-time
 * installer, a deploy of the team's tooling. The CLI's share of the job is
 * deliberately narrow — resolve and validate the path, launch it detached and
 * unawaited (the pull, and the host hook that triggered it, must return
 * immediately), and record the outcome so a quiet machine is still diagnosable.
 *
 * The script is not awaited, so the deadline is enforced by the detached
 * supervisor (`teamai post-pull-run`, spawned by {@link launchDeclaredPostPull}),
 * which outlives the pull and can therefore still log `exited`/`timed out`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { resolveCliEntry } from './builtin-hooks.js';
import { loadTeamConfig } from './config.js';
import { withTimeout } from './utils/async.js';
import { log } from './utils/logger.js';
import { captureTail } from './utils/exec.js';
import { assertSafePath } from './utils/path-safety.js';
import { redactWithEnv } from './utils/redact.js';
import { DEFAULT_POST_PULL_TIMEOUT_SEC, type TeamaiConfig } from './types.js';

/** Output kept from a failed script, for its log line. */
const TAIL_CHARS = 400;

export interface PostPullSpec {
  /** Absolute path of the script, validated to resolve inside `repoPath`. */
  scriptPath: string;
  /** Team repo root — the script's cwd and TEAMAI_REPO. */
  repoPath: string;
  /** Wall-clock budget in seconds before the script is killed. */
  timeoutSec: number;
}

/**
 * Resolve `scripts.postPull` for one team clone, or null when the team declares
 * none. Throws when the declared path escapes the clone — this script runs on
 * every member's machine, so the repo must not be able to point it elsewhere
 * (assertSafePath resolves symlinks on both sides, so a symlink out of the
 * clone is rejected too).
 */
export function resolvePostPullSpec(
  teamConfig: TeamaiConfig,
  repoPath: string,
): PostPullSpec | null {
  const declared = teamConfig.scripts?.postPull;
  if (!declared?.path) return null;
  const scriptPath = path.resolve(repoPath, declared.path);
  assertSafePath(scriptPath, [repoPath]);
  return {
    scriptPath,
    repoPath,
    // the schema defaults it; a hand-built config (tests, older callers) may not have it
    timeoutSec: declared.timeoutSec ?? DEFAULT_POST_PULL_TIMEOUT_SEC,
  };
}

/**
 * Run the team's post-pull script for one pulled scope, if it declares one.
 * Never throws: a team script rides on the pull, so a bad path, a missing file
 * or a failed spawn is one log line — not a failed sync.
 */
export async function launchDeclaredPostPull(repoPath: string): Promise<void> {
  try {
    const teamConfig = await loadTeamConfig(repoPath);
    if (!teamConfig) return;
    const spec = resolvePostPullSpec(teamConfig, repoPath);
    if (!spec) return;
    if (!fs.existsSync(spec.scriptPath)) {
      log.debug(`postPull: declared script not found: ${spec.scriptPath}`);
      return;
    }
    await launchPostPull(spec);
  } catch (e) {
    log.debug(`postPull: skipped: ${(e as Error).message}`);
  }
}

/** Spawn the detached supervisor that runs the script and reports its outcome. */
export async function launchPostPull(spec: PostPullSpec): Promise<void> {
  const entry = resolveCliEntry();
  if (!entry) {
    log.debug(`postPull: could not launch ${spec.scriptPath} (CLI entry not resolvable)`);
    return;
  }
  await launchSupervisor([
    entry,
    'post-pull-run',
    '--repo', spec.repoPath,
    '--script', spec.scriptPath,
    '--timeout-sec', String(spec.timeoutSec),
  ], spec.repoPath);
  log.debug(`postPull: launched path=${spec.scriptPath} timeout=${spec.timeoutSec}s`);
}

/**
 * Start the supervisor so that it owns a HIDDEN console of its own.
 *
 * That console is the whole point: everything the deploy runs below it
 * (update.mjs, npm, git, the CLI) inherits it instead of allocating a visible
 * console each — measured, `detached: true` gives the supervisor no console at
 * all, and every step of the deploy then flashed a window. It cannot simply
 * share this process's console either: the pull's console closes when the pull
 * exits, which would take the supervisor with it.
 */
async function launchSupervisor(args: string[], cwd: string): Promise<void> {
  const { trySpawnDetachedViaWmi } = await import('./hook-dispatch-cli.js');
  if (await trySpawnDetachedViaWmi(process.execPath, args, { cwd, label: 'postPull' })) return;
  try {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => log.debug(`postPull: could not launch ${args[1]}: ${e.message}`));
    child.unref();
  } catch {
    // best effort — the pull must not fail over its post-pull step
  }
}

/**
 * Body of the detached `post-pull-run` child: run the script under a deadline,
 * report how it ended, and never throw — the log line is the whole point.
 */
export async function runPostPull(spec: PostPullSpec): Promise<void> {
  // The launcher validated this before launching, but this is also the body of
  // the internal subcommand — the last thing between an arbitrary --script and
  // spawn() — so the containment is re-derived here.
  try {
    assertSafePath(spec.scriptPath, [spec.repoPath]);
  } catch (e) {
    log.debug(`postPull: refused ${spec.scriptPath}: ${(e as Error).message}`);
    return;
  }

  const startedAt = Date.now();
  const child = spawn(process.execPath, [spec.scriptPath], {
    cwd: spec.repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TEAMAI_REPO: spec.repoPath,
      TEAMAI_POSTPULL_TIMEOUT_SEC: String(spec.timeoutSec),
    },
  });
  const readTail = captureTail(child, TAIL_CHARS);

  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      log.debug(`postPull: could not run ${spec.scriptPath}: ${e.message}`);
      resolve(null);
    });
    // 'close', not 'exit': the last output chunks can arrive after the process
    // is gone, and this tail is the whole failure report.
    child.on('close', (code) => resolve(code));
  });

  let code: number | null;
  try {
    code = await withTimeout(exited, spec.timeoutSec * 1000, 'postPull deadline');
  } catch {
    killChildTree(child);
    log.debug(`postPull: timed out after ${spec.timeoutSec}s — killed ${spec.scriptPath}`);
    return;
  }

  const ms = Date.now() - startedAt;
  if (code === null) return;
  if (code === 0) {
    log.debug(`postPull: exited 0 in ${ms}ms (${spec.scriptPath})`);
    return;
  }
  const tail = redactWithEnv(readTail());
  log.debug(`postPull: exited ${code} in ${ms}ms (${spec.scriptPath})${tail ? ` — ${tail}` : ''}`);
}

/** Best-effort kill for a script that ignored its deadline. */
function killChildTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // node's kill() terminates only the direct child; /T reaches whatever the
    // script started (git, installers, shell wrappers).
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      // best effort — the timeout is logged either way
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // best effort
  }
}
