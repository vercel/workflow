/**
 * `experimental_rateLimit()` driven end to end by the single orchestrator on
 * a World that reserves slots: a call whose slot is now goes ahead in the
 * same delivery, a call that has to wait sleeps on a timer until its slot and
 * records `rate_acquired`, and a call past its timeout rejects.
 */
import {
  RATE_ACQUIRE_GRACE_MS,
  SPEC_VERSION_RATE_LIMITS,
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

/** Two calls on a key at one per minute, the second willing to wait 1s. */
const timedOut = `${header}
  async function workflow() {
    await rateLimit({ key: "slow", limit: 1, period: "1m" });
    try {
      await rateLimit({ key: "slow", limit: 1, period: "1m", timeout: "1s" });
      return "acquired";
    } catch (error) {
      return error.name + ":" + error.key;
    }
  }${registerWorkflow()}`;

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setWorld(undefined);
});

describe('experimental_rateLimit() on the single orchestrator', () => {
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
          vi.setSystemTime(Date.now() + RATE_ACQUIRE_GRACE_MS + 2_000);
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
    ).toBeGreaterThan(RATE_ACQUIRE_GRACE_MS);
  }, 60_000);

  it('rejects a call whose slot is past its timeout, reserving nothing', async () => {
    const { world } = await setupOrchestratorRun(timedOut, [], {
      runSpecVersion: SPEC_VERSION_RATE_LIMITS,
    });
    await world.runOnClock();

    expect(await runResult(world)).toBe('RateLimitTimeoutError:slow');
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
