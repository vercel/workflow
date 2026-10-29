import { AsyncLocalStorage } from 'node:async_hooks';
import { InBandSupersededError, RUN_ERROR_CODES } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  creationsOf,
  dataOf,
  eventsOf,
  expectAcknowledged,
  expectRefusalRedelivery,
  ORCHESTRATOR_QUEUE,
  orchestratorMessagesOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { getMaxQueueDeliveries } from '../constants.js';
import { setWorld } from '../world.js';
import { REPEATED_FENCE_REFUSAL_WARN_THRESHOLD } from './fence-refusals.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const calls: Record<string, number> = {};
let gate = withResolvers<void>();
let entered = withResolvers<void>();

registerStepFunction('fo_s1', async () => {
  calls.fo_s1 = (calls.fo_s1 ?? 0) + 1;
  entered.resolve();
  await gate.promise;
  return 10;
});
registerStepFunction('fo_s2', async () => {
  calls.fo_s2 = (calls.fo_s2 ?? 0) + 1;
  return 20;
});
registerStepFunction('fo_a', async () => 10);
registerStepFunction('fo_b', async () => 20);
registerStepFunction('fo_bg', async () => {
  calls.fo_bg = (calls.fo_bg ?? 0) + 1;
  return 7;
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

// The first delivery parks inside s1's body; an out-of-band event lets the
// workflow take the other branch of the race and move on to s2.
const hookWakeWorkflow = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const s1 = ${step('fo_s1')}; const s2 = ${step('fo_s2')};
  async function workflow() {
    const hook = createHook({ token: "fo-overlap-hook" });
    const a = await Promise.race([hook.then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }${registerWorkflow()}`;

const waitWakeWorkflow = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const s1 = ${step('fo_s1')}; const s2 = ${step('fo_s2')};
  async function workflow() {
    const a = await Promise.race([sleep("1h").then(() => 999), s1()]);
    const b = await s2();
    return a + b;
  }${registerWorkflow()}`;

const twoStepWorkflow = `const a = ${step('fo_a')}; const b = ${step('fo_b')};
  async function workflow() { return (await a()) + (await b()); }${registerWorkflow()}`;

const backgroundStepWorkflow = `const s = ${step('fo_bg')};
  async function workflow() { return await s(); }${registerWorkflow()}`;

const isStepMessage = (message: unknown) =>
  (message as { stepId?: string }).stepId !== undefined;

/**
 * Replays `world`'s final log, minus its `run_completed`, in a fresh World
 * and a fresh orchestrator delivery: the cold replay of what the overlapping
 * deliveries left behind. Returns that replay's World.
 */
async function replayFromCold(
  world: AppendOnlyWorld,
  code: string
): Promise<AppendOnlyWorld> {
  const run = (await world.asWorld().runs.get(world.events[0]!.runId)) as
    | WorkflowRun
    | undefined;
  const cold = new AppendOnlyWorld({});
  cold.seedLog(
    { ...run!, status: 'running' },
    world.events.filter((e) => e.eventType !== 'run_completed')
  );
  setWorld(cold.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId: run!.runId }));
  return cold;
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  gate = withResolvers<void>();
  entered = withResolvers<void>();
  // No tail poll and no live feed: the parked delivery sees nothing until
  // its own next write, so the overlap is deterministic.
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  gate.resolve();
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('two overlapping orchestrator deliveries of one run (%s engine)', (engine) => {
  it.each([
    'hook',
    'wait',
  ] as const)('fences out the parked delivery when a %s wake overlaps it, and the final log replays to the same result from cold', async (wake) => {
    const code = wake === 'hook' ? hookWakeWorkflow : waitWakeWorkflow;
    const { world, runId, start } = await setupOrchestratorRun(
      code,
      [],
      {},
      engine
    );

    // Delivery A runs s1 inline and parks inside its body.
    const deliveryA = world.deliver(start);
    await entered.promise;

    // The out-of-band event that lets the workflow move past s1, with the
    // unkeyed wake its writer enqueues.
    if (wake === 'hook') {
      const hookCreated = eventsOf(world, 'hook_created')[0]!;
      world.appendOutOfBand({
        eventType: 'hook_received',
        correlationId: hookCreated.correlationId,
        eventData: {
          token: dataOf(hookCreated)?.token,
          payload: await dehydrateStepReturnValue(
            { source: 'external-hook' },
            runId,
            undefined
          ),
        },
      } as Partial<Event>);
    } else {
      const waitCreated = eventsOf(world, 'wait_created')[0]!;
      world.appendOutOfBand({
        eventType: 'wait_completed',
        correlationId: waitCreated.correlationId,
        eventData: { resumeAt: dataOf(waitCreated)?.resumeAt },
      } as Partial<Event>);
    }
    const wakeMessage = world.enqueue(ORCHESTRATOR_QUEUE, { runId });

    // Delivery B overlaps A: it loads the longer log, takes the other
    // branch, and writes in-band, which moves the fence past A's count.
    // B stays in flight while A's body runs: in one process, B's attempt
    // at the unfinished s1 joins A's execution instead of running it again.
    // (node:vm writes run_completed before that join settles, QuickJS after,
    // so the overlap is observed at s2.)
    const deliveryB = world.deliver(wakeMessage);
    await vi.waitFor(() => expect(calls.fo_s2).toBe(1), { timeout: 5000 });
    expect(calls.fo_s1).toBe(1);

    // A's body finishes; its outcome write carries a stale count.
    const orchestratorCalls = orchestratorMessagesOf(world).length;
    gate.resolve();
    const [resultA, resultB] = await Promise.all([deliveryA, deliveryB]);
    // One acknowledges, and the one that stands down asks for a redelivery
    // of its own message, with no wake. Usually A stands down: B's view
    // included every in-band write, and B finishes the run. Or A's run-ahead
    // hit the wake's event below a speculative write and still wrote s1's
    // outcome (a hazard stops decisions, not outcomes), and that write took
    // the fence first: then B stands down, and A continues in place from a
    // fresh load and finishes the run. The redelivery then finds the run
    // finished.
    const outcomes = [
      { result: resultA, message: start },
      { result: resultB, message: wakeMessage },
    ];
    const refused = outcomes.filter(({ result }) => result !== undefined);
    expect(refused).toHaveLength(1);
    for (const { result, message } of outcomes) {
      if (result === undefined) expectAcknowledged(world, result, message);
      else expectRefusalRedelivery(world, result, message, orchestratorCalls);
    }
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1019);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.fo_s2).toBe(1);
    // The run finished before A's body did, so nothing ran s1 again.
    expect(calls.fo_s1).toBe(1);
    // Each step was created once, and none has two outcomes.
    expect(new Set(creationsOf(world).map((e) => e.correlationId)).size).toBe(
      2
    );
    expect(creationsOf(world)).toHaveLength(2);
    for (const created of creationsOf(world)) {
      expect(
        world.events.filter(
          (e) =>
            e.correlationId === created.correlationId &&
            (e.eventType === 'step_completed' || e.eventType === 'step_failed')
        ).length
      ).toBeLessThanOrEqual(1);
    }
    // No step message: both steps stayed inline.
    expect(world.queueCalls.filter((c) => isStepMessage(c.message))).toEqual(
      []
    );

    // A cold replay of the final log reaches the same result, consuming
    // every event: its only write is the run's completion.
    const cold = await replayFromCold(world, code);
    expect(await runResult(cold)).toBe(1019);
    expect(cold.creates.map((c) => c.event.eventType)).toEqual([
      'run_completed',
    ]);
  });

  it('discards the retained session when a later write is fenced out, and the redelivery replays to the same result', async () => {
    const { world, start } = await setupOrchestratorRun(
      twoStepWorkflow,
      [],
      {},
      engine
    );
    // Another orchestrator of the run writes in-band right after the first
    // step's outcome, so the next in-band write of this delivery (the second
    // step, past a retained boundary) is refused.
    const asWorld = world.asWorld();
    const create = asWorld.events.create.bind(asWorld.events);
    let competed = false;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      if (!competed && args[1].eventType === 'step_completed') {
        competed = true;
        world.seqInBand++;
        world.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
      }
      return result;
    }) as typeof create;
    setWorld(asWorld);
    await workflowEntrypoint(twoStepWorkflow)(
      new Request('https://example.test')
    );

    expectRefusalRedelivery(world, await world.deliver(start), start, 0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    // The fenced-out delivery's message is redelivered and finishes the run.
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(30);
    expect(eventsOf(world, 'step_completed')).toHaveLength(2);

    const cold = await replayFromCold(world, twoStepWorkflow);
    expect(await runResult(cold)).toBe(30);
    expect(cold.creates.map((c) => c.event.eventType)).toEqual([
      'run_completed',
    ]);
  });
});

/**
 * A World that answers an in-band `step_completed` the way world-vercel does
 * when it sealed the writer's own position (its write outlived the World's
 * staleness bound), or refused a write after allocating it: the in-band
 * count moves past the writer's, the position holds a sealed `noop`, and the
 * write is refused as superseded. No other orchestrator of the run exists.
 */
function refuseOwnStepCompleted(
  world: () => AppendOnlyWorld,
  times: number
): ConstructorParameters<typeof AppendOnlyWorld>[0] {
  let refused = 0;
  return {
    beforeCreate(data) {
      if (data.eventType !== 'step_completed' || refused >= times) return;
      refused++;
      const current = world();
      current.seqInBand++;
      current.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
      throw new InBandSupersededError('in-band-superseded', {
        seq: current.seq,
        seqInBand: current.seqInBand,
      });
    },
  };
}

describe.each([
  'node',
  'quickjs',
] as const)('a write the fence refuses with no other orchestrator of the run (%s engine)', (engine) => {
  it('asks for a redelivery of its message, whose delivery completes the run (serialized queue)', async () => {
    let current: AppendOnlyWorld | undefined;
    const { world, start } = await setupOrchestratorRun(
      twoStepWorkflow,
      [],
      refuseOwnStepCompleted(() => current!, 1),
      engine
    );
    current = world;

    expectRefusalRedelivery(world, await world.deliver(start), start, 0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(30);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // No orchestrator message: the redelivery stood in.
    expect(orchestratorMessagesOf(world)).toEqual([]);
  });

  it('does not run again in place on a coalescing queue: the redelivery completes the run', async () => {
    let current: AppendOnlyWorld | undefined;
    const { world, start } = await setupOrchestratorRun(
      twoStepWorkflow,
      [],
      { coalesce: true, ...refuseOwnStepCompleted(() => current!, 1) },
      engine
    );
    current = world;

    const redelivery = expectRefusalRedelivery(
      world,
      await world.deliver(start),
      start,
      0
    );
    // Nothing was sent to be coalesced into the refused delivery.
    expect(world.coalescedMessages).toBe(0);
    await world.deliver(redelivery);
    expect(world.held).toEqual([]);
    expect(await runResult(world)).toBe(30);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
  });

  it('fails the run at the delivery cap when every pass is refused, and warns about the streak', async () => {
    let current: AppendOnlyWorld | undefined;
    const { world, start } = await setupOrchestratorRun(
      twoStepWorkflow,
      [],
      refuseOwnStepCompleted(() => current!, Number.POSITIVE_INFINITY),
      engine
    );
    current = world;

    // Long enough for the streak warning, and short of the inline step's
    // retry budget, which every refused pass spends one attempt of.
    vi.stubEnv(
      'WORKFLOW_MAX_QUEUE_DELIVERIES',
      String(REPEATED_FENCE_REFUSAL_WARN_THRESHOLD)
    );
    const warn = vi.spyOn(runtimeLogger, 'warn');
    const cap = getMaxQueueDeliveries();
    await world.runUntilIdle(cap + 2);
    // Every refused pass asked for a redelivery of the same message, each an
    // attempt, until the cap failed the run in-band.
    expect(world.deliveries).toHaveLength(cap + 1);
    expect(
      new Set(world.deliveries.map((delivery) => delivery.messageId))
    ).toEqual(new Set([start.messageId]));
    expect(eventsOf(world, 'run_failed')).toHaveLength(1);
    expect(dataOf(eventsOf(world, 'run_failed')[0]!)).toMatchObject({
      errorCode: RUN_ERROR_CODES.MAX_DELIVERIES_EXCEEDED,
    });
    expect(orchestratorMessagesOf(world)).toEqual([]);
    // The streak is reported at warn once it is long enough, with the
    // counts the refusal carried.
    const streakWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('keep being refused by the in-band fence')
    );
    expect(streakWarnings.length).toBeGreaterThan(0);
    expect(streakWarnings[0]?.[1]).toMatchObject({
      consecutiveRefusals: REPEATED_FENCE_REFUSAL_WARN_THRESHOLD,
      expectedSeqInBand: expect.any(Number),
      refusalSeqInBand: expect.any(Number),
    });
    warn.mockRestore();
  });
});

describe.each([
  'node',
  'quickjs',
] as const)('two deliveries of one message after a lease lapse (%s engine)', (engine) => {
  it('re-sends the background step the dead delivery committed and never sent, and the run completes', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    // D1 and D2 are two deliveries of the start message: D1 outlived its
    // lease. Both load the same log; D2 writes only after D1 committed the
    // step's creation, so D2 is refused.
    const delivering = new AsyncLocalStorage<'D1' | 'D2'>();
    let lists = 0;
    const bothListed = withResolvers<void>();
    const d1Committed = withResolvers<void>();
    const { world, start } = await setupOrchestratorRun(
      backgroundStepWorkflow,
      [],
      {
        beforeList: async () => {
          if (++lists === 2) bothListed.resolve();
          if (lists <= 2) await bothListed.promise;
        },
        beforeCreate: async () => {
          if (delivering.getStore() === 'D2') await d1Committed.promise;
        },
      },
      engine
    );
    // D1 dies in the step's send, after its step_created committed.
    const asWorld = world.asWorld();
    const queue = asWorld.queue.bind(asWorld);
    let d1Died = false;
    asWorld.queue = (async (...args: Parameters<typeof queue>) => {
      if (isStepMessage(args[1]) && !d1Died) {
        d1Died = true;
        d1Committed.resolve();
        return new Promise<never>(() => {});
      }
      return queue(...args);
    }) as typeof queue;
    setWorld(asWorld);
    await workflowEntrypoint(backgroundStepWorkflow)(
      new Request('https://example.test')
    );

    void delivering.run('D1', () => world.deliver(start));
    const d2 = { ...start, deliveryCount: 2 };
    const result = await delivering.run('D2', () => world.deliver(d2));
    expect(d1Died).toBe(true);
    expect(eventsOf(world, 'step_created')).toHaveLength(1);
    // D2 is refused and asks for a redelivery of the message, which is not
    // the message's first delivery: it re-sends the step D1 never sent.
    expectRefusalRedelivery(world, result, d2, 0);
    await world.runUntilIdle();
    expect(
      stepMessagesOf(world).map(
        (call) => (call.message as { stepId: string }).stepId
      )
    ).toEqual([eventsOf(world, 'step_created')[0]!.correlationId]);
    expect(calls.fo_bg).toBe(1);
    expect(await runResult(world)).toBe(7);
  });
});
