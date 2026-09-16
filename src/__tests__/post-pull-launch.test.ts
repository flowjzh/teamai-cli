import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TeamaiConfig } from '../types.js';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

const mockLoadTeamConfig = vi.fn();
vi.mock('../config.js', () => ({ loadTeamConfig: mockLoadTeamConfig }));

const { launchPostPull, launchDeclaredPostPull } = await import('../post-pull.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let debugSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** Records the error handler so a test can fire it, like a failed exec would. */
function fakeChild() {
  const handlers = new Map<string, (e: Error) => void>();
  return {
    on: vi.fn((event: string, cb: (e: Error) => void) => handlers.set(event, cb)),
    unref: vi.fn(),
    fail: (e: Error) => handlers.get('error')?.(e),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-postpull-launch-'));
  mockSpawn.mockReset().mockReturnValue(fakeChild());
  mockLoadTeamConfig.mockReset().mockResolvedValue(null);
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('launchPostPull', () => {
  it('spawns the detached supervisor with repo, script and budget', () => {
    const spec = { scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 120 };
    launchPostPull(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual([
      'post-pull-run',
      '--repo', dir,
      '--script', spec.scriptPath,
      '--timeout-sec', '120',
    ]);
    expect(options.detached).toBe(true);
    expect(options.cwd).toBe(dir);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: launched'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('timeout=120s'));
  });

  it('warns when the launch fails asynchronously', () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);
    launchPostPull({ scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 300 });
    child.fail(new Error('spawn EACCES'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not launch'));
  });
});

describe('launchDeclaredPostPull', () => {
  it('does nothing when the team declares no postPull', async () => {
    await launchDeclaredPostPull(dir);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('skips (and warns) when the declared script is missing', async () => {
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'missing.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(dir);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declared script not found'));
  });

  it('launches a declared script that exists', async () => {
    fs.writeFileSync(path.join(dir, 'post.mjs'), 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'post.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(dir);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('never throws on an escaping path — it only logs', async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: '../outside.mjs' } } } as TeamaiConfig);
    await expect(launchDeclaredPostPull(dir)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: skipped'));
    fs.rmSync(outside, { force: true });
  });
});
