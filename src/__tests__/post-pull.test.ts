import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TeamaiConfig } from '../types.js';

const mockLoadTeamConfig = vi.fn();
vi.mock('../config.js', () => ({ loadTeamConfig: mockLoadTeamConfig }));

const { runPostPull, runDeclaredPostPull, POST_PULL_BUDGET_SEC } = await import('../post-pull.js');
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
  vi.restoreAllMocks();
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
  it('fits under the pull handler deadline minus a cold pull (~25s)', () => {
    // The outcome line must land before the handler deadline can exit the
    // process; pins the two constants whose relation the comments describe.
    expect(POST_PULL_BUDGET_SEC * 1000).toBeLessThan(PULL_TIMEOUT_MS - 25_000);
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
       setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 1100);`,
    );

    await runPostPull(path.join(dir, 'hang.mjs'), dir, 1);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: timed out after 1s — orphaned'));

    await vi.waitUntil(() => fs.existsSync(marker), { timeout: 10_000, interval: 50 });
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
