import type { Event, ListEventsParams } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../../serialization.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { ORCHESTRATOR_READ_ATTEMPTS } from './read-deadline.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// The orchestrator is a run's only reader of its log, so one incremental read
// that a remote World never answers (held in transit) would hold the whole
// run, with its events already committed. The read runs under a deadline
// (spec9/read-deadline.ts) and is sent again; a retry is answered.

const TOKEN = 'held-read-hook';
const loopWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const seen = [];
    for await (const payload of hook) {
      seen.push(payload);
      if (seen.length === 2) break;
    }
    return seen;
  }${registerWorkflow()}`;

const READ_TIMEOUT_MS = 100;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An incremental read: one from a position, as a pass's reads are. */
const isIncremental = (params: ListEventsParams) =>
  params.pagination?.cursor !== undefined &&
  params.pagination.sortOrder !== 'desc';

describe.each([
  'node',
  'quickjs',
] as const)('a held event log read (%s engine)', (engine) => {
  async function start(beforeList: (params: ListEventsParams) => unknown) {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '10000');
    vi.stubEnv(
      'WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS',
      String(READ_TIMEOUT_MS)
    );
    return setupOrchestratorRun(
      loopWorkflow,
      [],
      {
        subscribe: true,
        beforeList: beforeList as (params: ListEventsParams) => void,
      },
      engine
    );
  }

  async function resume(
    world: Awaited<ReturnType<typeof start>>['world'],
    runId: string,
    payload: number
  ) {
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue(payload, runId, undefined),
      },
    } as unknown as Partial<Event>);
  }

  it('sends a read the World never answers again, and finishes the run in the same delivery', async () => {
    const held: ListEventsParams[] = [];
    const {
      world,
      runId,
      start: message,
    } = await start((params) => {
      // The first incremental read is never answered, and its signal is
      // ignored: a World that cannot cancel is the harder case.
      if (isIncremental(params) && held.length === 0) {
        held.push(params);
        return new Promise(() => {});
      }
    });
    const delivery = world.deliver(message);
    await vi.waitFor(
      () => expect(eventsOf(world, 'hook_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    for (const payload of [1, 2]) {
      await resume(world, runId, payload);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await delivery;

    expect(await runResult(world)).toEqual([1, 2]);
    expect(world.deliveries).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(held[0]?.signal?.aborted).toBe(true);
    // The retry asked for the position the held read asked for.
    const incremental = world.listCalls.filter((params) =>
      isIncremental(params as unknown as ListEventsParams)
    );
    expect(incremental[1]?.pagination).toEqual(held[0]?.pagination);
  });

  it('hands a read that is never answered to the queue once its attempts run out', async () => {
    let holding = true;
    let heldReads = 0;
    const {
      world,
      runId,
      start: message,
    } = await start((params) => {
      if (holding && isIncremental(params)) {
        heldReads++;
        return new Promise(() => {});
      }
    });
    const delivery = world.deliver(message).then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.waitFor(
      () => expect(eventsOf(world, 'hook_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    const failure = await delivery;

    expect(failure).toMatchObject({ code: 'TIMEOUT' });
    expect(heldReads).toBe(ORCHESTRATOR_READ_ATTEMPTS);
    // Redelivered, not failed: the run is still live.
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(world.held).toHaveLength(1);

    holding = false;
    for (const payload of [1, 2]) await resume(world, runId, payload);
    const redelivery = world.held[0];
    if (!redelivery) throw new Error('no redelivery');
    await world.deliver(redelivery);
    expect(await runResult(world)).toEqual([1, 2]);
  });
});
