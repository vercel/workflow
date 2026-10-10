import type { Event, HookResumeFence } from '@workflow/world';
import { HOOK_RESUME_FENCE_MAX_WINDOW_MS } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awaitHookResumeFence,
  clampHookResumeFenceWindow,
  classifyHookResumeFence,
  isParallelHookWakeEnabled,
  PARALLEL_HOOK_WAKE_ENV_VAR,
  parallelHookWakeNeedsInsurance,
  runSupportsHookResumeFence,
} from './hook-resume-fence.js';

const runId = 'wrun_fence';
const fence: HookResumeFence = {
  resumeId: 'resume_1',
  hookId: 'hook_1',
  windowMs: 1_000,
};

let slot = 0;
const ev = (data: Record<string, unknown>): Event =>
  ({
    runId,
    eventId: `evnt_${++slot}`,
    createdAt: new Date(),
    ...data,
  }) as unknown as Event;

const hookCreated = () =>
  ev({ eventType: 'hook_created', correlationId: fence.hookId });
const receipt = (resumeId = fence.resumeId) =>
  ev({
    eventType: 'hook_received',
    correlationId: fence.hookId,
    resumeId,
    eventData: { token: 't', payload: new Uint8Array([1]) },
  });

/** A virtual monotonic clock whose sleeps advance time instantly. */
function virtualClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('classifyHookResumeFence', () => {
  it('matches the receipt by top-level resumeId', () => {
    expect(
      classifyHookResumeFence([hookCreated(), receipt()], fence, runId)
    ).toBe('present');
  });

  it('matches the receipt by eventData.resumeId', () => {
    const event = ev({
      eventType: 'hook_received',
      correlationId: fence.hookId,
      eventData: { token: 't', resumeId: fence.resumeId },
    });
    expect(classifyHookResumeFence([event], fence, runId)).toBe('present');
  });

  it('does not match another resume of the same hook', () => {
    expect(
      classifyHookResumeFence(
        [hookCreated(), receipt('resume_other')],
        fence,
        runId
      )
    ).toBeUndefined();
  });

  it('reports a disposal of the fenced hook with no receipt', () => {
    expect(
      classifyHookResumeFence(
        [
          hookCreated(),
          ev({ eventType: 'hook_disposed', correlationId: fence.hookId }),
        ],
        fence,
        runId
      )
    ).toBe('hook_disposed');
  });

  it('prefers a receipt that committed before the disposal', () => {
    expect(
      classifyHookResumeFence(
        [
          hookCreated(),
          receipt(),
          ev({ eventType: 'hook_disposed', correlationId: fence.hookId }),
        ],
        fence,
        runId
      )
    ).toBe('present');
  });

  it('reports a terminal run', () => {
    expect(
      classifyHookResumeFence(
        [hookCreated(), ev({ eventType: 'run_completed' })],
        fence,
        runId
      )
    ).toBe('run_terminal');
  });
});

describe('awaitHookResumeFence', () => {
  it('returns immediately, with no read, when the receipt is already loaded (redelivery / duplicate wake)', async () => {
    const clock = virtualClock();
    const events = [hookCreated(), receipt()];
    let reloads = 0;
    const result = await awaitHookResumeFence({
      fence,
      runId,
      getEvents: () => events,
      reload: async () => {
        reloads++;
      },
      handlerEnteredAt: 0,
      ...clock,
    });
    expect(result).toMatchObject({ outcome: 'present', reloads: 0 });
    expect(reloads).toBe(0);
  });

  it('re-reads until a write that commits after the first load is visible (consumer before commit)', async () => {
    const clock = virtualClock();
    const events: Event[] = [hookCreated()];
    const commitAt = 120;
    let reloads = 0;
    const result = await awaitHookResumeFence({
      fence,
      runId,
      getEvents: () => events,
      reload: async () => {
        reloads++;
        if (clock.now() >= commitAt && events.length === 1) {
          events.push(receipt());
        }
      },
      handlerEnteredAt: 0,
      ...clock,
    });
    expect(result.outcome).toBe('present');
    expect(reloads).toBe(result.reloads);
    // Backoff 10, 20, 40, 80 ms: the read at t=150 is the first after commit.
    expect(clock.now()).toBe(150);
    expect(result.reloads).toBe(4);
  });

  it('gives up only after a read that started at or after the window deadline (write failed)', async () => {
    const clock = virtualClock(500);
    const readStarts: number[] = [];
    const result = await awaitHookResumeFence({
      fence,
      runId,
      getEvents: () => [hookCreated()],
      reload: async () => {
        readStarts.push(clock.now());
        clock.advance(30); // each read takes 30ms
      },
      // Entered 100ms before the fence began.
      handlerEnteredAt: 400,
      ...clock,
    });
    expect(result.outcome).toBe('window_elapsed');
    const deadline = 400 + fence.windowMs;
    expect(readStarts.at(-1)).toBeGreaterThanOrEqual(deadline);
    // Every earlier read started before the deadline: no wasted extra read.
    expect(readStarts.slice(0, -1).every((t) => t < deadline)).toBe(true);
    // Bounded: capped backoff keeps the read count small.
    expect(result.reloads).toBeLessThan(12);
  });

  it('stops early when the hook is disposed while waiting (disposal race)', async () => {
    const clock = virtualClock();
    const events: Event[] = [hookCreated()];
    const result = await awaitHookResumeFence({
      fence,
      runId,
      getEvents: () => events,
      reload: async () => {
        events.push(
          ev({ eventType: 'hook_disposed', correlationId: fence.hookId })
        );
      },
      handlerEnteredAt: 0,
      ...clock,
    });
    expect(result).toMatchObject({ outcome: 'hook_disposed', reloads: 1 });
    expect(clock.now()).toBeLessThan(fence.windowMs);
  });

  it('reads once and stops for a zero window', async () => {
    const clock = virtualClock(10);
    const result = await awaitHookResumeFence({
      fence: { ...fence, windowMs: 0 },
      runId,
      getEvents: () => [hookCreated()],
      reload: async () => {},
      handlerEnteredAt: 0,
      ...clock,
    });
    expect(result).toMatchObject({ outcome: 'window_elapsed', reloads: 1 });
  });

  it('clamps an oversized window', async () => {
    expect(clampHookResumeFenceWindow(10 * 60_000)).toBe(
      HOOK_RESUME_FENCE_MAX_WINDOW_MS
    );
    expect(clampHookResumeFenceWindow(Number.NaN)).toBe(0);
    expect(clampHookResumeFenceWindow(-5)).toBe(0);

    const clock = virtualClock();
    const result = await awaitHookResumeFence({
      fence: { ...fence, windowMs: 10 * 60_000 },
      runId,
      getEvents: () => [hookCreated()],
      reload: async () => {},
      handlerEnteredAt: 0,
      ...clock,
    });
    expect(result.outcome).toBe('window_elapsed');
    expect(clock.now()).toBe(HOOK_RESUME_FENCE_MAX_WINDOW_MS);
  });

  it('propagates a read failure so the queue redelivers', async () => {
    const clock = virtualClock();
    await expect(
      awaitHookResumeFence({
        fence,
        runId,
        getEvents: () => [hookCreated()],
        reload: async () => {
          throw new Error('list failed');
        },
        handlerEnteredAt: 0,
        ...clock,
      })
    ).rejects.toThrow('list failed');
  });
});

describe('parallel hook wake gates', () => {
  const original = process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
  afterEach(() => {
    if (original === undefined) delete process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
    else process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = original;
  });

  it('is off by default and opt-in via the env var', () => {
    delete process.env[PARALLEL_HOOK_WAKE_ENV_VAR];
    expect(isParallelHookWakeEnabled()).toBe(false);
    process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = '1';
    expect(isParallelHookWakeEnabled()).toBe(true);
    process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = 'true';
    expect(isParallelHookWakeEnabled()).toBe(true);
    process.env[PARALLEL_HOOK_WAKE_ENV_VAR] = '0';
    expect(isParallelHookWakeEnabled()).toBe(false);
  });

  it('requires a fence-aware target runtime', () => {
    expect(runSupportsHookResumeFence(undefined)).toBe(false);
    expect(runSupportsHookResumeFence(1)).toBe(false);
    expect(runSupportsHookResumeFence(2)).toBe(true);
    expect(runSupportsHookResumeFence(3)).toBe(true);
  });

  it('insures writes at or above half the window', () => {
    expect(parallelHookWakeNeedsInsurance(80, 1_000)).toBe(false);
    expect(parallelHookWakeNeedsInsurance(499, 1_000)).toBe(false);
    expect(parallelHookWakeNeedsInsurance(500, 1_000)).toBe(true);
    expect(parallelHookWakeNeedsInsurance(Number.NaN, 1_000)).toBe(true);
  });
});
