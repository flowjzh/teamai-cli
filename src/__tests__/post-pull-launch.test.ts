import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TeamaiConfig } from '../types.js';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

// The Windows escape is what the supervisor launch goes through; mock it so the
// test asserts the contract instead of starting PowerShell.
const { mockWmi } = vi.hoisted(() => ({
  mockWmi: vi.fn(async (_command: string, _args: string[], _options: { cwd: string; label?: string }) => true),
}));
vi.mock('../hook-dispatch-cli.js', () => ({ trySpawnDetachedViaWmi: mockWmi }));

const mockLoadTeamConfig = vi.fn();
vi.mock('../config.js', () => ({ loadTeamConfig: mockLoadTeamConfig }));

const { launchPostPull, launchDeclaredPostPull } = await import('../post-pull.js');
const { log } = await import('../utils/logger.js');

let dir: string;
let debugSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-postpull-launch-'));
  mockSpawn.mockReset().mockReturnValue(fakeChild());
  mockWmi.mockReset().mockResolvedValue(true);
  mockLoadTeamConfig.mockReset().mockResolvedValue(null);
  debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const supervisorArgs = (scriptPath: string, repoPath: string, timeoutSec: number) => [
  'post-pull-run',
  '--repo', repoPath,
  '--script', scriptPath,
  '--timeout-sec', String(timeoutSec),
];

describe('launchPostPull', () => {
  it('escapes the supervisor launch so the deploy inherits a hidden console', async () => {
    const spec = { scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 120 };
    await launchPostPull(spec);

    expect(mockWmi).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockWmi.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(supervisorArgs(spec.scriptPath, dir, 120));
    expect(options.cwd).toBe(dir);
    expect(options.label).toBe('postPull');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: launched'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('timeout=120s'));
  });

  it('falls back to a plain detached spawn when the escape is unavailable', async () => {
    mockWmi.mockResolvedValue(false);
    const spec = { scriptPath: path.join(dir, 'post.mjs'), repoPath: dir, timeoutSec: 300 };
    await launchPostPull(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(supervisorArgs(spec.scriptPath, dir, 300));
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
  });
});

describe('launchDeclaredPostPull', () => {
  it('does nothing when the team declares no postPull', async () => {
    await launchDeclaredPostPull(dir);
    expect(mockWmi).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('skips (and warns) when the declared script is missing', async () => {
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'missing.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(dir);
    expect(mockWmi).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('declared script not found'));
  });

  it('launches a declared script that exists', async () => {
    fs.writeFileSync(path.join(dir, 'post.mjs'), 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: 'post.mjs' } } } as TeamaiConfig);
    await launchDeclaredPostPull(dir);
    expect(mockWmi).toHaveBeenCalledTimes(1);
  });

  it('never throws on an escaping path — it only logs', async () => {
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.mjs`);
    fs.writeFileSync(outside, 'export {};\n', 'utf8');
    mockLoadTeamConfig.mockResolvedValue({ scripts: { postPull: { path: '../outside.mjs' } } } as TeamaiConfig);
    await expect(launchDeclaredPostPull(dir)).resolves.toBeUndefined();
    expect(mockWmi).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('postPull: skipped'));
    fs.rmSync(outside, { force: true });
  });
});
