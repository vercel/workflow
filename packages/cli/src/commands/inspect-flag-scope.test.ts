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
  const config = await Config.load(new URL('../..', import.meta.url).pathname);
  const messages: string[] = [];
  const logError = vi
    // biome-ignore lint/suspicious/noExplicitAny: reaching a protected member
    .spyOn(Inspect.prototype as any, 'logError')
    .mockImplementation((message: unknown) => {
      messages.push(String(message));
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

describe('inspect flag validation runs before any backend setup', () => {
  beforeEach(() => {
    state.setupCliWorld.mockReset();
    process.exitCode = 0;
  });

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
