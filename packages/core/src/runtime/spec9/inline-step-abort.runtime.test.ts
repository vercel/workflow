import { withResolvers } from '@workflow/utils';
import { type Event, RETENTION_ATTRIBUTE } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

/** How long the step waits for its signal before giving up on it. */
const SIGNAL_WAIT_MS = 3_000;

let bodyEntered = withResolvers<void>();
/** What the losing step saw of its signal. */
let observed: { aborted: boolean; reason: unknown } | undefined;

registerStepFunction('ia_watch', async (signal: AbortSignal) => {
  bodyEntered.resolve();
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, SIGNAL_WAIT_MS);
  });
  observed = { aborted: signal.aborted, reason: signal.reason };
  return 'step';
});

// A hook wins a race against an inline step that watches a signal; the
// workflow aborts the loser and returns.
const abortLoserWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const watch = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("ia_watch");
  async function workflow() {
    const controller = new AbortController();
    const hook = createHook({ token: "ia-race-hook" });
    const winner = await Promise.race([
      hook.then(() => "hook"),
      watch(controller.signal),
    ]);
    controller.abort("lost the race");
    return winner;
  }${registerWorkflow()}`;

beforeEach(() => {
  bodyEntered = withResolvers<void>();
  observed = undefined;
});

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('an inline race loser on a zero-retention run (%s engine)', (engine) => {
  it('is aborted by the workflow even though its abort stream is cleared before it is read', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '1');
    // A World whose abort-stream reader has not fetched the packet by the
    // time the run finishes, and whose zero-retention purge then clears the
    // stream: the reader sees it end with nothing in it.
    const readers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const written: string[] = [];
    const { world, runId, start } = await setupOrchestratorRun(
      abortLoserWorkflow,
      [],
      {
        beforeCreate: (data) => {
          if (data.eventType === 'run_completed') {
            for (const reader of readers.splice(0)) {
              try {
                reader.close();
              } catch {
                // Already cancelled by a reader that got its packet.
              }
            }
          }
        },
      },
      engine
    );
    const asWorld = world.asWorld();
    (asWorld as { streams: unknown }).streams = {
      async get() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            readers.push(controller);
          },
        });
      },
      async write(_runId: string, name: string) {
        written.push(name);
      },
      async close() {},
    };
    setWorld(asWorld);
    const run = await asWorld.runs.get(runId);
    run.attributes = { [RETENTION_ATTRIBUTE]: '0' };

    const startedAt = Date.now();
    const delivery = world.deliver(start);
    await bodyEntered.promise;
    const hook = eventsOf(world, 'hook_created').find(
      (event) => dataOf(event)?.token === 'ia-race-hook'
    );
    if (!hook) throw new Error('expected the racing hook to be created');
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hook.correlationId,
      eventData: {
        token: dataOf(hook)?.token,
        payload: await dehydrateStepReturnValue('payload', runId, undefined),
      },
    } as Partial<Event>);
    await delivery;
    await world.runUntilIdle();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // The abort went out on the stream as well.
    expect(written.some((name) => name.endsWith('_system_abort'))).toBe(true);
    // The step was told in-process, with the workflow's reason, rather than
    // left to run out its upstream past the run's end.
    expect(observed).toEqual({ aborted: true, reason: 'lost the race' });
    expect(Date.now() - startedAt).toBeLessThan(SIGNAL_WAIT_MS);
  });
});
