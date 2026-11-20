/**
 * `experimental_rateLimit()` driven end to end by the single orchestrator on
 * a World that reserves slots: a call whose slot is now goes ahead in the
 * same delivery, a call that has to wait sleeps on a timer until its slot and
 * records `rate_acquired`, and a call past its maxWait rejects.
 */
import { TooEarlyError } from '@workflow/errors';
import {
  rateGraceMs,
  SPEC_VERSION_RATE_LIMITS,
  slotToEventId,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeldMessage } from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const header = `const rateLimit = globalThis[Symbol.for("WORKFLOW_RATE_LIMIT")];`;

/** `n` calls in a row on one key at one per second. */
const sequential = `${header}
  async function workflow(n) {
    const at = [];
    for (let i = 0; i < n; i++) {
      await rateLimit({ key: "upstream", limit: 1, period: "1s" });
      at.push(Date.now());
    }
    return at;
  }${registerWorkflow()}`;

/** `n` calls in a row on one key at 3 per second, with a full burst. */
const bursting = `${header}
  async function workflow(n) {
    for (let i = 0; i < n; i++) {
      await rateLimit({ key: "bursty", limit: 3, period: "1s", burst: 3 });
    }
    return n;
  }${registerWorkflow()}`;

/**
 * A call whose slot is 2s out raced against a 500ms sleep, so the sleep is
 * due well inside the in-process window.
 */
const racedAgainstSleep = `${header}
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    await rateLimit({ key: "raced", limit: 1, period: "2s" });
    return await Promise.race([
      rateLimit({ key: "raced", limit: 1, period: "2s" }).then(() => "rate limit"),
      sleep("500ms").then(() => "sleep"),
    ]);
  }${registerWorkflow()}`;

/** Two calls in a row on a key at one per minute. */
const twoPerMinute = `${header}
  async function workflow() {
    await rateLimit({ key: "shared", limit: 1, period: "1m" });
    await rateLimit({ key: "shared", limit: 1, period: "1m" });
    return "done";
  }${registerWorkflow()}`;

/** Two calls on a key at one per minute, the second willing to wait 1s. */
const timedOut = `${header}
  async function workflow() {
    await rateLimit({ key: "slow", limit: 1, period: "1m" });
    try {
      await rateLimit({ key: "slow", limit: 1, period: "1m", maxWait: "1s" });
      return "acquired";
    } catch (error) {
      return error.name + ":" + error.key;
    }
  }${registerWorkflow()}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe('experimental_rateLimit() on the single orchestrator', () => {
  // A clock that only the queue moves: every wait is a timer, never an
  // in-process wait, which would wait on a clock that never moves.
  beforeEach(() => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_RATE_WAIT_MS', '0');
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('goes ahead at once when the slot is now, and waits for later slots', async () => {
    const { world } = await setupOrchestratorRun(sequential, [3], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // The first call was answered in place; the other two waited.
    expect(eventsOf(world, 'rate_created')).toHaveLength(2);
    const acquired = eventsOf(world, 'rate_acquired');
    expect(acquired).toHaveLength(3);
    const slots = acquired.map((event) =>
      new Date(dataOf(event)?.acquireAt as Date).getTime()
    );
    // One per second, and never early.
    expect(slots[1]! - slots[0]!).toBe(1_000);
    expect(slots[2]! - slots[1]!).toBe(1_000);
    for (const event of acquired.slice(1)) {
      expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(
        new Date(dataOf(event)?.acquireAt as Date).getTime()
      );
      // After a wait, it names its own rate_created.
      expect(dataOf(event)?.createdSlot).toEqual(expect.any(Number));
    }
    const at = (await runResult(world)) as number[];
    expect(at).toHaveLength(3);
  }, 60_000);

  it('lets a burst go at once, then waits one interval per call', async () => {
    const { world } = await setupOrchestratorRun(bursting, [4], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    // The burst of 3 was answered in place; only the 4th waited.
    expect(eventsOf(world, 'rate_created')).toHaveLength(1);
    const acquired = eventsOf(world, 'rate_acquired');
    expect(acquired).toHaveLength(4);
    // Every call carries its burst, the one that waited included.
    expect(acquired.map((event) => dataOf(event)?.burst)).toEqual([3, 3, 3, 3]);
    const slots = acquired.map((event) =>
      new Date(dataOf(event)?.acquireAt as Date).getTime()
    );
    expect(slots[1]).toBe(slots[0]);
    expect(slots[2]).toBe(slots[0]);
    expect(slots[3]! - slots[0]!).toBeGreaterThanOrEqual(333);
  }, 60_000);

  it('reserves a call again when its timer is delivered past the grace window', async () => {
    const { world } = await setupOrchestratorRun(sequential, [2], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    let delayed = false;
    await world.runOnClock({
      deliverAs: (held: HeldMessage) => {
        const timer = (held.message as { waitContinuation?: unknown })
          .waitContinuation;
        if (timer !== undefined && !delayed) {
          // A queue outage: the timer arrives well after the slot.
          delayed = true;
          vi.setSystemTime(Date.now() + rateGraceMs(1_000) + 2_000);
        }
        return held;
      },
    });

    expect(delayed).toBe(true);
    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const waiting = eventsOf(world, 'rate_created')[0];
    const slot = new Date(dataOf(waiting)?.acquireAt as Date).getTime();
    const second = eventsOf(world, 'rate_acquired').find(
      (event) => event.correlationId === waiting!.correlationId
    );
    // Not on its old slot: reserved again, and granted at the new one.
    expect(dataOf(second)?.createdSlot).toBeUndefined();
    expect(
      new Date(dataOf(second)?.acquireAt as Date).getTime() - slot
    ).toBeGreaterThan(rateGraceMs(1_000));
  }, 60_000);

  it('waits again for a call reserved behind other runs after a late wake', async () => {
    const { world } = await setupOrchestratorRun(twoPerMinute, [], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    let delayed = false;
    await world.runOnClock({
      deliverAs: (held: HeldMessage) => {
        const timer = (held.message as { waitContinuation?: unknown })
          .waitContinuation;
        if (timer !== undefined && !delayed) {
          delayed = true;
          // The only waiting call's timer arrives past its grace, while
          // other runs hold the key's next slots: it is reserved again
          // behind them, as a new rate_created, and nothing else of this
          // run is pending to wake it.
          vi.setSystemTime(Date.now() + rateGraceMs(60_000) + 2_000);
          world.rateTats.set('shared', (Date.now() + 5 * 60_000) * 1000);
        }
        return held;
      },
    });

    expect(delayed).toBe(true);
    expect(await runResult(world)).toBe('done');
    const created = eventsOf(world, 'rate_created');
    expect(created).toHaveLength(2);
    expect(dataOf(created[1])?.lateWakes).toBe(1);
    // Granted at the new slot, behind the other runs.
    const last = eventsOf(world, 'rate_acquired').at(-1);
    expect(dataOf(last)?.createdSlot).toEqual(expect.any(Number));
  }, 60_000);

  it('rejects a call whose slot is past its maxWait, reserving nothing', async () => {
    const { world } = await setupOrchestratorRun(timedOut, [], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    expect(await runResult(world)).toBe('RateLimitMaxWaitError:slow');
    expect(eventsOf(world, 'rate_failed')).toHaveLength(1);
    // The failed call left the key where the first call put it.
    expect(world.rateTats.get('slow')).toBe(
      new Date(
        dataOf(eventsOf(world, 'rate_acquired')[0])?.acquireAt as Date
      ).getTime() *
        1000 +
        60_000_000
    );
  }, 60_000);

  it('fails a run below spec 10 with a clear error', async () => {
    const { world } = await setupOrchestratorRun(sequential, [1]);
    await world.runOnClock();

    expect(eventsOf(world, 'rate_created')).toHaveLength(0);
    // Refused before it is written: the World is never asked.
    expect(eventsOf(world, 'run_failed')).toHaveLength(1);
    expect(world.rateTats.size).toBe(0);
  }, 60_000);
});

describe('waiting in process for a near rate limit slot', () => {
  const isTimerFor = (message: unknown, correlationId: string) =>
    (message as { waitContinuation?: { correlationId?: string } })
      .waitContinuation?.correlationId === correlationId;

  it('goes ahead at its slot, with its queue timer sent first', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    // Two per second: each call after the first waits about 500ms.
    const halfSecond = sequential.replace(
      'limit: 1, period: "1s"',
      'limit: 2, period: "1s"'
    );
    const timerBeforeAcquired: boolean[] = [];
    let held: AppendOnlyWorld | undefined;
    const { world } = await setupOrchestratorRun(halfSecond, [3], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      beforeCreate: (data: { eventType: string; correlationId?: string }) => {
        if (data.eventType !== 'rate_acquired' || !data.correlationId) return;
        const id = data.correlationId;
        timerBeforeAcquired.push(
          held?.queueCalls.some((call) => isTimerFor(call.message, id)) ?? false
        );
      },
    });
    held = world;
    await world.runOnClock();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    const acquired = eventsOf(world, 'rate_acquired').slice(1);
    expect(acquired).toHaveLength(2);
    for (const event of acquired) {
      const slot = new Date(dataOf(event)?.acquireAt as Date).getTime();
      const lateMs = event.createdAt.getTime() - slot;
      // At its slot, not a whole-second queue delay after it.
      expect(lateMs).toBeGreaterThanOrEqual(0);
      expect(lateMs).toBeLessThan(400);
    }
    // The safety net: had the delivery died while it waited, the queue
    // would still have woken the run.
    expect(timerBeforeAcquired).toEqual([true, true]);
  }, 60_000);

  it('retries in process when the World clock is a little behind', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    const halfSecond = sequential.replace(
      'limit: 1, period: "1s"',
      'limit: 2, period: "1s"'
    );
    // The World's clock is 60 ms behind this one: past the in-process
    // wait's margin, so the first rate_acquired at the slot is too early.
    const skewMs = 60;
    let refused = 0;
    let held: AppendOnlyWorld | undefined;
    const { world } = await setupOrchestratorRun(halfSecond, [3], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
      beforeCreate: (data: {
        eventType: string;
        eventData?: { createdSlot?: number };
      }) => {
        const slot = data.eventData?.createdSlot;
        if (data.eventType !== 'rate_acquired' || slot === undefined) return;
        const created = held?.events.find(
          (event) => event.eventId === slotToEventId(slot)
        );
        const acquireAt = new Date(
          dataOf(created)?.acquireAt as Date
        ).getTime();
        if (Date.now() - skewMs < acquireAt) {
          refused++;
          throw new TooEarlyError('not due by the World clock', {
            retryAfter: 1,
          });
        }
      },
    });
    held = world;
    await world.runOnClock();

    expect(eventsOf(world, 'run_completed')).toHaveLength(1);
    expect(refused).toBeGreaterThan(0);
    for (const event of eventsOf(world, 'rate_acquired').slice(1)) {
      const slot = new Date(dataOf(event)?.acquireAt as Date).getTime();
      const lateMs = event.createdAt.getTime() - slot;
      // Retried in process, not a whole-second queue timer later.
      expect(lateMs).toBeGreaterThanOrEqual(skewMs);
      expect(lateMs).toBeLessThan(400);
    }
  }, 60_000);

  it('wakes early for a slot further out, and finishes the wait in process', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    // A 2s window rather than the default, so the test waits less.
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_RATE_WAIT_MS', '2000');
    // The queue's clock jumps to each timer; between them it runs in real
    // time, so the woken delivery's in-process wait reaches the slot.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    // One per 3s: the second call's slot is 3s out, past the 2s window.
    const threeSeconds = sequential.replace('period: "1s"', 'period: "3s"');
    const { world } = await setupOrchestratorRun(threeSeconds, [2], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    const [, waited] = eventsOf(world, 'rate_acquired');
    expect(waited).toBeDefined();
    const slot = new Date(dataOf(waited)?.acquireAt as Date).getTime();
    const lateMs = waited!.createdAt.getTime() - slot;
    expect(lateMs).toBeGreaterThanOrEqual(0);
    expect(lateMs).toBeLessThan(400);
    const timers = world.queueCalls.filter(
      (call) =>
        (call.message as { waitContinuation?: unknown }).waitContinuation !==
        undefined
    );
    // Woken a second in, two before the slot, then re-armed for the slot
    // before the in-process wait.
    expect(timers[0]?.opts?.delaySeconds).toBe(1);
    expect(
      timers.some(
        (call) =>
          (call.message as { waitContinuation?: { attempt?: number } })
            .waitContinuation?.attempt === 1
      )
    ).toBe(true);
  }, 60_000);

  it('stops waiting in process for a slot when a sleep it races falls due first', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_RATE_WAIT_MS', '5000');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const { world } = await setupOrchestratorRun(racedAgainstSleep, [], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    expect(await runResult(world)).toBe('sleep');
    // Completed at its own time, not held back until the call's slot: the
    // sleep is due 1.5s before it.
    const [completed] = eventsOf(world, 'wait_completed');
    const resumeAt = new Date(dataOf(completed)?.resumeAt as Date).getTime();
    expect(completed!.createdAt.getTime() - resumeAt).toBeLessThan(500);
  }, 60_000);

  it('leaves a slot further out than the window to the queue', async () => {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_RATE_WAIT_MS', '100');
    vi.useFakeTimers({ toFake: ['Date'] });
    const { world } = await setupOrchestratorRun(sequential, [2], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();
    expect(eventsOf(world, 'rate_acquired')).toHaveLength(2);
    // The one wait was a delivered timer.
    expect(
      world.deliveries.some(
        (delivery) =>
          (delivery.message as { waitContinuation?: unknown })
            .waitContinuation !== undefined
      )
    ).toBe(true);
  }, 60_000);
});
