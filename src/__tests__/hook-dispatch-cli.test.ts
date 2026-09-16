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
function fakePowerShell(code: number | null, error?: Error) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  let scheduled = false;
  const fire = (event: string, arg: unknown) => handlers.get(event)?.forEach((cb) => cb(arg));
  const child = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => (error ? fire('error', error) : fire('exit', code)), 0);
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
    mockSpawn.mockReturnValue(fakePowerShell(1));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).resolves.toBe(false);

    const script = (mockSpawn.mock.calls[0][1] as string[]).at(-1)!;
    const file = payloadFileOf(script);
    expect(file).toBeTruthy();
    expect(fs.existsSync(file!)).toBe(false);
  });

  it('reports failure when PowerShell itself cannot be started', async () => {
    mockSpawn.mockReturnValue(fakePowerShell(null, new Error('spawn powershell.exe ENOENT')));

    await expect(trySpawnDetachedViaWmi('node', ['cli.js'], undefined, '{}')).resolves.toBe(false);
  });
});
