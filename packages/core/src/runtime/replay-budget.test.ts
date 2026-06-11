import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { handleReplayBudgetExhausted, ReplayBudget } from './replay-budget.js';
import { getWorld } from './world.js';

vi.mock('./world.js', () => ({
  getWorld: vi.fn(),
}));

vi.mock('../serialization.js', () => ({
  dehydrateRunError: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('./helpers.js', () => ({
  memoizeEncryptionKey: () => async () => undefined,
}));

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

  function makeMockWorld(
    processExitTriggersQueueRedelivery: boolean | undefined
  ): World {
    return {
      processExitTriggersQueueRedelivery,
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

  it('does not call process.exit when World does not support exit-for-redelivery (in-process world)', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld(false));

    await handleReplayBudgetExhausted({
      runId: 'wrun_test',
      workflowName: 'wf',
      requestId: undefined,
      attempt: 1,
      limitMs: 30_000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    // run_failed event should be written best-effort
    expect(mockEventsCreate).toHaveBeenCalledTimes(1);
    expect(mockEventsCreate.mock.calls[0][1].eventType).toBe('run_failed');
  });

  it('does not call process.exit when World omits the capability (default = false)', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld(undefined));

    await handleReplayBudgetExhausted({
      runId: 'wrun_test',
      workflowName: 'wf',
      requestId: undefined,
      attempt: 5,
      limitMs: 30_000,
    });

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits without writing run_failed on early attempts when World supports exit-for-redelivery', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld(true));

    await expect(
      handleReplayBudgetExhausted({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: undefined,
        attempt: 1,
        limitMs: 240_000,
      })
    ).rejects.toThrow('__test_process_exit__:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockEventsCreate).not.toHaveBeenCalled();
  });

  it('writes run_failed then exits on attempt > REPLAY_TIMEOUT_MAX_RETRIES (Vercel-style World)', async () => {
    vi.mocked(getWorld).mockResolvedValue(makeMockWorld(true));

    await expect(
      handleReplayBudgetExhausted({
        runId: 'wrun_test',
        workflowName: 'wf',
        requestId: 'req_test',
        attempt: 4,
        limitMs: 240_000,
      })
    ).rejects.toThrow('__test_process_exit__:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockEventsCreate).toHaveBeenCalledTimes(1);
    expect(mockEventsCreate.mock.calls[0][1].eventType).toBe('run_failed');
    expect(mockEventsCreate.mock.calls[0][1].eventData.errorCode).toBe(
      'REPLAY_TIMEOUT'
    );
  });
});
