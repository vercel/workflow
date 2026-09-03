import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ setupCliWorld: vi.fn() }));

// The property under test is that these checks run *before* any backend work,
// so the setup module is replaced rather than exercised. A call to it means
// validation let the arguments through.
vi.mock('../lib/inspect/setup.js', () => ({
  setupCliWorld: state.setupCliWorld,
}));

const { default: Inspect } = await import('./inspect.js');

/**
 * Run the command and return the message it rejected with.
 *
 * `logError` delegates to oclif's `this.error`, which throws; that rejection
 * is captured here. `process.exit` is stubbed because `BaseCommand.finally`
 * calls it. Note that stubbing `process.stderr.write` to read the message
 * instead deadlocks vitest's reporter — hence spying on the command.
 */
const runInspect = async (argv: string[]): Promise<string> => {
  // `fileURLToPath`, not `.pathname`: on Windows the latter yields
  // `/D:/a/...` — a leading slash before the drive letter — which
  // `Config.load` cannot resolve, so it reports a missing package.json.
  const config = await Config.load(
    fileURLToPath(new URL('../..', import.meta.url))
  );
  const messages: string[] = [];
  const logError = vi
    // `logError` is protected; the cast reaches it without widening the
    // public surface.
    .spyOn(
      Inspect.prototype as unknown as Record<string, (message: string) => void>,
      'logError'
    )
    .mockImplementation((message: string) => {
      messages.push(message);
    });
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  try {
    await Inspect.run(argv, config).catch(() => undefined);
    return messages.join('\n');
  } finally {
    exit.mockRestore();
    logError.mockRestore();
  }
};

const VALID_RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';

beforeEach(() => {
  state.setupCliWorld.mockReset();
  process.exitCode = 0;
});

describe('inspect flag validation runs before any backend setup', () => {
  // --attribute was parsed on every resource but consumed only by the runs
  // listing, so these returned a normal, unfiltered answer.
  it.each([
    ['steps', ['steps', '--runId', VALID_RUN]],
    ['events', ['events', '--runId', VALID_RUN]],
    ['hooks', ['hooks']],
    ['attributes', ['attributes']],
  ])('rejects --attribute on %s without reaching a backend', async (_label, argv) => {
    const message = await runInspect([...argv, '--attribute', 'tenant=acme']);
    expect(message).toContain('--attribute filters run listings only');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it('rejects --attribute alongside a run ID', async () => {
    const message = await runInspect([
      'run',
      VALID_RUN,
      '--attribute',
      'tenant=acme',
    ]);
    expect(message).toContain('already names one run');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it.each([
    ['an out-of-range limit', ['runs', '--limit', '5000'], '--limit must be'],
    ['a malformed runId', ['steps', '--runId', 'nope'], '--runId must be'],
  ])('rejects %s', async (_label, argv, expected) => {
    expect(await runInspect(argv)).toContain(expected);
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it('lets --attribute through on the runs listing', async () => {
    const message = await runInspect([
      'runs',
      '--attribute',
      'tenant=acme',
      '--backend',
      'local',
    ]);
    expect(message).not.toContain('--attribute');
    expect(state.setupCliWorld).toHaveBeenCalled();
  });
});

describe('inspect --attribute cannot reach the web UI', () => {
  // Both of these return before `toInspectOptions` parses the filter, so the
  // flag used to be accepted, never validated, and the view opened unfiltered.
  it.each([
    ['--url', ['runs', '--attribute', 'tenant=acme', '--url']],
    ['--web', ['runs', '--attribute', 'tenant=acme', '--web']],
    ['the web resource', ['web', '--attribute', 'tenant=acme']],
  ])('rejects --attribute with %s', async (_label, argv) => {
    const message = await runInspect(argv);
    expect(message).toContain('cannot be forwarded to the web UI');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  // Previously bypassed validation entirely on this path.
  it('rejects a malformed pair even with --url', async () => {
    const message = await runInspect([
      'runs',
      '--attribute',
      'tenant',
      '--url',
    ]);
    expect(message).toContain('cannot be forwarded to the web UI');
  });
});

describe('inspect --attribute conflicts and syntax', () => {
  it('rejects --attribute with --withData', async () => {
    const message = await runInspect([
      'runs',
      '--attribute',
      'tenant=acme',
      '--withData',
    ]);
    expect(message).toContain('cannot be combined with --withData');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  // Previously parsed inside toInspectOptions, after setupCliWorld, so a
  // syntax error cost a full auth and project lookup first.
  it.each([
    ['a missing separator', ['runs', '--attribute', 'tenant']],
    ['an empty key', ['runs', '--attribute', '=acme']],
  ])('rejects %s before backend setup', async (_label, argv) => {
    const message = await runInspect(argv);
    expect(message).toContain('--attribute must be key=value');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it('rejects more than the allowed pairs before backend setup', async () => {
    const argv = ['runs'];
    for (let i = 0; i < 9; i += 1) argv.push('--attribute', `k${i}=v`);
    const message = await runInspect(argv);
    expect(message).toContain('--attribute may be given at most 8 times');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it('rejects a duplicate key before backend setup', async () => {
    const message = await runInspect([
      'runs',
      '--attribute',
      'tenant=a',
      '--attribute',
      'tenant=b',
    ]);
    expect(message).toContain('was given more than once');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });

  it('rejects a limit above the smallest listing cap', async () => {
    const message = await runInspect(['runs', '--limit', '500']);
    expect(message).toContain('--limit must be an integer between 1 and 100');
    expect(state.setupCliWorld).not.toHaveBeenCalled();
  });
});
