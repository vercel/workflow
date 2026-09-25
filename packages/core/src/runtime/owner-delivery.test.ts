import { WorkflowRuntimeError, WorkflowWorldError } from '@workflow/errors';
import { afterEach, expect, it, vi } from 'vitest';
import {
  isRetryableOwnerDelivery,
  retryOwnerDelivery,
} from './owner-delivery.js';

afterEach(() => vi.useRealTimers());

it('backs off transient/unknown outcomes with a bounded per-call timeout', async () => {
  vi.useFakeTimers();
  const calls: number[] = [];
  const attempt = vi.fn(async (timeout: number) => {
    calls.push(Date.now());
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(30_000);
    if (calls.length === 1)
      throw new WorkflowWorldError('Back off', { status: 503 });
    if (calls.length === 2)
      throw new WorkflowWorldError('Lost response', {
        code: 'INVOCATION_OUTCOME_UNKNOWN',
      });
    return 'accepted';
  });
  const work = retryOwnerDelivery(Date.now() + 60_000, attempt);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await work).toBe('accepted');
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(50);
  expect(calls[2] - calls[1]).toBeGreaterThanOrEqual(100);
});

it('stops at the attempt deadline rather than renewing the retry budget', async () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 500;
  const failure = new WorkflowWorldError('Back off', { status: 503 });
  const attempt = vi.fn(async (timeout: number) => {
    expect(timeout).toBeLessThanOrEqual(deadline - Date.now());
    throw failure;
  });
  const work = retryOwnerDelivery(deadline, attempt);
  const rejected = expect(work).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  const calls = attempt.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempt).toHaveBeenCalledTimes(calls);
});

it('treats every 5xx as an unknown outcome', () => {
  for (const status of [500, 502, 503, 504])
    expect(
      isRetryableOwnerDelivery(new WorkflowWorldError('x', { status }))
    ).toBe(true);
});

it('does not retry definite rejection or a terminal runner fault', async () => {
  const errors = [
    new WorkflowWorldError('Invalid input', { status: 400 }),
    new WorkflowWorldError('Conflict', { status: 409 }),
    new WorkflowWorldError('Ended', { status: 410 }),
    new WorkflowRuntimeError('Retained runner failed'),
  ];
  for (const error of errors) {
    expect(isRetryableOwnerDelivery(error)).toBe(false);
    const deliver = vi.fn(async () => {
      throw error;
    });
    await expect(retryOwnerDelivery(Date.now() + 1000, deliver)).rejects.toBe(
      error
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  }
});

it('reports each failed attempt before retrying the identical delivery', async () => {
  vi.useFakeTimers();
  const retries: { attempt: number; retryInMs: number; status?: number }[] = [];
  let calls = 0;
  const work = retryOwnerDelivery(
    Date.now() + 60_000,
    async () => {
      if (++calls < 3)
        throw new WorkflowWorldError('Back off', { status: 503 });
      return 'ok';
    },
    ({ attempt, error, retryInMs }) =>
      retries.push({
        attempt,
        retryInMs,
        status: (error as WorkflowWorldError).status,
      })
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await work).toBe('ok');
  expect(retries.map((r) => [r.attempt, r.status])).toEqual([
    [1, 503],
    [2, 503],
  ]);
  expect(retries.every((r) => r.retryInMs >= 0)).toBe(true);
});
