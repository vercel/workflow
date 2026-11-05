import {
  EntityConflictError,
  RunExpiredError,
  StreamError,
  StreamExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getDeadline } from './get-deadline.js';
import {
  describeTransportFailure,
  errorForResponse,
  formatVercelDiagnostics,
  getRequestTimeoutMs,
  getTransientTransportCode,
  getVercelDiagnostics,
  type InstrumentedFetchOptions,
  instrumentedFetch,
  parseRetryAfter,
  REQUEST_TIMEOUT_MS,
  resolveVercelApiToken,
} from './http-core.js';
import { trace } from './telemetry.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

describe('getRequestTimeoutMs', () => {
  const envName = 'WORKFLOW_REQUEST_TIMEOUT_MS';
  const original = process.env[envName];

  afterEach(() => {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  });

  it('uses the default when unset', () => {
    delete process.env[envName];
    expect(getRequestTimeoutMs()).toBe(REQUEST_TIMEOUT_MS);
  });

  it('honors a value inside the clamp', () => {
    process.env[envName] = '30000';
    expect(getRequestTimeoutMs()).toBe(30_000);
  });

  it('clamps up to the floor', () => {
    // Below ~10s the deadline cancels requests that would have succeeded (a
    // cold route, a large event page), and a cancelled request is redriven
    // through the queue instead of making progress.
    process.env[envName] = '500';
    expect(getRequestTimeoutMs()).toBe(10_000);
  });

  it('clamps down to the ceiling', () => {
    // Beyond 120s a hung request outlives the callers this deadline protects.
    // Paths that legitimately run longer pass `timeoutMs: null` instead.
    process.env[envName] = '600000';
    expect(getRequestTimeoutMs()).toBe(120_000);
  });

  it('leaves the long poll a usable budget at the default', () => {
    // The run-status wait asks for this minus 10s of headroom, so the default
    // must stay comfortably above the floor or long polling disables itself.
    delete process.env[envName];
    expect(getRequestTimeoutMs() - 10_000).toBeGreaterThan(0);
  });

  it('disables the long-poll budget at exactly the floor', () => {
    // Documented consequence rather than an accident: 10s is the value at
    // which long polling turns itself off, not one where it half-works.
    process.env[envName] = '10000';
    expect(getRequestTimeoutMs() - 10_000).toBe(0);
  });
});

describe('errorForResponse', () => {
  // The runtime branches on these typed errors for core control flow, so the
  // v3 and v4 paths must map status codes to the same types — this is the
  // single source they both delegate to.
  it('maps 409 to EntityConflictError', () => {
    expect(errorForResponse(409, 'boom')).toBeInstanceOf(EntityConflictError);
  });

  it('maps an unstructured 410 to RunExpiredError', () => {
    expect(errorForResponse(410, 'boom')).toBeInstanceOf(RunExpiredError);
  });

  it('maps a stream-expired 410 to StreamExpiredError with its details', () => {
    const err = errorForResponse(410, 'stream expired', {
      code: 'stream-expired',
      details: {
        runId: 'wrun_test',
        streamId: 'stream-test',
        expiredAt: '2026-08-10T14:40:00.000Z',
      },
    });

    expect(err).toMatchObject({
      name: 'StreamExpiredError',
      runId: 'wrun_test',
      streamId: 'stream-test',
      expiredAt: new Date('2026-08-10T14:40:00.000Z'),
    });
    expect(err).toBeInstanceOf(StreamExpiredError);
  });

  it('maps 425 to TooEarlyError carrying retryAfter', () => {
    const err = errorForResponse(425, 'too early', { retryAfter: 7 });
    expect(err).toBeInstanceOf(TooEarlyError);
    expect((err as TooEarlyError).retryAfter).toBe(7);
  });

  it('maps 429 to ThrottleError carrying retryAfter', () => {
    const err = errorForResponse(429, 'slow down', { retryAfter: 30 });
    expect(err).toBeInstanceOf(ThrottleError);
    expect((err as ThrottleError).retryAfter).toBe(30);
  });

  it('maps other statuses to WorkflowWorldError with status/code', () => {
    const err = errorForResponse(404, 'not found', {
      code: 'not_found',
      url: 'http://x',
    });
    expect(err).toBeInstanceOf(WorkflowWorldError);
    expect((err as WorkflowWorldError).status).toBe(404);
    expect((err as WorkflowWorldError).code).toBe('not_found');
    expect(err.message).toBe('not found');
  });

  it('treats 5xx as WorkflowWorldError (retryable, not a typed terminal)', () => {
    const err = errorForResponse(503, 'unavailable');
    expect(err).toBeInstanceOf(WorkflowWorldError);
    expect((err as WorkflowWorldError).status).toBe(503);
  });
});

describe('instrumentedFetch URL validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    'TRANSPORT',
    'STREAM_ERROR',
  ] as const)('preserves Fetch port-blocking errors instead of wrapping them as %s', async (transportErrorCode) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    // Use real Fetch: Request construction accepts this URL, but Fetch
    // rejects it locally with a code-less `Error: bad port` cause.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rejection = await instrumentedFetch({
      method: 'GET',
      url: 'http://127.0.0.1:21/events',
      headers: new Headers(),
      peerService: 'workflow-server',
      transportErrorCode,
    }).catch((error: unknown) => error);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(fetchSpy.mock.results[0].value).rejects.toBe(rejection);
    expect(rejection).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      cause: { message: 'bad port' },
    });
    expect(WorkflowWorldError.is(rejection)).toBe(false);
  });

  it.each([
    ['TRANSPORT', { Expect: '100-continue' }, 'UND_ERR_NOT_SUPPORTED'],
    ['STREAM_ERROR', { Expect: '100-continue' }, 'UND_ERR_NOT_SUPPORTED'],
    // Undici rejects Transfer-Encoding during dispatch on every supported
    // Node line. (It stopped rejecting `Connection: invalid` in 7.29 / Node
    // 24.21, which then fails at connect time instead.)
    ['TRANSPORT', { 'Transfer-Encoding': 'chunked' }, 'UND_ERR_INVALID_ARG'],
    ['STREAM_ERROR', { 'Transfer-Encoding': 'chunked' }, 'UND_ERR_INVALID_ARG'],
  ] as const)('preserves %s request-validation errors for %j', async (transportErrorCode, headers, code) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rejection = await instrumentedFetch({
      method: 'GET',
      url: 'http://127.0.0.1:12345/events',
      headers: new Headers(headers),
      transportErrorCode,
    }).catch((error: unknown) => error);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(fetchSpy.mock.results[0].value).rejects.toBe(rejection);
    expect(rejection).toMatchObject({ name: 'TypeError', cause: { code } });
    expect(WorkflowWorldError.is(rejection)).toBe(false);
  });

  it.each([
    '0',
    '1',
  ])('rejects unsupported protocols before dispatch (WORKFLOW_NODE_HTTP=%s)', async (mode) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, mode);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onTransportOutcome = vi.fn();
    const onRequestDispatched = vi.fn();

    await expect(
      instrumentedFetch({
        method: 'GET',
        url: 'ftp://localhost/events',
        headers: new Headers(),
        peerService: 'workflow-server',
        onTransportOutcome,
        onRequestDispatched,
      })
    ).rejects.toThrow(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTransportOutcome).not.toHaveBeenCalled();
    expect(onRequestDispatched).not.toHaveBeenCalled();
  });

  it.each([
    '0',
    '1',
  ])('rejects embedded URL credentials before dispatch (WORKFLOW_NODE_HTTP=%s)', async (mode) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, mode);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onTransportOutcome = vi.fn();
    const onRequestDispatched = vi.fn();

    await expect(
      instrumentedFetch({
        method: 'GET',
        url: 'http://user:password@localhost/events',
        headers: new Headers(),
        peerService: 'workflow-server',
        onTransportOutcome,
        onRequestDispatched,
      })
    ).rejects.toThrow('HTTP(S) URLs with embedded credentials are unsupported');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTransportOutcome).not.toHaveBeenCalled();
    expect(onRequestDispatched).not.toHaveBeenCalled();
  });
});

describe('instrumentedFetch stream append retries', () => {
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

  function rejected(retryAfter?: string, body = 'rate limited') {
    return new Response(body, {
      status: 429,
      headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
    });
  }

  beforeAll(async () => {
    // Complete the optional telemetry import before advancing a fake clock.
    await trace('append policy test setup', async () => {});
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('WORKFLOW_NODE_HTTP', '0');
    vi.mocked(getDeadline).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ['seconds', '2', 2000],
    ['date', new Date(NOW + 4000).toUTCString(), 4000],
    ['missing', undefined, 1000],
  ])('uses the throttle policy for %s Retry-After', async (_label, value, delay) => {
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

  it('surfaces Retry-After beyond the wait budget without retrying early', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rejected('3600'))
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(NOW);
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('rate limited'),
    });
  });

  it('stops after five retries even when throttle wait budget remains', async () => {
    let attempts = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => rejected('1', `rejection ${++attempts}`));
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(Date.now() - NOW).toBe(5000);
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('rejection 6'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('bounds retries for pre-connect failure %s and preserves the final cause', async (code) => {
    const cause = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection failed'), { code }),
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(Date.now() - NOW).toBe(15_500);
    expect(await outcome).toMatchObject({ code: 'STREAM_ERROR', cause });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds cumulative throttle waits and preserves the final rejection body', async () => {
    let attempts = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        rejected('10', `rejection ${++attempts}`)
      );
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(Date.now() - NOW).toBe(30_000);
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('rejection 4'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces a 429 when its wait would use the invocation deadline reserve', async () => {
    vi.mocked(getDeadline).mockResolvedValue(new Date(NOW + 17_000));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => rejected('3'));
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(NOW);
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining('rate limited'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      'retry error without a response',
      Object.assign(new Error('misleading 429'), {
        code: 'UND_ERR_REQ_RETRY',
        statusCode: 429,
      }),
    ],
    ...['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].map((code) => [
      code,
      new TypeError('fetch failed', {
        cause: Object.assign(new Error(code), { code }),
      }),
    ]),
  ])('does not retry transport failures: %s', async (_label, cause) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const outcome = append().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(StreamError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a transport failure after a confirmed rejection', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rejected('1'))
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
      { status: 429, headers: { 'Retry-After': '1' } }
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

  it('cancels a retry wait when the caller aborts', async () => {
    const controller = new AbortController();
    const response = rejected('30');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const outcome = append({ signal: controller.signal }).catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(response.bodyUsed).toBe(true);
    const reason = new DOMException('Request cancelled', 'AbortError');
    controller.abort(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(await outcome).toMatchObject({
      code: 'STREAM_ERROR',
      cause: reason,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cache-busting header on retries but reports dispatch only once', async () => {
    const requestTimes: (string | null)[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, options) => {
        requestTimes.push(new Headers(options?.headers).get('X-Request-Time'));
        return requestTimes.length === 1 ? rejected('1') : new Response(null);
      });
    vi.stubGlobal('fetch', fetch);
    const onRequestDispatched = vi.fn();
    const result = append({ onRequestDispatched });
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(true);
    expect(requestTimes).toEqual([String(NOW), String(NOW + 1000)]);
    expect(onRequestDispatched).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no dispatcher is configured', { dispatcher: undefined }],
    ['the method is POST', { method: 'POST' }],
  ] as const)('does not retry when %s', async (_label, overrides) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(rejected('1'));
    vi.stubGlobal('fetch', fetch);
    const outcome = append(overrides).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(ThrottleError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('describeTransportFailure', () => {
  it('reports the allowlisted code when the cause chain carries one', () => {
    // Known codes keep naming themselves, so messages and the
    // `UND_ERR_CONNECT_TIMEOUT` retry branch in makeRequest are unchanged.
    const cause = Object.assign(new Error('Request failed'), {
      code: 'UND_ERR_REQ_RETRY',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeTransportFailure(err)).toBe('UND_ERR_REQ_RETRY');
    expect(getTransientTransportCode(err)).toBe('UND_ERR_REQ_RETRY');
  });

  it.each([
    ['an h2 session error', 'ERR_HTTP2_GOAWAY_SESSION'],
    ['an unreachable network', 'ENETUNREACH'],
    ['a TLS handshake failure', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  ])('reports %s the allowlist has never seen', (_label, code) => {
    // These are the failures the allowlist misses today. Each one still means
    // no response was produced, so each one is a transport failure.
    const cause = Object.assign(new Error('nope'), { code });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(getTransientTransportCode(err)).toBeUndefined();
    expect(describeTransportFailure(err)).toBe(code);
  });

  it('falls back to the innermost error name when no code is present', () => {
    // A happy-eyeballs connect rejects with an AggregateError whose codes live
    // on `errors[]`, out of reach of a `cause` walk.
    const cause = new AggregateError([new Error('ECONNREFUSED')], '');
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeTransportFailure(err)).toBe('AggregateError');
  });

  it('describes a bare `TypeError: fetch failed`', () => {
    expect(describeTransportFailure(new TypeError('fetch failed'))).toBe(
      'TypeError'
    );
  });

  it.each([
    ['a malformed URL', 'ERR_INVALID_URL'],
    ['an invalid header value', 'ERR_HTTP_INVALID_HEADER_VALUE'],
    ['a bad argument', 'ERR_INVALID_ARG_TYPE'],
  ])('returns undefined for %s', (_label, code) => {
    // The request was never formed. Redelivering it just re-forms the same
    // broken request until the run runs out of deliveries.
    const cause = Object.assign(new TypeError('Invalid URL'), { code });
    const err = Object.assign(new TypeError('Failed to parse URL from x'), {
      cause,
    });
    expect(describeTransportFailure(err)).toBeUndefined();
  });

  it('stops walking a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(describeTransportFailure(err)).toBe('Error');
  });
});

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  it('parses HTTP dates relative to the current time', () => {
    const now = Date.UTC(2026, 9, 11, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(parseRetryAfter(new Date(now + 30_000).toUTCString())).toBe(30);
      expect(parseRetryAfter(new Date(now - 30_000).toUTCString())).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('returns undefined for missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('vercel diagnostics', () => {
  function headers(init: Record<string, string>): Headers {
    return new Headers(init);
  }

  it('extracts x-vercel-id and x-vercel-error when present', () => {
    const h = headers({
      'x-vercel-id': 'sfo1::abc',
      'x-vercel-error': 'FUNCTION_INVOCATION_FAILED',
    });
    expect(getVercelDiagnostics(h)).toEqual([
      'x-vercel-id=sfo1::abc',
      'x-vercel-error=FUNCTION_INVOCATION_FAILED',
    ]);
    expect(formatVercelDiagnostics(h)).toBe(
      ' (x-vercel-id=sfo1::abc; x-vercel-error=FUNCTION_INVOCATION_FAILED)'
    );
  });

  it('skips absent headers and formats nothing when none present', () => {
    const h = headers({ 'x-vercel-id': 'sfo1::abc' });
    expect(getVercelDiagnostics(h)).toEqual(['x-vercel-id=sfo1::abc']);
    expect(formatVercelDiagnostics(headers({}))).toBe('');
  });
});

describe('resolveVercelApiToken', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('prefers an explicit token over env and OIDC', async () => {
    process.env = { ...originalEnv, VERCEL_TOKEN: 'env-token' };
    expect(await resolveVercelApiToken({ token: 'explicit' })).toBe('explicit');
  });

  it('falls back to VERCEL_TOKEN when no explicit token', async () => {
    process.env = { ...originalEnv, VERCEL_TOKEN: 'env-token' };
    expect(await resolveVercelApiToken()).toBe('env-token');
  });

  it('falls back to null when OIDC is unavailable and no token/env', async () => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_TOKEN;
    expect(await resolveVercelApiToken()).toBeNull();
  });
});
