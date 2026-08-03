import { describe, expect, it, vi } from 'vitest';
import { safeWaitUntil } from './wait-until';

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
});
