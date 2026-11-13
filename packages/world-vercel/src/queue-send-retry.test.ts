import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_REQUEST_DEADLINE_CODE } from './http-client.js';
import {
  QUEUE_SEND_MAX_ATTEMPTS,
  QUEUE_SEND_RETRY_BUDGET_MS,
  queueSendRetryDelayMs,
  withQueueSendRetry,
} from './queue-send-retry.js';

/** What undici's `fetch` rejects with when a pooled socket was closed. */
function socketClosed(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    }),
  });
}

function connectionReset(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

function queueError(name: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(name), { name, ...extra });
}

describe('queueSendRetryDelayMs', () => {
  it.each([
    ['a closed pooled socket', socketClosed()],
    ['a connection reset', connectionReset()],
    [
      'the queue-request deadline',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('Queue request exceeded its deadline'), {
          code: QUEUE_REQUEST_DEADLINE_CODE,
        }),
      }),
    ],
    ['a 5xx', queueError('InternalServerError')],
    ['a consumer-discovery 502', queueError('ConsumerDiscoveryError')],
    ['a 429 without Retry-After', queueError('TooManyRequestsError')],
  ])('re-sends after %s', (_, error) => {
    expect(queueSendRetryDelayMs(error, 0)).toBeGreaterThan(0);
  });

  it.each([
    ['a 400', queueError('BadRequestError')],
    ['a 401', queueError('UnauthorizedError')],
    ['a 403', queueError('ForbiddenError')],
    ['a 413', queueError('PayloadTooLargeError')],
    ['an unclassified error', new Error('boom')],
    ['a request that was never formed', new TypeError('Invalid URL')],
  ])('does not re-send after %s', (_, error) => {
    expect(queueSendRetryDelayMs(error, 0)).toBeUndefined();
  });

  it("waits out a 429's Retry-After up to a ceiling", () => {
    expect(
      queueSendRetryDelayMs(
        queueError('TooManyRequestsError', { retryAfter: 2 }),
        0
      )
    ).toBeGreaterThanOrEqual(2000);
    expect(
      queueSendRetryDelayMs(
        queueError('TooManyRequestsError', { retryAfter: 60 }),
        0
      )
    ).toBeUndefined();
  });
});

describe('withQueueSendRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends a send whose socket was closed, and returns its result', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValueOnce({ messageId: 'msg-1' });
    const onRetry = vi.fn();

    const result = withQueueSendRetry(send, { onRetry });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ messageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('throws the last error once its attempts run out', async () => {
    const send = vi.fn().mockImplementation(async () => {
      throw connectionReset();
    });

    const result = withQueueSendRetry(send);
    const settled = expect(result).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();

    await settled;
    expect(send).toHaveBeenCalledTimes(QUEUE_SEND_MAX_ATTEMPTS);
  });

  it('sends once when the queue refused the message', async () => {
    const send = vi.fn().mockRejectedValue(queueError('BadRequestError'));

    await expect(withQueueSendRetry(send)).rejects.toThrow('BadRequestError');
    expect(send).toHaveBeenCalledOnce();
  });

  it('starts no retry past its budget', async () => {
    // A send that hangs until its deadline, every time.
    const send = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, QUEUE_SEND_RETRY_BUDGET_MS)
      );
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('deadline'), {
          code: QUEUE_REQUEST_DEADLINE_CODE,
        }),
      });
    });

    const result = withQueueSendRetry(send);
    const settled = expect(result).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();

    await settled;
    expect(send).toHaveBeenCalledOnce();
  });
});
