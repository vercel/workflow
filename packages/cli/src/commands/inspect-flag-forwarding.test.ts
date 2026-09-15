import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toInspectOptions } from './inspect.js';

const state = vi.hoisted(() => ({
  setupCliWorld: vi.fn(),
  listEvents: vi.fn(),
  listAttributes: vi.fn(),
}));

vi.mock('../lib/inspect/setup.js', () => ({
  setupCliWorld: state.setupCliWorld,
}));

// Only the two listings these cases dispatch to are replaced; the rest of the
// module is kept so the command's imports still resolve.
vi.mock('../lib/inspect/output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inspect/output.js')>()),
  listEvents: state.listEvents,
  listAttributes: state.listAttributes,
}));

const { default: Inspect } = await import('./inspect.js');

const VALID_RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
const VALID_HOOK = 'hook_01K4BZQ5T2J8HXFM6WD3PNAVCE';

const runInspect = async (argv: string[]): Promise<void> => {
  const config = await Config.load(
    fileURLToPath(new URL('../..', import.meta.url))
  );
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  try {
    await Inspect.run(argv, config).catch(() => undefined);
  } finally {
    exit.mockRestore();
  }
};

beforeEach(() => {
  state.setupCliWorld.mockReset().mockResolvedValue({});
  state.listEvents.mockReset().mockResolvedValue(undefined);
  state.listAttributes.mockReset().mockResolvedValue(undefined);
  process.exitCode = 0;
});

/**
 * A flag that parses, clears validation, and is then dropped before any
 * listing reads it is indistinguishable from a successful unfiltered answer.
 * Unit tests on the listings cannot see it: they pass options directly and so
 * skip the projection where the drop happens. These go through `Inspect.run`.
 */
describe('flag forwarding through the command', () => {
  it('forwards --hookId to the events listing', async () => {
    await runInspect(['events', '--runId', VALID_RUN, '--hookId', VALID_HOOK]);

    expect(state.listEvents).toHaveBeenCalled();
    expect(state.listEvents.mock.calls[0][1]).toMatchObject({
      hookId: VALID_HOOK,
      runId: VALID_RUN,
    });
  });

  it('forwards --stepId to the events listing', async () => {
    await runInspect([
      'events',
      '--runId',
      VALID_RUN,
      '--stepId',
      'step_01K4BZQ5T2J8HXFM6WD3PNAVCE',
    ]);

    expect(state.listEvents.mock.calls[0][1]).toMatchObject({
      stepId: 'step_01K4BZQ5T2J8HXFM6WD3PNAVCE',
    });
  });

  // The warning `listAttributes` prints for this flag was unreachable from
  // the CLI while the projection dropped it.
  it('forwards --hookId far enough for the attributes listing to warn', async () => {
    await runInspect(['attributes', '--hookId', VALID_HOOK]);

    expect(state.listAttributes.mock.calls[0][1]).toMatchObject({
      hookId: VALID_HOOK,
    });
  });
});

/**
 * The projection itself, pinned key by key. Every filtering flag the listings
 * read has to appear here; `--hookId` was declared as a flag and read by
 * `listEvents` but never copied across.
 */
describe('toInspectOptions', () => {
  it('copies every filtering flag through', () => {
    const options = toInspectOptions(
      {
        json: true,
        runId: VALID_RUN,
        stepId: 'step_x',
        hookId: 'hook_x',
        cursor: 'c',
        sort: 'asc',
        limit: 25,
        workflowName: 'orderWorkflow',
        status: 'failed',
        since: '7d',
        until: '1h',
        withData: true,
        decrypt: true,
        backend: 'vercel',
        interactive: true,
      },
      { tenant: 'acme' }
    );

    expect(options).toEqual({
      json: true,
      runId: VALID_RUN,
      stepId: 'step_x',
      hookId: 'hook_x',
      cursor: 'c',
      sort: 'asc',
      limit: 25,
      workflowName: 'orderWorkflow',
      attributes: { tenant: 'acme' },
      status: 'failed',
      since: '7d',
      until: '1h',
      withData: true,
      decrypt: true,
      backend: 'vercel',
      interactive: true,
    });
  });
});
