/**
 * Team-defined post-pull scripts (`scripts.postPull` in teamai.yaml).
 *
 * The team repo owns its deployment, but the CLI only knows the surfaces it
 * implements (skills, rules, hooks, MCP, env, docs). `scripts.postPull` is the
 * extension point for everything else: the team's own tooling, extra model or
 * policy files, a silent first-time installer. The CLI's share of the job is
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

import { resolveTeamaiEntryScript } from './builtin-hooks.js';
import { loadTeamConfig } from './config.js';
import { withTimeout } from './utils/async.js';
import { log } from './utils/logger.js';
import { assertSafePath } from './utils/path-safety.js';
import type { TeamaiConfig } from './types.js';

/** Budget for a team post-pull script when teamai.yaml does not set one. */
export const DEFAULT_POST_PULL_TIMEOUT_SEC = 300;

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
      log.warn(`postPull: declared script not found: ${spec.scriptPath}`);
      return;
    }
    launchPostPull(spec);
  } catch (e) {
    log.warn(`postPull: skipped: ${(e as Error).message}`);
  }
}

/** Spawn the detached supervisor that runs the script and reports its outcome. */
export function launchPostPull(spec: PostPullSpec): void {
  // `argv[1]` is the running CLI, but some sandboxed hook launchers leave it
  // empty — same fallback the pushed-command runner uses.
  const entry = process.argv[1] ?? resolveTeamaiEntryScript();
  if (!entry) {
    log.warn(`postPull: could not launch ${spec.scriptPath} (CLI entry not resolvable)`);
    return;
  }
  // A plain detached spawn is enough here: the supervisor only has to outlive
  // this process, and whichever host started the pull has already been escaped
  // (the session-start pull is the one that has to leave a job object).
  const child = spawn(
    process.execPath,
    [
      entry,
      'post-pull-run',
      '--repo', spec.repoPath,
      '--script', spec.scriptPath,
      '--timeout-sec', String(spec.timeoutSec),
    ],
    { cwd: spec.repoPath, detached: true, windowsHide: true, stdio: 'ignore' },
  );
  child.on('error', (e) => log.warn(`postPull: could not launch ${spec.scriptPath}: ${e.message}`));
  child.unref();
  log.debug(`postPull: launched path=${spec.scriptPath} timeout=${spec.timeoutSec}s`);
}

/**
 * Body of the detached `post-pull-run` child: run the script under a deadline,
 * report how it ended, and never throw — the log line is the whole point.
 */
export async function runPostPull(spec: PostPullSpec): Promise<void> {
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [spec.scriptPath], {
      cwd: spec.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEAMAI_REPO: spec.repoPath,
        TEAMAI_POSTPULL_TIMEOUT_SEC: String(spec.timeoutSec),
      },
    });
  } catch (e) {
    log.warn(`postPull: spawn failed: ${(e as Error).message}`);
    return;
  }

  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-TAIL_CHARS);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      spawnError = e;
      resolve(null);
    });
    child.on('exit', (code) => resolve(code));
  });

  let code: number | null;
  try {
    code = await withTimeout(exited, spec.timeoutSec * 1000, 'postPull deadline');
  } catch {
    killChildTree(child);
    log.warn(`postPull: timed out after ${spec.timeoutSec}s — killed ${spec.scriptPath}`);
    return;
  }

  const ms = Date.now() - startedAt;
  if (spawnError) {
    log.warn(`postPull: could not run ${spec.scriptPath}: ${spawnError.message}`);
    return;
  }
  if (code === 0) {
    log.debug(`postPull: exited 0 in ${ms}ms (${spec.scriptPath})`);
    return;
  }
  const tail = output.trim().replace(/\s+/g, ' ').slice(-TAIL_CHARS);
  log.warn(`postPull: exited ${code} in ${ms}ms (${spec.scriptPath})${tail ? ` — ${tail}` : ''}`);
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
