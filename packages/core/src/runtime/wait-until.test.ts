import { describe, expect, it, vi } from 'vitest';
import {
  isExpectedClientDisconnectError,
  safeWaitUntil,
  waitForBackgroundOps,
} from './wait-until';

describe('safeWaitUntil', () => {
  it('invokes onError for unexpected rejections instead of letting the promise reject', async () => {
    const onError = vi.fn();
    const err = new Error('boom');
    // If safeWaitUntil let the rejection escape, vitest would flag an
    // unhandled rejection and fail the test run.
    safeWaitUntil(Promise.reject(err), onError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('ignores expected client-disconnect errors', async () => {
    const onError = vi.fn();
    const abortError = new Error('client disconnected');
    abortError.name = 'AbortError';
    safeWaitUntil(Promise.reject(abortError), onError);
    const responseAborted = new Error('response aborted');
    responseAborted.name = 'ResponseAborted';
    safeWaitUntil(Promise.reject(responseAborted), onError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not invoke onError when the promise resolves', async () => {
    const onError = vi.fn();
    safeWaitUntil(Promise.resolve('ok'), onError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).not.toHaveBeenCalled();
  });

  it('identifies expected client-disconnect errors', () => {
    const abortError = new Error('client disconnected');
    abortError.name = 'AbortError';
    const responseAborted = new Error('response aborted');
    responseAborted.name = 'ResponseAborted';

    expect(isExpectedClientDisconnectError(abortError)).toBe(true);
    expect(isExpectedClientDisconnectError(responseAborted)).toBe(true);
    expect(isExpectedClientDisconnectError(new Error('boom'))).toBe(false);
    expect(isExpectedClientDisconnectError(undefined)).toBe(false);
  });
});

describe('waitForBackgroundOps', () => {
  it('returns true when work settles inside the timeout', async () => {
    const onError = vi.fn();
    await expect(
      waitForBackgroundOps(Promise.resolve('ok'), { onError, timeoutMs: 50 })
    ).resolves.toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('returns false when work is still pending after the timeout', async () => {
    const onError = vi.fn();
    await expect(
      waitForBackgroundOps(new Promise(() => {}), { onError, timeoutMs: 1 })
    ).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces quick unexpected failures while keeping waitUntil safe', async () => {
    const onError = vi.fn();
    const err = new Error('boom');

    await expect(
      waitForBackgroundOps(Promise.reject(err), { onError, timeoutMs: 50 })
    ).rejects.toBe(err);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(err);
  });
});
