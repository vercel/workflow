/**
 * A delivery with nothing left to run stays live until a wait due soon
 * enough (runtime/spec9/live-feed.ts, `orchestratorLingerUntil` and
 * `getOrchestratorWaitLingerMs`), and completes it in process, so a run that
 * loops on a short `sleep()` costs one invocation and one full log load per
 * inline window instead of one per sleep.
 */
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { dehydrateStepReturnValue } from '../../serialization.js';
import type {
  AppendOnlyWorld,
  HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';
import { __resetConsumedPositionsForTests } from './consumed-position.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

registerStepFunction('wait_linger_step', async (n: number) => n);

/** Sleep of each loop iteration, in ms: short enough for a real clock. */
const SLEEP_MS = 300;
const ITERATIONS = 5;

const sleepLoop = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("wait_linger_step");
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(n, tail) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += await step(i);
      await sleep("${SLEEP_MS}ms");
    }
    if (tail) await sleep(tail);
    return total;
  }${registerWorkflow()}`;

const TOKEN = 'wait-linger-hook';
const hookOrSleep = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    return await Promise.race([hook, sleep("3s").then(() => "timeout")]);
  }${registerWorkflow()}`;

const lonelySleep = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(duration) {
    await sleep(duration);
    return "slept";
  }${registerWorkflow()}`;

const isTimer = (message: unknown) =>
  (message as { waitContinuation?: unknown }).waitContinuation !== undefined;
const isStep = (message: unknown) =>
  (message as { stepId?: unknown }).stepId !== undefined;

/** `events.list` calls that read the log from its start (a full load). */
const fullLoadsOf = (world: AppendOnlyWorld) =>
  world.listCalls.filter((call) => {
    const pagination = call.pagination as
      | { cursor?: string; sortOrder?: string; limit?: number }
      | undefined;
    return pagination?.cursor === undefined && pagination?.sortOrder !== 'desc';
  }).length;
/** The one-event tail reads of the no-op check. */
const tailReadsOf = (world: AppendOnlyWorld) =>
  world.listCalls.filter(
    (call) =>
      (call.pagination as { sortOrder?: string } | undefined)?.sortOrder ===
      'desc'
  ).length;
const orchestratorDeliveriesOf = (world: AppendOnlyWorld) =>
  world.deliveries.filter((d) => !isStep(d.message));

const realSleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Delivers held messages in due order on the real clock, waiting for each
 * one's delay, until none is left.
 */
async function drive(world: AppendOnlyWorld, limit = 200): Promise<void> {
  const dueAt = (held: HeldMessage) => held.dueAtMs ?? +held.createdAt;
  for (let i = 0; i < limit; i++) {
    if (world.held.length === 0) return;
    const next = world.held.reduce((a, b) => (dueAt(b) < dueAt(a) ? b : a));
    await realSleep(dueAt(next) - Date.now());
    await world.deliver(next);
  }
  throw new Error(`still ${world.held.length} message(s) after ${limit}`);
}

/**
 * Waits for `delivery`, letting each held message come due on the real clock
 * meanwhile: in `coalesce` mode one that comes due while the delivery runs is
 * coalesced into it, as on world-vercel.
 */
async function coalesceWhileRunning(
  world: AppendOnlyWorld,
  delivery: Promise<unknown>
): Promise<void> {
  let finished = false;
  void delivery.finally(() => {
    finished = true;
  });
  while (!finished) {
    for (const held of [...world.held]) {
      if ((held.dueAtMs ?? 0) <= Date.now()) world.comeDue(held);
    }
    await realSleep(20);
  }
  await delivery;
}

/** The event log's shape: event types in slot order, payloads aside. */
const shapeOf = (world: AppendOnlyWorld) =>
  world.events
    .filter((event) => event.eventType !== 'noop')
    .map((event) => event.eventType);

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  // A 20s inline window whose last second starts no inline step, so the
  // loop fits in one invocation.
  vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', '20000');
  vi.stubEnv('WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS', '1000');
});
afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe.each([
  'node',
  'quickjs',
] as const)('orchestrator linger through near-due waits (%s engine)', (engine) => {
  async function loop(
    options: { subscribe?: boolean; coalesce?: boolean } = {},
    tail?: string
  ) {
    const setup = await setupOrchestratorRun(
      sleepLoop,
      [ITERATIONS, tail],
      { subscribe: true, ...options },
      engine
    );
    __resetConsumedPositionsForTests(setup.world.asWorld());
    return setup;
  }

  it('runs a step and sleep loop in one delivery, with no full load per sleep', async () => {
    /** Runs the loop: its start delivery, then every message it left. */
    const measure = async () => {
      const { world, start } = await loop();
      await world.deliver(start);
      const atStart = {
        fullLoads: fullLoadsOf(world),
        deliveries: orchestratorDeliveriesOf(world).length,
        completed: eventsOf(world, 'run_completed').length,
      };
      await drive(world);
      return {
        world,
        completedByStart: atStart.completed === 1,
        laterDeliveries:
          orchestratorDeliveriesOf(world).length - atStart.deliveries,
        laterFullLoads: fullLoadsOf(world) - atStart.fullLoads,
        laterTailReads: tailReadsOf(world),
        timersSent: world.queueCalls.filter((c) => isTimer(c.message)).length,
      };
    };
    const after = await measure();
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS', '0');
    const before = await measure();

    const expected = (ITERATIONS * (ITERATIONS - 1)) / 2;
    for (const { world } of [after, before]) {
      expect(await runResult(world)).toBe(expected);
      expect(eventsOf(world, 'wait_completed')).toHaveLength(ITERATIONS);
    }
    // The same log either way.
    expect(shapeOf(after.world)).toEqual(shapeOf(before.world));
    // Without the linger each sleep ends the delivery, and its timer starts
    // a delivery that loads the whole log.
    expect(before.completedByStart).toBe(false);
    expect(before.laterDeliveries).toBe(ITERATIONS);
    expect(before.laterFullLoads).toBe(ITERATIONS);
    // With it the start delivery runs every iteration. The timers it armed
    // are delivered after the run ended, and read nothing.
    expect(after.completedByStart).toBe(true);
    expect(after.laterDeliveries).toBe(ITERATIONS);
    expect(after.laterFullLoads).toBe(0);
    expect(after.laterTailReads).toBe(0);
    // No more timers than without the linger: one per wait.
    expect(after.timersSent).toBe(before.timersSent);
    expect(after.timersSent).toBe(ITERATIONS);
  }, 30_000);

  it('runs every iteration before any timer is delivered', async () => {
    const { world, start } = await loop();
    const delivery = world.deliver(start);
    await vi.waitFor(
      () => expect(eventsOf(world, 'wait_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    const fullLoadsAtFirstSleep = fullLoadsOf(world);
    await delivery;
    // The start delivery alone completed the run, reading only the events
    // after its log from the first sleep on.
    expect(await runResult(world)).toBe((ITERATIONS * (ITERATIONS - 1)) / 2);
    expect(orchestratorDeliveriesOf(world)).toHaveLength(1);
    expect(fullLoadsOf(world)).toBe(fullLoadsAtFirstSleep);
    // Each wait's timer went out, before the wait completed.
    const timers = world.held.filter((h) => isTimer(h.message));
    expect(timers).toHaveLength(ITERATIONS);
  }, 30_000);

  it('acknowledges the leftover timer of a wait it completed in process', async () => {
    // A tail sleep past the inline window: the delivery completes the loop's
    // waits in process and then suspends.
    const { world, start } = await loop({}, '1h');
    await world.deliver(start);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(ITERATIONS);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
    const leftovers = world.held.filter(
      (h) =>
        isTimer(h.message) &&
        eventsOf(world, 'wait_completed').some(
          (e) =>
            e.correlationId ===
            (h.message as { waitContinuation: { correlationId: string } })
              .waitContinuation.correlationId
        )
    );
    expect(leftovers).toHaveLength(ITERATIONS);
    const fullBefore = fullLoadsOf(world);
    const tailBefore = tailReadsOf(world);
    const eventsBefore = world.events.length;
    for (const timer of leftovers) await world.deliver(timer);

    expect(world.events.length).toBe(eventsBefore);
    const fullLoads = fullLoadsOf(world) - fullBefore;
    const tailReads = tailReadsOf(world) - tailBefore;
    if (engine === 'node') {
      // One tail read each, no replay.
      expect(fullLoads).toBe(0);
      expect(tailReads).toBe(ITERATIONS);
    } else {
      // The QuickJS engine records no consumed position: each leftover
      // timer replays from a full load and finds nothing to do.
      expect(fullLoads).toBe(ITERATIONS);
    }
  }, 30_000);

  it('suspends with a queued timer for a wait due past the inline deadline', async () => {
    vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', '3000');
    const { world, start } = await setupOrchestratorRun(
      lonelySleep,
      ['5s'],
      { subscribe: true },
      engine
    );
    const startedAt = Date.now();
    await world.deliver(start);

    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    const timers = world.held.filter((h) => isTimer(h.message));
    expect(timers).toHaveLength(1);
    expect(timers[0]?.opts?.delaySeconds).toBe(5);
  });

  it('suspends at every sleep with the setting at 0', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS', '0');
    const { world, start } = await loop();
    await world.deliver(start);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
  });

  it('suspends at every sleep with WORKFLOW_ORCHESTRATOR_LINGER_MS at 0', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
    const { world, start } = await loop();
    await world.deliver(start);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
  });

  it('suspends at every sleep without a live feed', async () => {
    const { world } = await loop({ subscribe: false });
    await drive(world);
    expect(await runResult(world)).toBe((ITERATIONS * (ITERATIONS - 1)) / 2);
    expect(orchestratorDeliveriesOf(world)).toHaveLength(ITERATIONS + 1);
  }, 30_000);

  it('suspends when the live feed fails', async () => {
    const { world, start } = await setupOrchestratorRun(
      sleepLoop,
      [ITERATIONS],
      { subscribeFailure: 'microtask' },
      engine
    );
    await world.deliver(start);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    expect(world.held.filter((h) => isTimer(h.message))).toHaveLength(1);
  });

  it('takes a hook payload that arrives while it lingers on a wait', async () => {
    // Hooks alone do not linger here: the wait does.
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '0');
    const { world, runId, start } = await setupOrchestratorRun(
      hookOrSleep,
      [],
      { subscribe: true },
      engine
    );
    const delivery = world.deliver(start);
    await vi.waitFor(
      () => expect(eventsOf(world, 'wait_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    // Still live, and its timer is out.
    expect(world.deliveries).toHaveLength(0);
    expect(world.held.filter((h) => isTimer(h.message))).toHaveLength(1);
    world.appendOutOfBand({
      eventType: 'hook_received',
      runId,
      correlationId: eventsOf(world, 'hook_created')[0]?.correlationId,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue('resumed', runId, undefined),
      },
    } as unknown as Partial<Event>);
    await delivery;

    expect(await runResult(world)).toBe('resumed');
    expect(orchestratorDeliveriesOf(world)).toHaveLength(1);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
  });

  it('stops when the run is cancelled while it lingers on a wait', async () => {
    const { world, runId, start } = await setupOrchestratorRun(
      lonelySleep,
      ['10s'],
      { subscribe: true },
      engine
    );
    const startedAt = Date.now();
    const delivery = world.deliver(start);
    await vi.waitFor(
      () => expect(eventsOf(world, 'wait_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    world.appendOutOfBand({
      eventType: 'run_cancelled',
      runId,
    } as Partial<Event>);
    await delivery;

    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(0);
    expect(eventsOf(world, 'run_completed')).toHaveLength(0);
  });

  it('is woken by its queued timer when the lingering delivery dies mid-sleep', async () => {
    // The lingering delivery's own `wait_completed` never commits, as if
    // its instance died once the wait fell due; the timer it armed before
    // lingering wakes the run in another delivery.
    let release: (() => void) | undefined;
    let held = false;
    const { world, start } = await setupOrchestratorRun(
      lonelySleep,
      ['500ms'],
      {
        subscribe: true,
        beforeCreate: async (data) => {
          if (data.eventType !== 'wait_completed' || held) return;
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
      engine
    );
    const dying = world.deliver(start).catch(() => undefined);
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 5000 });
    const timer = world.held.find((h) => isTimer(h.message));
    if (!timer) throw new Error('no timer armed before the linger');
    await world.deliver(timer);

    expect(await runResult(world)).toBe('slept');
    expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
    release?.();
    await dying;
    // The dead delivery's late write was refused: still one completion.
    expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
  }, 15_000);

  it('covers leftover timers that come due while it runs with a re-run', async () => {
    // As on world-vercel: a timer that comes due while the delivery runs is
    // coalesced into it. A tail sleep past the inline window keeps the run
    // open, so a timer delivered after the delivery is a delivery of its own.
    const { world, start } = await loop({ coalesce: true }, '1h');
    const delivery = world.deliver(start);
    await vi.waitFor(
      () => expect(eventsOf(world, 'wait_created')).toHaveLength(1),
      { timeout: 5000 }
    );
    const fullLoadsAtFirstSleep = fullLoadsOf(world);
    await coalesceWhileRunning(world, delivery);
    expect(eventsOf(world, 'wait_completed')).toHaveLength(ITERATIONS);
    const coalesced = world.coalescedMessages;
    const reruns = orchestratorDeliveriesOf(world).length - 1;
    // The rest of the loop's timers, delivered on their own.
    const leftovers = world.held.filter(
      (h) =>
        isTimer(h.message) &&
        (h.message as { waitContinuation: { resumeAtMs?: number } })
          .waitContinuation.resumeAtMs === undefined &&
        (h.opts?.delaySeconds as number) < 60
    );
    await realSleep(
      Math.max(...leftovers.map((h) => h.dueAtMs ?? 0)) - Date.now()
    );
    for (const timer of leftovers) await world.deliver(timer);

    const fullLoadsAfter = fullLoadsOf(world) - fullLoadsAtFirstSleep;
    expect(coalesced + leftovers.length).toBe(ITERATIONS);
    // Re-runs of the delivery cover the coalesced timers: one for those that
    // came due while it ran, one more for each that came due during a re-run.
    expect(reruns).toBeGreaterThanOrEqual(coalesced > 0 ? 1 : 0);
    expect(reruns).toBeLessThanOrEqual(coalesced);
    if (engine === 'node') {
      // The re-run replays from a full load; a leftover delivered on its
      // own reads only the log tail.
      expect(fullLoadsAfter).toBe(reruns);
    } else {
      expect(fullLoadsAfter).toBe(reruns + leftovers.length);
    }
  }, 30_000);
});
