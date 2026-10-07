import { withResolvers } from '@workflow/utils';
import type { Event, WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';
import { FENCE_REDELIVERY_DELAY_SECONDS } from './in-band-writer.js';

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
    gate.resolve();
    const [resultA, resultB] = await Promise.all([deliveryA, deliveryB]);
    expect(resultA).toEqual({ timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS });
    // B, whose view included every in-band write, finished and acknowledged,
    // unless A's run-ahead hit the wake's event below a speculative write
    // and still wrote s1's outcome (a hazard stops decisions, not outcomes),
    // and that write took the fence first. Then B is the one fenced out, and
    // its redelivery finishes the run.
    if (resultB !== undefined) {
      expect(resultB).toEqual({
        timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS,
      });
    }
    // Not acknowledged: A's message is held again.
    expect(world.held.some((h) => h.messageId === start.messageId)).toBe(true);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe(1019);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(calls.fo_s2).toBe(1);
    // The run finished before A's body did, so nothing ran s1 again.
    expect(calls.fo_s1).toBe(1);
    // Each step was created once, and none has two outcomes.
    expect(
      new Set(eventsOf(world, 'step_created').map((e) => e.correlationId)).size
    ).toBe(2);
    for (const created of eventsOf(world, 'step_created')) {
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

  it('discards the retained session when a later write is fenced out, and its redelivery replays to the same result', async () => {
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

    expect(await world.deliver(start)).toEqual({
      timeoutSeconds: FENCE_REDELIVERY_DELAY_SECONDS,
    });
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
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
