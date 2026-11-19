import { WorkflowWorldError } from '@workflow/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryableWorldError } from '../../classify-error.js';
import {
  DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS,
  getOrchestratorReadTimeoutMs,
  ORCHESTRATOR_READ_ATTEMPTS,
  readWithDeadline,
} from './read-deadline.js';

const TIMEOUT_MS = 100;
const options = { timeoutMs: TIMEOUT_MS, label: 'read', runId: 'wrun_x' };
const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('readWithDeadline', () => {
  it('returns the first attempt that answers in time', async () => {
    vi.useFakeTimers();
    const signals: (AbortSignal | undefined)[] = [];
    const read = vi.fn((signal: AbortSignal | undefined) => {
      signals.push(signal);
      return signals.length === 1 ? never() : Promise.resolve('page');
    });
    const result = readWithDeadline(read, options);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(result).resolves.toBe('page');
    expect(read).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('gives each later attempt twice the time of the one before', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const startedAt: number[] = [];
    const result = readWithDeadline(() => {
      calls++;
      startedAt.push(Date.now());
      return never();
    }, options);
    const settled = result.catch((error: unknown) => error);
    let total = 0;
    for (let attempt = 0; attempt < ORCHESTRATOR_READ_ATTEMPTS; attempt++) {
      total += TIMEOUT_MS * 2 ** attempt;
    }
    await vi.advanceTimersByTimeAsync(total);
    const error = await settled;

    expect(calls).toBe(ORCHESTRATOR_READ_ATTEMPTS);
    const gaps = startedAt.slice(1).map((t, i) => t - (startedAt[i] ?? 0));
    expect(gaps).toEqual(gaps.map((_, i) => TIMEOUT_MS * 2 ** i));
    // Out of attempts: a retryable World error, so the delivery is
    // redelivered instead of failing the run.
    expect(WorkflowWorldError.is(error)).toBe(true);
    expect(isRetryableWorldError(error)).toBe(true);
  });

  it('fails at once on a read that fails on its own', async () => {
    const failure = new Error('boom');
    const read = vi.fn(() => Promise.reject(failure));
    await expect(readWithDeadline(read, options)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('drops the outcome of an abandoned attempt', async () => {
    vi.useFakeTimers();
    let rejectFirst: ((error: Error) => void) | undefined;
    const read = vi.fn(() =>
      read.mock.calls.length === 1
        ? new Promise<string>((_, reject) => {
            rejectFirst = reject;
          })
        : new Promise<string>((resolve) =>
            setTimeout(() => resolve('second'), TIMEOUT_MS)
          )
    );
    const result = readWithDeadline(read, options);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    // The abandoned attempt fails while the retry is in flight.
    rejectFirst?.(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(result).resolves.toBe('second');
  });

  it('runs the read once, without a signal, when the deadline is off', async () => {
    const read = vi.fn(() => Promise.resolve('page'));
    await expect(
      readWithDeadline(read, { ...options, timeoutMs: 0 })
    ).resolves.toBe('page');
    expect(read).toHaveBeenCalledWith(undefined);
  });

  it('reads the timeout from the environment', () => {
    expect(getOrchestratorReadTimeoutMs({})).toBe(
      DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS
    );
    expect(
      getOrchestratorReadTimeoutMs({
        WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS: '250',
      })
    ).toBe(250);
    expect(
      getOrchestratorReadTimeoutMs({
        WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS: '0',
      })
    ).toBe(0);
    expect(
      getOrchestratorReadTimeoutMs({
        WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS: 'nope',
      })
    ).toBe(DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS);
  });
});
