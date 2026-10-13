import {
  EntityConflictError,
  RunExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeTransportFailure,
  errorForResponse,
  fetchStreamAppend,
  formatVercelDiagnostics,
  getTransientTransportCode,
  getVercelDiagnostics,
  instrumentedFetch,
  parseRetryAfter,
  resolveVercelApiToken,
  STREAM_APPEND_DEADLINE_RESERVE_MS,
  streamAppendDeadlineReserveMs,
} from './http-core.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

describe('errorForResponse', () => {
  // The runtime branches on these typed errors for core control flow, so the
  // v3 and v4 paths must map status codes to the same types — this is the
  // single source they both delegate to.
  it('maps 409 to EntityConflictError', () => {
    expect(errorForResponse(409, 'boom')).toBeInstanceOf(EntityConflictError);
  });

  it('maps 410 to RunExpiredError', () => {
    expect(errorForResponse(410, 'boom')).toBeInstanceOf(RunExpiredError);
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

describe('getTransientTransportCode', () => {
  it('finds an HTTP/2 stream timeout in a fetch cause chain', () => {
    const cause = Object.assign(
      new Error('HTTP/2: "stream timeout after 300000"'),
      { code: 'UND_ERR_INFO' }
    );
    const error = new TypeError('fetch failed', { cause });

    expect(getTransientTransportCode(error)).toBe('UND_ERR_INFO');
  });

  it('ignores non-transport errors', () => {
    expect(getTransientTransportCode(new Error('bad payload'))).toBeUndefined();
  });
});

describe('instrumentedFetch URL validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('preserves Fetch port-blocking errors instead of wrapping them as TRANSPORT', async () => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    // Use real Fetch: Request construction accepts this URL, but Fetch
    // rejects it locally with a code-less `Error: bad port` cause.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rejection = await instrumentedFetch({
      method: 'GET',
      url: 'http://127.0.0.1:21/events',
      headers: new Headers(),
      dispatcher: undefined,
      peerService: 'workflow-server',
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
    [{ Expect: '100-continue' }, 'UND_ERR_NOT_SUPPORTED'],
    [{ Connection: 'invalid' }, 'UND_ERR_INVALID_ARG'],
  ] as const)('preserves request-validation errors for %j', async (headers, code) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rejection = await instrumentedFetch({
      method: 'GET',
      url: 'http://127.0.0.1:12345/events',
      headers: new Headers(headers),
      dispatcher: undefined,
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

    await expect(
      instrumentedFetch({
        method: 'GET',
        url: 'ftp://localhost/events',
        headers: new Headers(),
        dispatcher: undefined,
        peerService: 'workflow-server',
        onTransportOutcome,
      })
    ).rejects.toThrow(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTransportOutcome).not.toHaveBeenCalled();
  });

  it.each([
    '0',
    '1',
  ])('rejects embedded URL credentials before dispatch (WORKFLOW_NODE_HTTP=%s)', async (mode) => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, mode);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onTransportOutcome = vi.fn();

    await expect(
      instrumentedFetch({
        method: 'GET',
        url: 'http://user:password@localhost/events',
        headers: new Headers(),
        dispatcher: undefined,
        peerService: 'workflow-server',
        onTransportOutcome,
      })
    ).rejects.toThrow('HTTP(S) URLs with embedded credentials are unsupported');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTransportOutcome).not.toHaveBeenCalled();
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

  it('parses HTTP dates into whole seconds from now, rounding up', () => {
    const now = Date.UTC(2026, 9, 11, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(parseRetryAfter(new Date(now + 30_000).toUTCString())).toBe(30);
      expect(parseRetryAfter(new Date(now - 30_000).toUTCString())).toBe(0);
      clock.mockReturnValue(now - 500);
      expect(parseRetryAfter(new Date(now + 30_000).toUTCString())).toBe(31);
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

describe('fetchStreamAppend', () => {
  const throttled = (headers: Record<string, string> = {}) =>
    new Response('rate limited', { status: 429, headers });
  const connectError = (code: string) =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error(code), { code }),
    });

  /** Drive the loop to completion under fake timers; returns elapsed ms. */
  async function run(
    responses: Array<Response | Error>,
    options: Parameters<typeof fetchStreamAppend>[1] = {}
  ) {
    const request = vi.fn(async () => {
      const next = responses.shift() ?? new Response('ok');
      if (next instanceof Error) throw next;
      return next;
    });
    const start = Date.now();
    const pending = fetchStreamAppend(request, options);
    const settled = pending.then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error })
    );
    await vi.runAllTimersAsync();
    return {
      ...(await settled),
      calls: request.mock.calls.length,
      elapsed: Date.now() - start,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits the 1s floor when Retry-After is absent, then surfaces the 6th 429', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, calls, elapsed } = await run(
      Array.from({ length: 6 }, () => throttled())
    );
    expect(response?.status).toBe(429);
    expect(calls).toBe(6);
    expect(elapsed).toBe(5_000);
  });

  it('raises a short Retry-After to the 1s floor', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, calls, elapsed } = await run([
      throttled({ 'Retry-After': '0' }),
    ]);
    expect(response?.status).toBe(200);
    expect(calls).toBe(2);
    expect(elapsed).toBe(1_000);
  });

  it('stops waiting once the cumulative 30s throttle budget would be exceeded', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, calls, elapsed } = await run([
      throttled({ 'Retry-After': '20' }),
      throttled({ 'Retry-After': '20' }),
    ]);
    expect(response?.status).toBe(429);
    expect(calls).toBe(2);
    expect(elapsed).toBe(20_000);
  });

  it('honors an HTTP-date Retry-After', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, elapsed } = await run([
      throttled({ 'Retry-After': new Date(Date.now() + 3_000).toUTCString() }),
    ]);
    expect(calls).toBe(2);
    expect(elapsed).toBe(3_000);
  });

  it('surfaces a firewall challenge without waiting', async () => {
    vi.useFakeTimers();
    const { response, calls } = await run([
      throttled({ 'x-vercel-mitigated': 'challenge' }),
    ]);
    expect(response?.headers.get('x-vercel-mitigated')).toBe('challenge');
    expect(calls).toBe(1);
  });

  it('surfaces the 429 when the resend would not keep the deadline reserve', async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 5_000;
    const { response, calls, elapsed } = await run(
      [throttled({ 'Retry-After': '1' })],
      { deadlineMs, reserveMs: 4_500 }
    );
    expect(response?.status).toBe(429);
    expect(calls).toBe(1);
    expect(elapsed).toBe(0);
  });

  it('waits when the resend still keeps the deadline reserve', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deadlineMs = Date.now() + 5_000;
    const { response, calls } = await run([throttled({ 'Retry-After': '1' })], {
      deadlineMs,
      reserveMs: 4_000,
    });
    expect(response?.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('retries pre-connect failures with exponential backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response, calls, elapsed } = await run([
      connectError('ECONNREFUSED'),
      connectError('ENOTFOUND'),
      connectError('UND_ERR_CONNECT_TIMEOUT'),
    ]);
    expect(response?.status).toBe(200);
    expect(calls).toBe(4);
    expect(elapsed).toBe(500 + 1_000 + 2_000);
  });

  it.each([
    'ECONNRESET',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
  ])('surfaces %s without a resend, since the append may have persisted', async (code) => {
    vi.useFakeTimers();
    const { error, calls } = await run([connectError(code)]);
    expect(getTransientTransportCode(error)).toBe(code);
    expect(calls).toBe(1);
  });

  it('rethrows the connect error, not a timeout, when the backoff would cross the deadline reserve', async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 3_000;
    const { error, calls, elapsed } = await run(
      [connectError('ECONNREFUSED')],
      { deadlineMs, reserveMs: 2_600 }
    );
    expect(getTransientTransportCode(error)).toBe('ECONNREFUSED');
    expect(calls).toBe(1);
    expect(elapsed).toBe(0);
  });

  it('shares the 5-resend cap between 429s and connect failures', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { error, calls } = await run([
      throttled(),
      connectError('ECONNREFUSED'),
      throttled(),
      connectError('ECONNREFUSED'),
      throttled(),
      connectError('ECONNREFUSED'),
    ]);
    expect(getTransientTransportCode(error)).toBe('ECONNREFUSED');
    expect(calls).toBe(6);
  });

  it('reports each resend and logs the throttled attempt diagnostics', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onResend = vi.fn();
    await run(
      [
        throttled({ 'x-vercel-id': 'iad1::abc123' }),
        connectError('ECONNREFUSED'),
      ],
      { onResend }
    );
    expect(onResend.mock.calls).toEqual([[1], [2]]);
    expect(warn.mock.calls[0][0]).toContain('x-vercel-id=iad1::abc123');
    expect(warn.mock.calls[1][0]).toContain('ECONNREFUSED');
  });

  it('rejects with the abort reason when aborted during a wait', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = fetchStreamAppend(async () => throttled(), {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(reason);
    await assertion;
  });

  it('reserves half the request timeout, capped at 10s', () => {
    expect(streamAppendDeadlineReserveMs(3_000)).toBe(1_500);
    expect(streamAppendDeadlineReserveMs(30_000)).toBe(
      STREAM_APPEND_DEADLINE_RESERVE_MS
    );
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
