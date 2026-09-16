import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));

const { trySpawnDetachedViaWmi } = await import('../hook-dispatch-cli.js');

const isWindows = process.platform === 'win32';

/** A child that reports the given outcome once its listeners are attached. */
function fakePowerShell(code: number | null, error?: Error, output = '') {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  let scheduled = false;
  const fire = (event: string, arg: unknown) => handlers.get(event)?.forEach((cb) => cb(arg));
  const stream = {
    on(event: string, cb: (chunk: Buffer) => void) {
      if (event === 'data' && output) setTimeout(() => cb(Buffer.from(output)), 0);
      return stream;
    },
  };
  const child = {
    stdout: stream,
    stderr: stream,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => (error ? fire('error', error) : fire('exit', code)), 5);
      }
      return child;
    },
  };
  return child;
}

/** Pull the payload path the helper appended to the WMI command line. */
function payloadFileOf(script: string): string | undefined {
  return /--stdin-file ([^',\s]+)/.exec(script)?.[1];
}

beforeEach(() => {
  mockSpawn.mockReset().mockReturnValue(fakePowerShell(0));
});

afterEach(() => vi.restoreAllMocks());

describe.runIf(isWindows)('trySpawnDetachedViaWmi', () => {
  it('creates the child through Win32_Process, hidden, with the payload as a file', async () => {
    await expect(trySpawnDetachedViaWmi(
      'C:\\node\\node.exe',
      ['C:\\cli\\index.js', 'hook-dispatch', '--matcher', 'a b'],
      'C:\\work dir',
      '{"session_id":"abc"}',
    )).resolves.toBe(true);

    const [command, argv, options] = mockSpawn.mock.calls[0] as [string, string[], { windowsHide?: boolean }];
    // absolute path: the hook's PATH is the host's, not ours
    expect(command.endsWith('powershell.exe')).toBe(true);
    expect(command).toContain('WindowsPowerShell');
    expect(options.windowsHide).toBe(true);

    const script = argv[argv.length - 1];
    expect(script).toContain("[wmiclass]'Win32_Process'");
    expect(script).toContain('ShowWindow = 0');
    // the command line is one string, so args with spaces are quoted for CreateProcess…
    expect(script).toContain('"a b"');
    // …while the working directory is a plain (PowerShell-literal) path argument
    expect(script).toContain("'C:\\work dir'");

    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    expect(fs.readFileSync(file!, 'utf8')).toBe('{"session_id":"abc"}');
    fs.rmSync(file!, { force: true });
  });

  it('reports failure and cleans up when the provider refuses (caller then falls back)', async () => {
    // A refusal names the ReturnValue, which is definitive: no second attempt.
    mockSpawn.mockReturnValue(fakePowerShell(1, undefined, 'ReturnValue=21'));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).resolves.toBe(false);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const script = (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    expect(fs.existsSync(file!)).toBe(false);
  });

  it('retries with the cmdlet form when the script never reached the provider', async () => {
    // No ReturnValue in the output = the accelerator itself was rejected, which
    // is what a locked-down host looks like. The retry succeeds.
    mockSpawn
      .mockReturnValueOnce(fakePowerShell(1, undefined, "'[wmiclass]' is not recognized"))
      .mockReturnValueOnce(fakePowerShell(0));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).resolves.toBe(true);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect((mockSpawn.mock.calls[1][1] as string[]).at(-1)).toContain('Invoke-CimMethod');
  });

  it('reports failure when PowerShell itself cannot be started', async () => {
    // The realistic shape of a missing binary: an 'error' event, not a throw.
    // Fresh instance per attempt — each one reports its outcome exactly once.
    mockSpawn.mockImplementation(() => fakePowerShell(null, new Error('spawn powershell.exe ENOENT')));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).resolves.toBe(false);

    expect(mockSpawn).toHaveBeenCalledTimes(2); // both attempts tried
  });
});
