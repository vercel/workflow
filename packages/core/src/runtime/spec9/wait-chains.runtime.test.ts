/**
 * Wait timers on a queue that coalesces a run's orchestrator messages, as
 * world-vercel does with its concurrency key: a timer that comes due while
 * another delivery of the run holds the key is never delivered.
 */
import { type Event, isIntermediateWaitHop } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../../serialization.js';
import type {
  AppendOnlyWorld,
  HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const TOKEN = 'wait-chain-hook';

const hookAndTwoSleeps = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    const sleeps = Promise.all([sleep("1h"), sleep("2h")]);
    await hook;
    await sleeps;
    return "done";
  }${registerWorkflow()}`;

const SHORT_SLEEP_SECONDS = 30;

const hookAndShortSleep = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    await Promise.all([sleep("${SHORT_SLEEP_SECONDS}s"), hook]);
    return "done";
  }${registerWorkflow()}`;

/** Seconds per queue hop in these tests (see `WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS`). */
const HOP_SECONDS = 60;
const LONG_SLEEP_SECONDS = 2 * HOP_SECONDS + 30;

const hookAndLongSleep = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    await Promise.all([sleep("${LONG_SLEEP_SECONDS}s"), hook]);
    return "done";
  }${registerWorkflow()}`;

const timerFor = (held: HeldMessage) =>
  (held.message as { waitContinuation?: { correlationId: string } })
    .waitContinuation?.correlationId;

const timers = (world: AppendOnlyWorld) =>
  world.held.filter((held) => timerFor(held) !== undefined);

/** Writes the hook's payload out-of-band and enqueues the wake its writer sends. */
async function resumeHookOutOfBand(
  world: AppendOnlyWorld,
  runId: string
): Promise<HeldMessage> {
  const hookCreated = eventsOf(world, 'hook_created')[0]!;
  world.appendOutOfBand({
    eventType: 'hook_received',
    correlationId: hookCreated.correlationId,
    eventData: {
      token: dataOf(hookCreated)?.token,
      payload: await dehydrateStepReturnValue({ ok: true }, runId, undefined),
    },
  } as Partial<Event>);
  return world.enqueue(ORCHESTRATOR_QUEUE, {
    runId,
    runSpecVersion: world.asWorld().specVersion,
  });
}

/** Calls `onList` on every `events.list` of the World, then lists. */
function onEveryList(world: AppendOnlyWorld, onList: () => void): void {
  const asWorld = world.asWorld();
  const list = asWorld.events.list.bind(asWorld.events);
  asWorld.events.list = async (params) => {
    onList();
    return list(params);
  };
  setWorld(asWorld);
}

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('wait timers on a coalescing queue (%s engine)', (engine) => {
  it('arms the second of two sleeps when the first one is completed by a hook wake its timer was coalesced into', async () => {
    let world!: AppendOnlyWorld;
    let firstTimer: HeldMessage | undefined;
    let coalesced = false;
    const setup = await setupOrchestratorRun(
      hookAndTwoSleeps,
      [],
      {
        coalesce: true,
        beforeCreate(data) {
          // The first sleep's timer comes due while the hook wake holds the
          // run: the queue coalesces it, and it is never delivered.
          if (data.eventType === 'wait_completed' && firstTimer && !coalesced) {
            coalesced = world.comeDue(firstTimer);
          }
        },
      },
      engine
    );
    world = setup.world;
    const { runId, start } = setup;

    await world.deliver(start);
    const waits = eventsOf(world, 'wait_created');
    expect(waits).toHaveLength(2);
    const [first, second] = [...waits].sort(
      (a, b) =>
        +new Date(dataOf(a)!.resumeAt as Date) -
        +new Date(dataOf(b)!.resumeAt as Date)
    );
    // The delivery that created both sleeps armed one timer, the earliest.
    expect(timers(world).map(timerFor)).toEqual([first!.correlationId]);
    firstTimer = timers(world)[0];

    vi.setSystemTime(Date.now() + 90 * 60_000);
    const wake = await resumeHookOutOfBand(world, runId);
    await world.deliver(wake);

    expect(coalesced).toBe(true);
    expect(
      eventsOf(world, 'wait_completed').map((e) => e.correlationId)
    ).toEqual([first!.correlationId]);
    // The hook wake completed the first sleep, so it armed the second.
    expect(timers(world).map(timerFor)).toEqual([second!.correlationId]);

    vi.setSystemTime(Date.now() + 60 * 60_000);
    await world.runUntilIdle();
    expect(await runResult(world)).toBe('done');
    expect(eventsOf(world, 'wait_completed')).toHaveLength(2);
  });

  /**
   * Delivers a hook wake that completes the first of two sleeps (its timer
   * coalesced into the wake), with `failure` making that delivery fail
   * around the completion, then lets every message run.
   */
  async function completeFirstSleepThenFail(
    failure: 'timer-send' | 'lost-completion-response'
  ) {
    let world!: AppendOnlyWorld;
    let firstTimer: HeldMessage | undefined;
    let failNext = false;
    const setup = await setupOrchestratorRun(
      hookAndTwoSleeps,
      [],
      {
        coalesce: true,
        beforeCreate(data) {
          if (data.eventType === 'wait_completed' && firstTimer) {
            world.comeDue(firstTimer);
          }
        },
      },
      engine
    );
    world = setup.world;
    const { runId, start } = setup;
    const asWorld = world.asWorld();
    const queue = asWorld.queue.bind(asWorld);
    const create = asWorld.events.create.bind(asWorld.events);
    asWorld.queue = (async (...args: Parameters<typeof queue>) => {
      const message = args[1] as { waitContinuation?: unknown };
      if (failure === 'timer-send' && failNext && message.waitContinuation) {
        failNext = false;
        throw new Error('timer send failed');
      }
      return queue(...args);
    }) as typeof asWorld.queue;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      const data = args[1] as { eventType: string };
      if (
        failure === 'lost-completion-response' &&
        failNext &&
        data.eventType === 'wait_completed'
      ) {
        // Committed, but the delivery never hears back.
        failNext = false;
        throw new Error('connection reset');
      }
      return result;
    }) as typeof asWorld.events.create;
    setWorld(asWorld);

    await world.deliver(start);
    firstTimer = timers(world)[0];
    vi.setSystemTime(Date.now() + 90 * 60_000);
    const wake = await resumeHookOutOfBand(world, runId);
    failNext = true;
    await expect(world.deliver(wake)).rejects.toThrow();
    const completedByFailedDelivery = eventsOf(world, 'wait_completed').length;
    // The redelivery, and anything else not delayed to a sleep.
    for (
      let next = world.held.find((held) => timerFor(held) === undefined);
      next;
      next = world.held.find((held) => timerFor(held) === undefined)
    ) {
      await world.deliver(next);
    }
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await world.runUntilIdle();
    return { world, completedByFailedDelivery };
  }

  it('arms the next sleep of a chain before committing the completion, so a failed timer send commits nothing', async () => {
    const { world, completedByFailedDelivery } =
      await completeFirstSleepThenFail('timer-send');
    expect(completedByFailedDelivery).toBe(0);
    expect(await runResult(world)).toBe('done');
    expect(eventsOf(world, 'wait_completed')).toHaveLength(2);
  });

  it('keeps the next sleep of a chain armed when the delivery fails after committing the completion', async () => {
    const { world, completedByFailedDelivery } =
      await completeFirstSleepThenFail('lost-completion-response');
    expect(completedByFailedDelivery).toBe(1);
    expect(await runResult(world)).toBe('done');
    expect(eventsOf(world, 'wait_completed')).toHaveLength(2);
  });

  it.each([
    50, 500,
  ])('completes a sleep whose timer is coalesced %dms before it is due into a delivery that does not own it', async (earlyMs) => {
    let world!: AppendOnlyWorld;
    let dueDuringWake: HeldMessage | undefined;
    const coalescedResults: boolean[] = [];
    const setup = await setupOrchestratorRun(
      hookAndShortSleep,
      [],
      { coalesce: true },
      engine
    );
    world = setup.world;
    const { runId, start } = setup;
    onEveryList(world, () => {
      if (dueDuringWake) {
        coalescedResults.push(world.comeDue(dueDuringWake));
        dueDuringWake = undefined;
      }
    });

    await world.deliver(start);
    const [timer] = timers(world);
    expect(timers(world)).toHaveLength(1);
    const resumeAtMs = +new Date(
      dataOf(eventsOf(world, 'wait_created')[0])!.resumeAt as Date
    );

    // The queue's clock runs ahead of the host's: the sleep's only timer
    // comes due before the sleep is, while a hook wake (which does not own
    // the sleep's chain) holds the run, and is coalesced into it.
    vi.setSystemTime(resumeAtMs - earlyMs);
    dueDuringWake = timer;
    await world.deliver(await resumeHookOutOfBand(world, runId));
    expect(coalescedResults).toEqual([true]);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    // The wake found the sleep not yet due and armed it anyway (each re-run
    // of a coalesced delivery may arm it once).
    expect(timers(world).length).toBeGreaterThan(0);
    expect(new Set(timers(world).map(timerFor))).toEqual(
      new Set([timerFor(timer!)])
    );

    vi.setSystemTime(resumeAtMs + 1000);
    await world.runUntilIdle();
    expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe('done');
  });

  it('keeps a sleep longer than one queue hop alive when a hop comes due under a running delivery', async () => {
    vi.stubEnv(
      'WORKFLOW_WAIT_CONTINUATION_MAX_DELAY_SECONDS',
      String(HOP_SECONDS)
    );
    let world!: AppendOnlyWorld;
    let dueDuringWake: HeldMessage | undefined;
    const coalescedResults: boolean[] = [];
    const setup = await setupOrchestratorRun(
      hookAndLongSleep,
      [],
      { coalesce: true },
      engine
    );
    world = setup.world;
    const { runId, start } = setup;
    onEveryList(world, () => {
      if (dueDuringWake) {
        coalescedResults.push(world.comeDue(dueDuringWake));
        dueDuringWake = undefined;
      }
    });

    await world.deliver(start);
    const [firstHop] = timers(world);
    expect(timers(world)).toHaveLength(1);
    // Due before the sleep: an intermediate hop.
    expect(isIntermediateWaitHop(firstHop!.message)).toBe(true);
    expect(firstHop!.opts?.delaySeconds).toBe(HOP_SECONDS);

    // The hop comes due while a hook wake holds the run. It is not keyed,
    // so the queue does not coalesce it.
    vi.setSystemTime(Date.now() + HOP_SECONDS * 1000);
    dueDuringWake = firstHop;
    await world.deliver(await resumeHookOutOfBand(world, runId));
    expect(coalescedResults).toEqual([false]);
    expect(world.held).toContain(firstHop);

    // Delivered, the hop sends the next one and writes and reads nothing.
    const creates = world.creates.length;
    const lists = world.listCalls.length;
    await world.deliver(firstHop!);
    expect(world.creates.length).toBe(creates);
    expect(world.listCalls.length).toBe(lists);
    const [secondHop] = timers(world);
    expect(timers(world)).toHaveLength(1);
    expect(isIntermediateWaitHop(secondHop!.message)).toBe(true);

    vi.setSystemTime(Date.now() + HOP_SECONDS * 1000);
    await world.deliver(secondHop!);
    // The last hop is due with the sleep: an ordinary, keyed timer.
    const [finalTimer] = timers(world);
    expect(timers(world)).toHaveLength(1);
    expect(isIntermediateWaitHop(finalTimer!.message)).toBe(false);

    // It comes due while another delivery holds the run and is coalesced
    // into it: that delivery's re-run finds the sleep due and completes it.
    vi.setSystemTime(Date.now() + HOP_SECONDS * 1000);
    dueDuringWake = finalTimer;
    await world.deliver(
      world.enqueue(ORCHESTRATOR_QUEUE, {
        runId,
        runSpecVersion: world.asWorld().specVersion,
      })
    );
    expect(coalescedResults).toEqual([false, true]);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
    expect(await runResult(world)).toBe('done');
    expect(world.held).toEqual([]);
  });
});
