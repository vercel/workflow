import {
  EntityConflictError,
  RunExpiredError,
  StreamExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeTransportFailure,
  errorForResponse,
  formatVercelDiagnostics,
  getRequestTimeoutMs,
  getTransientTransportCode,
  getVercelDiagnostics,
  instrumentedFetch,
  parseRetryAfter,
  REQUEST_TIMEOUT_MS,
  resolveVercelApiToken,
} from './http-core.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
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
    ['TRANSPORT', { Connection: 'invalid' }, 'UND_ERR_INVALID_ARG'],
    ['STREAM_ERROR', { Connection: 'invalid' }, 'UND_ERR_INVALID_ARG'],
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

  it('returns undefined for missing or non-numeric values', () => {
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
