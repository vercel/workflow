import { ThrottleError, WorkflowWorldError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { setAttributes } from '../../set-attributes.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  creationsOf,
  dataOf,
  eventsOf,
  orchestratorMessagesOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import {
  getMaxInlineSteps,
  MAX_BATCH_EVENTS,
  MAX_IN_BAND_CREATION_BATCH_EVENTS,
} from '../constants.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const calls: Record<string, number> = {};
const count = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};
let failuresLeft = 0;
let bodyEntered = withResolvers<void>();
let bodyGate = withResolvers<void>();

/** Called at the start of every `iw_a` body. */
let onStepA: (() => void) | undefined;
registerStepFunction('iw_a', async () => {
  count('iw_a');
  onStepA?.();
  return 1;
});
registerStepFunction('iw_slow', async () => {
  count('iw_slow');
  await new Promise((resolve) => setTimeout(resolve, 150));
  return 2;
});
registerStepFunction('iw_b', async () => {
  count('iw_b');
  return 2;
});
registerStepFunction('iw_flaky', async () => {
  count('iw_flaky');
  if (failuresLeft > 0) {
    failuresLeft--;
    throw new Error('transient');
  }
  return 3;
});
registerStepFunction('iw_gated', async () => {
  count('iw_gated');
  bodyEntered.resolve();
  await bodyGate.promise;
  return 'step';
});

/** The argument of every `iw_race` body, in the order they ran. */
const raceRuns: number[] = [];
registerStepFunction('iw_race', async (i: number) => {
  raceRuns.push(i);
  return i;
});

registerStepFunction('iw_attributes', async (n: number) => {
  count('iw_attributes');
  await setAttributes({ phase: 'step-started' });
  await setAttributes({ phase: 'step-done' });
  return n * 4;
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

const oneStepWorkflow = `const a = ${step('iw_a')};
  async function workflow() { return await a(); }${registerWorkflow()}`;

const threeStepWorkflow = `const a = ${step('iw_a')}; const b = ${step('iw_b')};
  const flaky = ${step('iw_flaky')};
  async function workflow() {
    const [x, y, z] = await Promise.all([a(), b(), flaky()]);
    return x + y + z;
  }${registerWorkflow()}`;

// More steps at once than one batch may carry, as a fan-out does.
const FAN_OUT = MAX_IN_BAND_CREATION_BATCH_EVENTS + MAX_BATCH_EVENTS;
const fanOutWorkflow = `const a = ${step('iw_a')};
  async function workflow(n) {
    const results = await Promise.all(Array.from({ length: n }, () => a()));
    return results.reduce((sum, x) => sum + x, 0);
  }${registerWorkflow()}`;

const raceWorkflow = `const r = ${step('iw_race')};
  async function workflow(n) {
    return await Promise.race(Array.from({ length: n }, (_, i) => r(i)));
  }${registerWorkflow()}`;

/** A fan-out three creation batches wide: two full ones and a short one. */
const THREE_BATCH_FAN_OUT =
  2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + MAX_BATCH_EVENTS;

/** The step ids of every step message sent so far. */
const stepMessageIds = (world: AppendOnlyWorld) =>
  stepMessagesOf(world).map(
    (call) => (call.message as { stepId: string }).stepId
  );

/**
 * How many of a fan-out's inline steps ride its first creation batch: on the
 * node engine their creation-bearing starts do; the QuickJS engine writes
 * them after the pass's creation batches, one at a time.
 */
const inlineInFirstBatch = (engine: 'node' | 'quickjs') =>
  engine === 'node' ? getMaxInlineSteps() : 0;

/** The background steps the second creation batch of a fan-out created. */
const secondBatchSteps = (world: AppendOnlyWorld, engine: 'node' | 'quickjs') =>
  eventsOf(world, 'step_created')
    .slice(
      MAX_IN_BAND_CREATION_BATCH_EVENTS - inlineInFirstBatch(engine),
      2 * MAX_IN_BAND_CREATION_BATCH_EVENTS - inlineInFirstBatch(engine)
    )
    .map((event) => event.correlationId!);

/**
 * Waits up to `ms` for every step of the second creation batch to have its
 * message, and returns whether they all did.
 */
async function secondBatchSent(
  world: AppendOnlyWorld,
  engine: 'node' | 'quickjs',
  ms = 1000
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (true) {
    const sent = new Set(stepMessageIds(world));
    const second = secondBatchSteps(world, engine);
    if (second.length > 0 && second.every((id) => sent.has(id))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const attributesStepWorkflow = `const s = ${step('iw_attributes')};
  async function workflow(n) { return await s(n); }${registerWorkflow()}`;

// A hook payload races an inline step body; whichever the log holds first
// wins.
const hookRaceWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const gated = ${step('iw_gated')};
  async function workflow() {
    const hook = createHook({ token: "iw-race-hook" });
    return await Promise.race([hook.then(() => "hook"), gated()]);
  }${registerWorkflow()}`;

/**
 * Refuses the first `step_started` of each listed step with a 429, as a
 * loaded World does. The refusal allocates nothing.
 */
function throttleFirstStart(
  world: AppendOnlyWorld,
  code: string,
  retryAfterByStep: Record<string, number>
) {
  const asWorld = world.asWorld();
  const create = asWorld.events.create.bind(asWorld.events);
  const throttled = new Set<string>();
  asWorld.events.create = (async (...args: Parameters<typeof create>) => {
    const data = args[1] as {
      eventType: string;
      eventData?: { stepName?: string };
    };
    const stepName = data.eventData?.stepName;
    if (
      data.eventType === 'step_started' &&
      stepName !== undefined &&
      retryAfterByStep[stepName] !== undefined &&
      !throttled.has(stepName)
    ) {
      throttled.add(stepName);
      throw new ThrottleError('throttled', {
        retryAfter: retryAfterByStep[stepName],
      });
    }
    return create(...args);
  }) as typeof create;
  setWorld(asWorld);
  return workflowEntrypoint(code)(new Request('https://example.test'));
}

/** The delay the first orchestrator delivery deferred the run by. */
function deferral(world: AppendOnlyWorld): number | undefined {
  const result = world.deliveries[0]?.result as
    | { timeoutSeconds?: number }
    | undefined;
  if (result?.timeoutSeconds !== undefined) return result.timeoutSeconds;
  const delays = orchestratorMessagesOf(world)
    .map((call) => call.opts?.delaySeconds as number | undefined)
    .filter((d): d is number => d !== undefined);
  return delays.length > 0 ? Math.max(...delays) : undefined;
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  failuresLeft = 0;
  raceRuns.length = 0;
  bodyEntered = withResolvers<void>();
  bodyGate = withResolvers<void>();
});

afterEach(() => {
  bodyGate.resolve();
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('inline step writes (%s engine)', (engine) => {
  // The deferred replay finds the step's `step_created` (inline, never
  // started) and runs the step inline.
  // A World without batch writes: the executor writes the start, and its
  // throttle carries the World's backoff.
  it('defers the run instead of queueing a throttled inline step, and runs it inline afterwards', async () => {
    // Run-ahead starts a body before its separate start write commits, so a
    // refused start would no longer keep the body from running.
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    const { world, start } = await setupOrchestratorRun(
      oneStepWorkflow,
      [],
      { noBatch: true },
      engine
    );
    await throttleFirstStart(world, oneStepWorkflow, { iw_a: 5 });

    await world.deliver(start);
    // The start was refused: no body, no step message, and the run comes
    // back after the backoff.
    expect(calls.iw_a).toBeUndefined();
    expect(stepMessagesOf(world)).toEqual([]);
    expect(deferral(world)).toBe(5);

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1);
    expect(calls.iw_a).toBe(1);
    // The refused creation-bearing start left the step uncreated; the
    // deferred delivery created it by its start alone.
    expect(eventsOf(world, 'step_created')).toEqual([]);
    expect(creationsOf(world)).toHaveLength(1);
    expect(
      eventsOf(world, 'step_started').map((e) => dataOf(e)?.attempt)
    ).toEqual([1]);
    expect(stepMessagesOf(world)).toEqual([]);
  });

  // Every settled sibling is acted on before the deferral: the longest
  // backoff (9s) wins, and the failed sibling's retry message goes out now.
  it('defers by the longest backoff and queues a sibling retry in the same delivery', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    failuresLeft = 1;
    const { world, start } = await setupOrchestratorRun(
      threeStepWorkflow,
      [],
      { noBatch: true },
      engine
    );
    await throttleFirstStart(world, threeStepWorkflow, { iw_a: 3, iw_b: 9 });

    await world.deliver(start);
    expect(calls.iw_a).toBeUndefined();
    expect(calls.iw_b).toBeUndefined();
    expect(calls.iw_flaky).toBe(1);
    // The failed step exists and started, so its retry gets its own message.
    expect(
      stepMessagesOf(world).map(
        (call) => (call.message as { stepName?: string }).stepName
      )
    ).toEqual(['iw_flaky']);
    expect(deferral(world)).toBe(9);
  });

  it('finishes a run whose inline steps were throttled beside a retrying sibling', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '3');
    failuresLeft = 1;
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const { world } = await setupOrchestratorRun(
        threeStepWorkflow,
        [],
        {
          advanceClock: (seconds) => {
            offsetMs += seconds * 1000;
          },
        },
        engine
      );
      await throttleFirstStart(world, threeStepWorkflow, {
        iw_a: 3,
        iw_b: 9,
      });
      await world.runUntilIdle(30);

      expect(await runResult(world)).toBe(6);
      expect(calls).toEqual({ iw_a: 1, iw_b: 1, iw_flaky: 2 });
      // The retry ran in the background, on one message.
      expect(
        new Set(stepMessagesOf(world).map((c) => c.opts?.idempotencyKey)).size
      ).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A redelivery finds the inline step created and started with no outcome,
  // and runs it inline again as a redelivery attempt.
  it('runs an inline step again when the delivery that started it died before the outcome', async () => {
    const { world, start } = await setupOrchestratorRun(
      oneStepWorkflow,
      [],
      {},
      engine
    );
    // The first delivery dies inside the body: its outcome write never
    // happens, and the queue redelivers the same message.
    const asWorld = world.asWorld();
    const create = asWorld.events.create.bind(asWorld.events);
    let died = false;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      if (!died && args[1].eventType === 'step_completed') {
        died = true;
        throw new Error('invocation died');
      }
      return create(...args);
    }) as typeof create;
    setWorld(asWorld);
    await workflowEntrypoint(oneStepWorkflow)(
      new Request('https://example.test')
    );
    await world.deliver(start).catch(() => {});
    expect(eventsOf(world, 'step_started')).toHaveLength(1);
    expect(eventsOf(world, 'step_completed')).toHaveLength(0);
    if (!world.held.some((h) => h.messageId === start.messageId)) {
      world.held.push({ ...start, deliveryCount: 2 });
    }

    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1);
    expect(calls.iw_a).toBe(2);
    // A redelivery attempt: two starts with no step_retrying between.
    expect(
      eventsOf(world, 'step_started').map((e) => dataOf(e)?.attempt)
    ).toEqual([1, 2]);
    expect(eventsOf(world, 'step_retrying')).toHaveLength(0);
    expect(stepMessagesOf(world)).toEqual([]);
  });

  it('feeds an out-of-band event that landed below an inline outcome before the outcome', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      hookRaceWorkflow,
      [],
      {},
      engine
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    const delivery = world.deliver(start);
    await bodyEntered.promise;
    // The hook payload commits while the body runs, so it sits below the
    // step's outcome in the log.
    const hookCreated = eventsOf(world, 'hook_created')[0]!;
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hookCreated.correlationId,
      eventData: {
        token: dataOf(hookCreated)?.token,
        payload: await dehydrateStepReturnValue('payload', runId, undefined),
      },
    } as Partial<Event>);
    bodyGate.resolve();
    await delivery;
    await world.runUntilIdle();

    // The step outcome's write named the delivery's position, and its
    // skipped-slot report carried the hook payload, which the workflow
    // consumed first, as every later replay does.
    const outcome = world.creates.find(
      (c) => c.event.eventType === 'step_completed'
    );
    expect(outcome?.params).toMatchObject({
      inBand: true,
      eventCount: expect.any(Number),
    });
    expect(await runResult(world)).toBe('hook');
    expect(calls.iw_gated).toBe(1);
  });

  // The live feed delivers the batch's own events, and the body's
  // out-of-band `attr_set`s after them, before the batch's response. A World
  // that reports no allocated count leaves the writer to infer it, and the
  // slots the feed showed it in the meantime are no evidence of a replay.
  it('keeps the fence count when the feed shows a batch and later events before its response', async () => {
    const { world } = await setupOrchestratorRun(
      attributesStepWorkflow,
      [9],
      { subscribe: true, createDelayMs: 20 },
      engine
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(36);
    expect(world.deliveries).toHaveLength(1);
    expect(calls.iw_attributes).toBe(1);
    expect(eventsOf(world, 'step_started')).toHaveLength(1);
    expect(eventsOf(world, 'attr_set')).toHaveLength(2);
  });

  // A full load reads the run's in-band count while a sibling's outcome
  // write is in flight: the count the writer adopts must not take that
  // write again when its response arrives.
  it('keeps the fence count across a full load that overlaps an inline outcome write', async () => {
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', '0');
    let world: AppendOnlyWorld | undefined;
    const setup = await setupOrchestratorRun(
      `const a = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("iw_a");
       const slow = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("iw_slow");
       async function workflow() {
         const [x, y] = await Promise.all([a(), slow()]);
         return x + y;
       }${registerWorkflow()}`,
      [],
      {
        reportIncomplete: true,
        createDelayMs: 100,
        async beforeList() {
          // A remote read: every load after the first takes a while.
          if ((world?.listCalls.length ?? 0) > 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      },
      engine
    );
    world = setup.world;
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(3);
    // The run's only orchestrator is never refused by its own fence.
    expect(world.deliveries).toHaveLength(1);
    expect(calls.iw_a).toBe(1);
    expect(calls.iw_slow).toBe(1);
  });

  // A World refuses an oversized batch whole, so a fan-out wider than one
  // batch commits its creations in several.
  it('commits a fan-out wider than one batch in batches the World takes', async () => {
    const { world } = await setupOrchestratorRun(
      fanOutWorkflow,
      [FAN_OUT],
      {},
      engine
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    // Steps past the inline limit run from their own messages.
    await world.runUntilIdle(4 * FAN_OUT);

    expect(await runResult(world)).toBe(FAN_OUT);
    expect(creationsOf(world)).toHaveLength(FAN_OUT);
    expect(eventsOf(world, 'step_created')).toHaveLength(
      FAN_OUT - getMaxInlineSteps()
    );
    expect(
      Math.max(...world.batches.map((batch) => batch.length))
    ).toBeLessThanOrEqual(MAX_IN_BAND_CREATION_BATCH_EVENTS);
  });

  // An in-band writer sends its batches one at a time, each a round trip the
  // next waits on, so every creation batch of a fan-out adds a round trip to
  // its last branch's start. A latency budget: a 64-wide fan-out (the
  // durabench fan-out shape) commits its inline steps' starts and all its
  // background creations in one batch. The QuickJS engine batches only the
  // background creations; it writes the inline starts after them, one at a
  // time (see `spec9/round-trips.runtime.test.ts`).
  it.skipIf(engine !== 'node')(
    'commits a 64-wide fan-out in one creation round trip',
    async () => {
      const width = MAX_IN_BAND_CREATION_BATCH_EVENTS;
      const { world } = await setupOrchestratorRun(
        fanOutWorkflow,
        [width],
        {},
        engine
      );
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
      await world.runUntilIdle(4 * width);

      expect(await runResult(world)).toBe(width);
      const background = width - getMaxInlineSteps();
      expect(eventsOf(world, 'step_created')).toHaveLength(background);
      const creationBatches = world.batches.filter(
        (batch) =>
          batch.includes('step_created') || batch.includes('step_started')
      );
      // The inline steps' creation-bearing starts go first, in the batch
      // that also carries every background creation.
      expect(creationBatches[0]).toEqual([
        ...Array.from({ length: getMaxInlineSteps() }, () => 'step_started'),
        ...Array.from({ length: background }, () => 'step_created'),
      ]);
      expect(
        creationBatches.filter((batch) => batch.includes('step_created'))
      ).toHaveLength(1);
    }
  );

  // The inline bodies start once the first creation batch committed and
  // finish while the later batches are still going out. Their outcomes are
  // single writes on the same serialized writer: queued between two creation
  // batches, each would hold up every background creation behind it.
  it.skipIf(engine !== 'node')(
    'queues inline outcomes behind every creation batch of a fan-out',
    async () => {
      const width = 2 * MAX_IN_BAND_CREATION_BATCH_EVENTS + MAX_BATCH_EVENTS;
      // The first delivery's writes in send order: `batch` per creation
      // batch, the event type per single write.
      const writes: string[] = [];
      let seenBatches = 0;
      let current: AppendOnlyWorld | undefined;
      const { world } = await setupOrchestratorRun(
        fanOutWorkflow,
        [width],
        {
          async beforeCreate(data, _params, source) {
            if (!source?.batch) {
              writes.push(data.eventType);
              return;
            }
            const batches = current?.batches.length ?? 0;
            if (batches === seenBatches) return;
            seenBatches = batches;
            writes.push('batch');
            // A slow batch round trip, so the inline bodies finish while
            // a later creation batch is in flight.
            await new Promise((resolve) => setTimeout(resolve, 50));
          },
        },
        engine
      );
      current = world;
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
      await world.deliver(world.held[0]!);
      const firstDelivery = [...writes];
      await world.runUntilIdle(4 * width);

      expect(await runResult(world)).toBe(width);
      const creationBatches = Math.ceil(
        width / MAX_IN_BAND_CREATION_BATCH_EVENTS
      );
      const lastBatch = firstDelivery.lastIndexOf('batch');
      expect(firstDelivery.filter((w) => w === 'batch')).toHaveLength(
        creationBatches
      );
      // Every inline outcome went out after the last creation batch.
      const outcomes = firstDelivery.flatMap((w, index) =>
        w === 'step_completed' ? [index] : []
      );
      expect(outcomes).toHaveLength(getMaxInlineSteps());
      expect(Math.min(...outcomes)).toBeGreaterThan(lastBatch);
    }
  );

  // The inline steps ride the first creation batch, so their bodies start
  // once it commits instead of after every batch of the fan-out.
  it.skipIf(engine !== 'node')(
    'starts a wide fan-out once its first creation batch committed',
    async () => {
      const bodyStarted = withResolvers<void>();
      onStepA = () => bodyStarted.resolve();
      let heldBatches = 0;
      let releasedByBody = 0;
      let timedOut = false;
      let current: AppendOnlyWorld | undefined;
      try {
        const { world } = await setupOrchestratorRun(
          fanOutWorkflow,
          [FAN_OUT],
          {
            // Holds every later creation batch until a body started, or
            // for 2s if none does.
            async beforeCreate(data, _params, source) {
              if (
                timedOut ||
                !source?.batch ||
                data.eventType !== 'step_created' ||
                (current?.batches.length ?? 0) < 2
              ) {
                return;
              }
              heldBatches++;
              const byBody = await Promise.race([
                bodyStarted.promise.then(() => true),
                new Promise<boolean>((resolve) =>
                  setTimeout(() => resolve(false), 2000)
                ),
              ]);
              if (byBody) releasedByBody++;
              else timedOut = true;
            },
          },
          engine
        );
        current = world;
        vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
        await world.runUntilIdle(4 * FAN_OUT);

        expect(await runResult(world)).toBe(FAN_OUT);
        expect(creationsOf(world)).toHaveLength(FAN_OUT);
      } finally {
        onStepA = undefined;
      }
      expect(heldBatches).toBeGreaterThan(0);
      expect(releasedByBody).toBe(heldBatches);
    }
  );

  // A later creation batch the World refuses fails the delivery even though
  // the inline steps already ran; its redelivery creates what is missing,
  // and no step is created or run twice.
  it('redelivers a wide fan-out whose later creation batch was refused', async () => {
    let batchedCreations = 0;
    let refused = false;
    const { world } = await setupOrchestratorRun(
      fanOutWorkflow,
      [FAN_OUT],
      {
        beforeCreate(data, _params, source) {
          if (
            !refused &&
            source?.batch &&
            data.eventType === 'step_created' &&
            // The first creation of the second batch: the first carries
            // the node engine's inline starts and fills up with
            // background creations.
            ++batchedCreations ===
              MAX_IN_BAND_CREATION_BATCH_EVENTS - inlineInFirstBatch(engine) + 1
          ) {
            refused = true;
            throw new WorkflowWorldError('unavailable', { status: 503 });
          }
        },
      },
      engine
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    await world.deliver(world.held[0]!).catch(() => {});
    await world.runUntilIdle(4 * FAN_OUT);

    expect(refused).toBe(true);
    expect(await runResult(world)).toBe(FAN_OUT);
    const created = creationsOf(world).map((e) => e.correlationId);
    expect(new Set(created).size).toBe(FAN_OUT);
    expect(created).toHaveLength(FAN_OUT);
    // A failed write stops the delivery's later writes, the inline steps'
    // outcomes included, so those bodies may run again on the redelivery
    // (a step that allows retries tolerates that). No other step does.
    expect(calls.iw_a).toBeGreaterThanOrEqual(FAN_OUT);
    expect(calls.iw_a).toBeLessThanOrEqual(FAN_OUT + getMaxInlineSteps());
  });

  // An in-band writer commits a fan-out's creation batches one at a time.
  // Each later batch's background steps go out as soon as that batch
  // committed, not once every batch behind it did.
  it("enqueues a later creation batch's steps before the batch behind it commits", async () => {
    let current: AppendOnlyWorld | undefined;
    let sentBeforeThirdBatch: boolean | undefined;
    const { world } = await setupOrchestratorRun(
      fanOutWorkflow,
      [THREE_BATCH_FAN_OUT],
      {
        // Holds the third creation batch until the second batch's steps
        // have their messages, or for 1s.
        async beforeCreate(_data, _params, source) {
          if (
            !source?.batch ||
            sentBeforeThirdBatch !== undefined ||
            (current?.batches.length ?? 0) < 3
          ) {
            return;
          }
          sentBeforeThirdBatch = false;
          sentBeforeThirdBatch = await secondBatchSent(current!, engine);
        },
      },
      engine
    );
    current = world;
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    await world.runUntilIdle(4 * THREE_BATCH_FAN_OUT);

    expect(await runResult(world)).toBe(THREE_BATCH_FAN_OUT);
    expect(sentBeforeThirdBatch).toBe(true);
    // Each background step's message went out once.
    const sent = stepMessageIds(world);
    expect(sent).toHaveLength(THREE_BATCH_FAN_OUT - getMaxInlineSteps());
    expect(new Set(sent).size).toBe(sent.length);
  });

  // A creation batch the World refuses after the batch before it committed
  // and sent its steps: no step is sent before its creation committed, the
  // steps sent are sent once, and the redelivery finishes the run.
  it('redelivers a fan-out whose third creation batch failed after the second was sent', async () => {
    let current: AppendOnlyWorld | undefined;
    let refused = false;
    let sentBeforeRefusal = false;
    const { world, start } = await setupOrchestratorRun(
      fanOutWorkflow,
      [THREE_BATCH_FAN_OUT],
      {
        async beforeCreate(_data, _params, source) {
          if (refused || !source?.batch || (current?.batches.length ?? 0) < 3) {
            return;
          }
          refused = true;
          sentBeforeRefusal = await secondBatchSent(current!, engine);
          throw new WorkflowWorldError('unavailable', { status: 503 });
        },
      },
      engine
    );
    current = world;
    // Every step message names a step whose creation is in the log.
    const uncreated: string[] = [];
    const asWorld = world.asWorld();
    const queue = asWorld.queue.bind(asWorld);
    asWorld.queue = (async (...args: Parameters<typeof queue>) => {
      const stepId = (args[1] as { stepId?: string }).stepId;
      if (
        stepId !== undefined &&
        !creationsOf(world).some((event) => event.correlationId === stepId)
      ) {
        uncreated.push(stepId);
      }
      return queue(...args);
    }) as typeof queue;
    setWorld(asWorld);
    await workflowEntrypoint(fanOutWorkflow)(
      new Request('https://example.test')
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');

    await expect(world.deliver(start)).rejects.toThrow();
    expect(refused).toBe(true);
    expect(sentBeforeRefusal).toBe(true);
    const sentByFirst = stepMessageIds(world);
    expect(new Set(sentByFirst).size).toBe(sentByFirst.length);
    expect(sentByFirst).toHaveLength(
      2 * MAX_IN_BAND_CREATION_BATCH_EVENTS - inlineInFirstBatch(engine)
    );

    await world.runUntilIdle(4 * THREE_BATCH_FAN_OUT);
    expect(await runResult(world)).toBe(THREE_BATCH_FAN_OUT);
    expect(uncreated).toEqual([]);
    const created = creationsOf(world).map((event) => event.correlationId);
    expect(created).toHaveLength(THREE_BATCH_FAN_OUT);
    expect(new Set(created).size).toBe(THREE_BATCH_FAN_OUT);
    // The redelivery sent none of the steps the first delivery sent
    // again, and each background step ran from one delivered message.
    const sentByRedelivery = stepMessageIds(world).slice(sentByFirst.length);
    expect(sentByRedelivery.filter((id) => sentByFirst.includes(id))).toEqual(
      []
    );
    const ran = world.deliveries.flatMap((delivery) => {
      const stepId = (delivery.message as { stepId?: string }).stepId;
      return stepId === undefined ? [] : [stepId];
    });
    expect(ran).toHaveLength(THREE_BATCH_FAN_OUT - getMaxInlineSteps());
    expect(new Set(ran).size).toBe(ran.length);
    expect(calls.iw_a).toBeGreaterThanOrEqual(THREE_BATCH_FAN_OUT);
    expect(calls.iw_a).toBeLessThanOrEqual(
      THREE_BATCH_FAN_OUT + getMaxInlineSteps()
    );
  });

  // One item of a later creation batch is refused with a 5xx while the rest
  // of that batch commits (a spec 9 batch is not atomic). The delivery fails,
  // the refused step gets no message from it, and the redelivery creates it.
  it('redelivers a fan-out whose creation batch had one item refused', async () => {
    let refusedStep: string | undefined;
    const { world, start } = await setupOrchestratorRun(
      fanOutWorkflow,
      [THREE_BATCH_FAN_OUT],
      {},
      engine
    );
    const asWorld = world.asWorld();
    const createBatch = asWorld.events.createBatch!.bind(asWorld.events);
    asWorld.events.createBatch = (async (
      ...args: Parameters<typeof createBatch>
    ) => {
      const result = await createBatch(...args);
      if (refusedStep !== undefined || world.batches.length < 2) return result;
      const index = result.results.length - 1;
      const item = result.results[index];
      if (
        item?.error !== undefined ||
        item?.event.eventType !== 'step_created'
      ) {
        return result;
      }
      // Answered as refused; the log keeps the event's position as a hole.
      refusedStep = item.event.correlationId!;
      const at = world.events.indexOf(
        world.events.find((event) => event.eventId === item.event.eventId)!
      );
      world.events[at] = { ...world.events[at]!, eventType: 'noop' } as Event;
      return {
        ...result,
        results: result.results.map((r, i) =>
          i === index
            ? { status: 503, error: 'unavailable', message: 'unavailable' }
            : r
        ),
      };
    }) as typeof createBatch;
    const sentWithoutCreation: string[] = [];
    const queue = asWorld.queue.bind(asWorld);
    asWorld.queue = (async (...args: Parameters<typeof queue>) => {
      const stepId = (args[1] as { stepId?: string }).stepId;
      if (
        stepId !== undefined &&
        !creationsOf(world).some((event) => event.correlationId === stepId)
      ) {
        sentWithoutCreation.push(stepId);
      }
      return queue(...args);
    }) as typeof queue;
    setWorld(asWorld);
    await workflowEntrypoint(fanOutWorkflow)(
      new Request('https://example.test')
    );
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');

    await expect(world.deliver(start)).rejects.toThrow(/503/);
    expect(refusedStep).toBeDefined();
    // The second batch's other steps went out; the refused one did not, and
    // the third batch was never sent.
    expect(stepMessageIds(world)).not.toContain(refusedStep);
    expect(world.batches).toHaveLength(2);

    await world.runUntilIdle(4 * THREE_BATCH_FAN_OUT);
    expect(await runResult(world)).toBe(THREE_BATCH_FAN_OUT);
    expect(sentWithoutCreation).toEqual([]);
    const created = creationsOf(world).map((event) => event.correlationId);
    expect(new Set(created).size).toBe(THREE_BATCH_FAN_OUT);
    expect(created).toHaveLength(THREE_BATCH_FAN_OUT);
    const ran = world.deliveries.flatMap((delivery) => {
      const stepId = (delivery.message as { stepId?: string }).stepId;
      return stepId === undefined ? [] : [stepId];
    });
    expect(new Set(ran).size).toBe(ran.length);
  });

  // A branch of the second creation batch finishes while the third batch
  // is still committing, so its outcome lands in the log ahead of the third
  // batch's creations and ahead of the inline steps' outcomes. It wins the
  // race, and every replay after agrees.
  it('completes a race over a wide fan-out won by a branch that finished before the last creation batch committed', async () => {
    let current: AppendOnlyWorld | undefined;
    let winner: number | undefined;
    const { world } = await setupOrchestratorRun(
      raceWorkflow,
      [THREE_BATCH_FAN_OUT],
      {
        // Holds the third creation batch while a step of the second
        // batch runs out of band, start to outcome.
        async beforeCreate(_data, _params, source) {
          if (
            winner !== undefined ||
            !source?.batch ||
            (current?.batches.length ?? 0) < 3
          ) {
            return;
          }
          winner = -1;
          if (!(await secondBatchSent(current!, engine))) return;
          const stepId = secondBatchSteps(current!, engine)[0];
          const held = current!.held.find(
            (message) =>
              (message.message as { stepId?: string }).stepId === stepId
          );
          if (!held) return;
          await current!.deliver(held);
          winner = raceRuns.at(-1);
        },
      },
      engine
    );
    current = world;
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    await world.runUntilIdle(4 * THREE_BATCH_FAN_OUT);

    expect(winner).toBeGreaterThanOrEqual(getMaxInlineSteps());
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe(winner);
    // The winner's outcome precedes the third batch's creations.
    const completedAt = world.events.findIndex(
      (event) => event.eventType === 'step_completed'
    );
    const lastCreatedAt = world.events.findLastIndex(
      (event) => event.eventType === 'step_created'
    );
    expect(completedAt).toBeLessThan(lastCreatedAt);
    const created = creationsOf(world).map((event) => event.correlationId);
    expect(new Set(created).size).toBe(THREE_BATCH_FAN_OUT);
  });
});

// Known gap, see `stepMessageRetentionSeconds`: a retry message can outlive
// its queue's dedupe window.
it.todo(
  "runs an inline step's background retry once when its retryAfter outlives the queue's dedupe window"
);
