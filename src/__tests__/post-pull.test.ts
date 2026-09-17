import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TeamaiConfig } from '../types.js';

const mockLoadTeamConfig = vi.fn();
vi.mock('../config.js', () => ({ loadTeamConfig: mockLoadTeamConfig }));

// spawn is mocked with a passthrough default, so the awaited-mode tests keep
// real child processes; the interactive test shadows it for one call. The
// default lives in the factory and afterEach only clears history, so it
// survives between tests.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  mockSpawn.mockImplementation((...args: Parameters<typeof actual.spawn>) =>
    actual.spawn(...args) as ReturnType<typeof actual.spawn>,
  );
  return { ...actual, spawn: mockSpawn };
});

const { runPostPull, runDeclaredPostPull, POST_PULL_BUDGET_SEC, COLD_PULL_WORST_CASE_MS } =
  await import('../post-pull.js');
const { PULL_TIMEOUT_MS } = await import('../hook-handlers.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-postpull-'));
  mockLoadTeamConfig.mockReset().mockResolvedValue(null);
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  // Targeted on purpose: restoreAllMocks would strip the factory-set spawn
  // passthrough. History is what must not leak between tests.
  debugSpy.mockRestore();
  mockLoadTeamConfig.mockReset();
  mockSpawn.mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeScript(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function teamConfig(postPull?: { path: string }): TeamaiConfig {
  return { scripts: postPull ? { postPull } : undefined } as TeamaiConfig;
}

describe('budget sizing', () => {
  it('fits under the pull handler deadline minus a cold pull', () => {
    // The outcome line must land before the handler deadline can exit the
    // process; pins the constants whose relation the comments describe.
    expect(POST_PULL_BUDGET_SEC * 1000).toBeLessThan(PULL_TIMEOUT_MS - COLD_PULL_WORST_CASE_MS);
  });
});

describe('runDeclaredPostPull (interactive)', () => {
  it('launches fire-and-forget into the user terminal instead of waiting', async () => {
    writeScript('post.mjs', 'export {};\n');
    mockLoadTeamConfig.mockResolvedValue(teamConfig({ path: 'post.mjs' }));
    const fakeChild = { on: vi.fn(), unref: vi.fn(), stdout: null, stderr: null };
    mockSpawn.mockReturnValueOnce(fakeChild as never);

    await runDeclaredPostPull(dir, { interactive: true });

    const [command, args, options] = mockSpawn.mock.calls.at(-1)!;
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(path.join(dir, 'post.mjs'));
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit']);
    expect(options.env.TEAMAI_POSTPULL_TIMEOUT_SEC).toBe(String(POST_PULL_BUDGET_SEC));
    expect(fakeChild.unref).toHaveBeenCalled();
    // No waited outcome line for this shape: the user's terminal is the report.
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('unawaited, terminal attached'));
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringMatching(/postPull: exited/));
  });
});

describe('runPostPull (in-process)', () => {
  it('runs the script with the repo env and default budget, and records a clean exit', async () => {
    const envOut = path.join(dir, 'env.json');
    writeScript(
      'ok.mjs',
      `import fs from 'node:fs';
       fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
         repo: process.env.TEAMAI_REPO,
         timeout: process.env.TEAMAI_POSTPULL_TIMEOUT_SEC,
         cwd: process.cwd(),
       }));`,
    );

    await runPostPull(path.join(dir, 'ok.mjs'), dir);

    const seen = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
    expect(seen.repo).toBe(dir);
    expect(seen.timeout).toBe(String(POST_PULL_BUDGET_SEC));
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(dir));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/postPull: exited 0 in \d+ms/));
  });

  it('records a non-zero exit together with the output tail', async () => {
    writeScript('fail.mjs', 'process.stderr.write("boom: missing config\\n"); process.exit(3);\n');
    await runPostPull(path.join(dir, 'fail.mjs'), dir, 30);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: exited 3 in'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('boom: missing config'));
  });

  it('stops waiting on a script that overruns its budget, without killing it', async () => {
    // The old supervisor killed an overrunning script; the pull only detaches
    // from it now, so a deploy can finish instead of stranding the machine.
    const marker = path.join(dir, 'alive.json');
    writeScript(
      'hang.mjs',
      `import fs from 'node:fs';
       import os from 'node:os';
       // step out of the temp dir: Windows refuses to delete a running
       // process's cwd, and this orphan outlives the test
       process.chdir(os.tmpdir());
       setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 300);`,
    );

    await runPostPull(path.join(dir, 'hang.mjs'), dir, 0.05);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: timed out after 0.05s — orphaned'));

    await vi.waitUntil(() => fs.existsSync(marker), { timeout: 10_000, interval: 25 });
  });
});

describe('runDeclaredPostPull', () => {
  it('does nothing when the team declares no postPull', async () => {
    await runDeclaredPostPull(dir);
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('postPull:'));
  });

  it('skips when the declared script is missing', async () => {
    mockLoadTeamConfig.mockResolvedValue(teamConfig({ path: 'missing.mjs' }));
    await runDeclaredPostPull(dir);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('declared script not found'));
  });

  it('runs a declared script, resolved against the repo root', async () => {
    const marker = path.join(dir, 'ran.json');
    writeScript('nested/post.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    mockLoadTeamConfig.mockResolvedValue(teamConfig({ path: 'nested/post.mjs' }));

    await runDeclaredPostPull(dir);

    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/postPull: exited 0 in \d+ms/));
  });

  it('never throws on an escaping path — it only logs', async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue(teamConfig({ path: '../outside.mjs' }));

    await expect(runDeclaredPostPull(dir)).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: skipped'));
    fs.rmSync(outside, { force: true });
  });

  it('rejects a symlink pointing out of the clone when the platform allows it', async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(dir, 'link.mjs'));
    } catch {
      linked = false; // creating symlinks needs privileges on Windows; nothing to assert
    }

    if (linked) {
      mockLoadTeamConfig.mockResolvedValue(teamConfig({ path: 'link.mjs' }));
      await expect(runDeclaredPostPull(dir)).resolves.toBeUndefined();
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: skipped'));
    }

    fs.rmSync(outside, { force: true });
  });
});
