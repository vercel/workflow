import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { registerLifecycleHooks } from './lifecycle-hooks.js';
import {
  handleReplayBudgetExhausted,
  ReplayBudget,
  ReplayTimeoutRetryError,
} from './replay-budget.js';
import { getWorld } from './world.js';

vi.mock('./world.js', () => ({
  getWorld: vi.fn(),
}));

// Partial mock: the lifecycle-hook registry pulls in `run.ts` (for the Run
// instance handed to handlers), whose import chain needs the real module's
// other exports (e.g. SerializationFormat).
vi.mock(import('../serialization.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  dehydrateRunError: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('./helpers.js', () => ({
  memoizeEncryptionKey: () => async () => undefined,
}));

// Capture lifecycle-hook dispatch work (scheduled via waitUntil) so tests
// can await it deterministically.
const waitUntilPromises: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
  },
}));

/**
 * Await everything the lifecycle dispatcher scheduled through waitUntil.
 * The dispatcher resolves a dynamic import before handing the promise to
 * waitUntil, so yield to the macrotask queue until the capture lands.
 */
async function flushLifecycleDispatches(): Promise<void> {
  for (let i = 0; i < 10 && waitUntilPromises.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(waitUntilPromises);
}

describe('ReplayBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts unpaused; elapsed time counts toward budget', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(500);
    expect(budget.elapsed()).toBe(500);
    expect(budget.isExhausted()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(budget.elapsed()).toBe(1000);
    expect(budget.isExhausted()).toBe(true);
  });

  it('pause() stops counting; resume() resumes', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(300);
    expect(budget.elapsed()).toBe(300);
    budget.pause();
    vi.advanceTimersByTime(10_000);
    // Time during pause is not charged
    expect(budget.elapsed()).toBe(300);
    expect(budget.isExhausted()).toBe(false);
    budget.resume();
    vi.advanceTimersByTime(700);
    expect(budget.elapsed()).toBe(1000);
    expect(budget.isExhausted()).toBe(true);
  });

  it('pause() is idempotent — calling twice does not double-count', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(400);
    budget.pause();
    // Second pause is a no-op
    budget.pause();
    vi.advanceTimersByTime(5_000);
    budget.resume();
    vi.advanceTimersByTime(100);
    expect(budget.elapsed()).toBe(500);
  });

  it('resume() is idempotent in the sense that back-to-back resumes do not skew elapsed', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(200);
    budget.pause();
    vi.advanceTimersByTime(100);
    budget.resume();
    budget.resume(); // no-op since no time has passed
    vi.advanceTimersByTime(100);
    expect(budget.elapsed()).toBe(300);
  });

  it('handles multiple pause/resume cycles (e.g. multiple inline steps)', () => {
    const budget = new ReplayBudget(10_000);

    // Initial non-step interval
    vi.advanceTimersByTime(100);
    expect(budget.elapsed()).toBe(100);

    // Step 1
    budget.pause();
    vi.advanceTimersByTime(60_000); // long step
    budget.resume();

    // More non-step work
    vi.advanceTimersByTime(200);

    // Step 2
    budget.pause();
    vi.advanceTimersByTime(30_000);
    budget.resume();

    // Final non-step work
    vi.advanceTimersByTime(300);

    // 100 + 200 + 300 = 600ms charged, 90s of step time excluded
    expect(budget.elapsed()).toBe(600);
    expect(budget.isExhausted()).toBe(false);
  });

  it('configuredLimitMs returns the configured limit', () => {
    const budget = new ReplayBudget(12_345);
    expect(budget.configuredLimitMs).toBe(12_345);
  });

  it('isExhausted() reflects current state including the open interval', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(999);
    expect(budget.isExhausted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(budget.isExhausted()).toBe(true);
  });

  it('isExhausted() does not advance while paused', () => {
    const budget = new ReplayBudget(1000);
    vi.advanceTimersByTime(500);
    budget.pause();
    vi.advanceTimersByTime(60_000); // simulate very long step
    expect(budget.isExhausted()).toBe(false);
    budget.resume();
    vi.advanceTimersByTime(499);
    expect(budget.isExhausted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(budget.isExhausted()).toBe(true);
  });

  it('regression: 8-minute step does not exhaust default budget', () => {
    // Reproduces the user scenario from
    // https://github.com/vercel/workflow/issues/2009 — an 8-minute step
    // under the default 240s budget should not trip exhaustion because
    // step time is excluded from the budget.
    const budget = new ReplayBudget(240_000);
    // 100ms of non-step work (event load, replay setup)
    vi.advanceTimersByTime(100);
    // Step body: 8 minutes
    budget.pause();
    vi.advanceTimersByTime(8 * 60 * 1000);
    budget.resume();
    // A bit more non-step work (write result event)
    vi.advanceTimersByTime(50);
    expect(budget.isExhausted()).toBe(false);
    expect(budget.elapsed()).toBe(150);
  });
});

describe('handleReplayBudgetExhausted', () => {
  let mockEventsCreate: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  function makeMockWorld(): World {
    return {
      events: { create: mockEventsCreate },
    } as unknown as World;
  }

  beforeEach(() => {
    mockEventsCreate = vi.fn().mockResolvedValue({});
    // `process.exit` would terminate vitest. Throw a sentinel instead so
    // the test can observe the exit attempt without crashing.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_process_exit__:${code}`);
    }) as never);

    // Silence the run-scoped logger; tests don't introspect its calls.
    const noopLogger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      forRun: vi.fn(),
      child: vi.fn(),
    };
    noopLogger.forRun.mockReturnValue(noopLogger);
    noopLogger.child.mockReturnValue(noopLogger);
    vi.spyOn(runtimeLogger, 'forRun').mockReturnValue(noopLogger as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects the current delivery without writing run_failed on early attempts', async () => {
    await expect(
      handleReplayBudgetExhausted({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: undefined,
        attempt: 1,
        limitMs: 240_000,
      })
    ).rejects.toBeInstanceOf(ReplayTimeoutRetryError);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(getWorld).not.toHaveBeenCalled();
    expect(mockEventsCreate).not.toHaveBeenCalled();
  });

  it('writes run_failed and completes the terminal delivery', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld());

    await handleReplayBudgetExhausted({
      runId: 'wrun_test',
      workflowName: 'wf',
      requestId: 'req_test',
      attempt: 4,
      limitMs: 240_000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockEventsCreate).toHaveBeenCalledTimes(1);
    expect(mockEventsCreate.mock.calls[0][1].eventType).toBe('run_failed');
    expect(mockEventsCreate.mock.calls[0][1].eventData.errorCode).toBe(
      'REPLAY_TIMEOUT'
    );
  });

  it('rejects the terminal delivery when run_failed cannot be written', async () => {
    const writeError = new Error('storage unavailable');
    mockEventsCreate.mockRejectedValue(writeError);
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld());

    await expect(
      handleReplayBudgetExhausted({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: 'req_test',
        attempt: 4,
        limitMs: 240_000,
      })
    ).rejects.toBe(writeError);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fires onRunFailed lifecycle hooks after the terminal write lands, and not on write failure', async () => {
    const onRunFailed = vi.fn();
    const unregister = registerLifecycleHooks({ onRunFailed });
    try {
      // Write failure: no dispatch.
      mockEventsCreate.mockRejectedValueOnce(new Error('storage unavailable'));
      vi.mocked(getWorld).mockResolvedValue(makeMockWorld());
      await expect(
        handleReplayBudgetExhausted({
          runId: 'wrun_test',
          workflowName: 'wf',
          requestId: 'req_test',
          attempt: 4,
          limitMs: 240_000,
        })
      ).rejects.toThrow('storage unavailable');
      // Give a (buggy) schedule a chance to land before asserting none did.
      await new Promise((resolve) => setImmediate(resolve));
      expect(waitUntilPromises).toHaveLength(0);
      expect(onRunFailed).not.toHaveBeenCalled();

      // Successful write: dispatch with the Run and classified error.
      await handleReplayBudgetExhausted({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: 'req_test',
        attempt: 4,
        limitMs: 240_000,
      });
      await flushLifecycleDispatches();

      expect(onRunFailed).toHaveBeenCalledTimes(1);
      const { run, error } = onRunFailed.mock.calls[0][0];
      expect(run.runId).toBe('wrun_test');
      expect(error.errorCode).toBe('REPLAY_TIMEOUT');
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain(
        'exceeded maximum duration'
      );
    } finally {
      unregister();
      waitUntilPromises.length = 0;
    }
  });
});
