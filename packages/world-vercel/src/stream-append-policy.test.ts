import { StreamError, ThrottleError } from '@workflow/errors';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  type InstrumentedFetchOptions,
  instrumentedFetch,
} from './http-core.js';
import * as telemetry from './telemetry.js';

const NOW = Date.UTC(2026, 9, 7, 12);

function append(overrides: Partial<InstrumentedFetchOptions> = {}) {
  return instrumentedFetch({
    method: 'PUT',
    url: 'https://workflow.example/stream/test',
    headers: new Headers(),
    body: new Uint8Array([0, 128, 255]),
    dispatcher: {},
    retryStreamAppend: true,
    timeoutMs: null,
    transportErrorCode: 'STREAM_ERROR',
    ...overrides,
  });
}

function rejected(retryAfter?: string) {
  return new Response('rate limited', {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
  });
}

beforeAll(async () => {
  // Complete the optional telemetry import before advancing a fake clock.
  await telemetry.trace('append policy test setup', async () => {});
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('WORKFLOW_NODE_HTTP', '0');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fresh stream append retry policy', () => {
  it.each([
    ['seconds', '2', 2000],
    ['fractional seconds', '0.025', 25],
    ['date', new Date(NOW + 4000).toUTCString(), 4000],
    ['seconds cap', '999999', 30_000],
    ['date cap', new Date(NOW + 120_000).toUTCString(), 30_000],
    ['missing', undefined, 500],
    ['invalid', 'not-a-date', 500],
    ['zero', '0', 500],
    ['negative', '-2', 500],
    ['past date', new Date(NOW - 60_000).toUTCString(), 500],
  ])('honors bounded Retry-After: %s', async (_label, value, delay) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rejected(value))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = append();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off exponentially and stops after five retries with the final HTTP error', async () => {
    let attempts = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(`rejection ${++attempts}`, { status: 429 })
      );
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const [retry, delay] of [500, 1000, 2000, 4000, 8000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(retry + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(retry + 2);
    }
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('rejection 6'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new Error('code-less failure'),
    Object.assign(new Error('misleading 429'), {
      code: 'UND_ERR_REQ_RETRY',
      statusCode: 429,
    }),
  ])('never retries a thrown error: $message', async (cause) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    await expect(append()).rejects.toBeInstanceOf(StreamError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 503])('never retries an HTTP %s response', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('failed', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(append()).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a transport failure after a confirmed rejection', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rejected('0.001'))
      .mockRejectedValueOnce(new Error('response lost after retry'));
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(StreamError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('can retry a confirmed rejection whose diagnostic body already failed', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('truncated diagnostic body'));
        },
      }),
      { status: 429, headers: { 'Retry-After': '0.001' } }
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const result = append();
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'caller abort',
    'request deadline',
  ])('cancels backoff on %s without dispatching again or leaking a timer', async (source) => {
    const controller = new AbortController();
    const deadline = source === 'request deadline';
    // Control the native timeout signal without racing a real network deadline.
    if (deadline) {
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(rejected('30'));
    vi.stubGlobal('fetch', fetch);
    const outcome = append(
      deadline ? { timeoutMs: 100 } : { signal: controller.signal }
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const reason = new DOMException(
      'Request cancelled',
      deadline ? 'TimeoutError' : 'AbortError'
    );
    controller.abort(reason);
    expect(await outcome).toMatchObject({
      code: 'STREAM_ERROR',
      cause: reason,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch for an already-aborted signal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    await expect(
      append({ signal: AbortSignal.abort() })
    ).rejects.toBeInstanceOf(StreamError);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves trace context, dispatch notification, outcome reporting, and cache busting', async () => {
    const traceparent =
      '00-12345678901234567890123456789012-1234567890123456-01';
    const inject = vi
      .spyOn(telemetry, 'injectTraceContextIntoHeaders')
      .mockImplementation(async (headers) => {
        headers.set('traceparent', traceparent);
      });
    const requests: Headers[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, options) => {
        requests.push(new Headers(options?.headers));
        return requests.length === 1 ? rejected('0.001') : new Response(null);
      });
    vi.stubGlobal('fetch', fetch);
    const onRequestDispatched = vi.fn();
    const onTransportOutcome = vi.fn();
    const result = append({ onRequestDispatched, onTransportOutcome });
    await vi.runAllTimersAsync();
    const response = await result;
    expect(inject).toHaveBeenCalledTimes(1);
    expect(requests.map((headers) => headers.get('traceparent'))).toEqual([
      traceparent,
      traceparent,
    ]);
    expect(requests.map((headers) => headers.get('X-Request-Time'))).toEqual([
      String(NOW),
      String(NOW + 1),
    ]);
    expect(onRequestDispatched).toHaveBeenCalledTimes(1);
    expect(onTransportOutcome).toHaveBeenCalledExactlyOnceWith(
      undefined,
      response
    );
  });

  it.each([
    { retryStreamAppend: false },
    { dispatcher: undefined },
    { method: 'POST' },
  ])('requires explicit append opt-in on the default dispatcher: %j', async (overrides) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(rejected('0.001'));
    vi.stubGlobal('fetch', fetch);
    await expect(append(overrides)).rejects.toBeInstanceOf(ThrottleError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
