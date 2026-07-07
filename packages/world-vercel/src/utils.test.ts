import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  getHeaders,
  getHttpConfig,
  getHttpUrl,
  MAX_BODY_PARSE_RETRIES,
  makeRequest,
} from './utils.js';

vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

describe('getHttpUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.WORKFLOW_VERCEL_BACKEND_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses default workflow-server URL when no config and no env override', () => {
    expect(getHttpUrl()).toEqual({
      baseUrl: 'https://vercel-workflow.com/api',
      usingProxy: false,
    });
  });

  it('respects VERCEL_WORKFLOW_SERVER_URL when set (no proxy)', () => {
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://custom-host.example.com';
    expect(getHttpUrl()).toEqual({
      baseUrl: 'https://custom-host.example.com/api',
      usingProxy: false,
    });
  });

  it('uses proxy when projectId + teamId are provided', () => {
    expect(
      getHttpUrl({
        projectConfig: { projectId: 'prj_123', teamId: 'team_456' },
      })
    ).toEqual({
      baseUrl: 'https://api.vercel.com/v1/workflow',
      usingProxy: true,
    });
  });

  it('respects WORKFLOW_VERCEL_BACKEND_URL for custom proxy URL', () => {
    process.env.WORKFLOW_VERCEL_BACKEND_URL = 'https://proxy.example.com/v1';
    expect(
      getHttpUrl({
        projectConfig: { projectId: 'prj_123', teamId: 'team_456' },
      })
    ).toEqual({
      baseUrl: 'https://proxy.example.com/v1',
      usingProxy: true,
    });
  });
});

describe('getHeaders', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.WORKFLOW_TEST_LIMIT_OVERRIDES;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('omits x-workflow-test-limit-overrides when WORKFLOW_TEST_LIMIT_OVERRIDES is unset', () => {
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-workflow-test-limit-overrides')).toBeNull();
  });

  it('forwards WORKFLOW_TEST_LIMIT_OVERRIDES verbatim as x-workflow-test-limit-overrides', () => {
    const overrides = '{"STREAM_MAX_DURATION_MS":5000}';
    process.env.WORKFLOW_TEST_LIMIT_OVERRIDES = overrides;
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-workflow-test-limit-overrides')).toBe(overrides);
  });

  it('does not attach x-vercel-trusted-oidc-idp-token (set by getHttpConfig)', () => {
    process.env.VERCEL_OIDC_TOKEN = 'my-oidc-token';
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-vercel-trusted-oidc-idp-token')).toBeNull();
  });

  it('omits x-vercel-workflow-api-url when override is unset', () => {
    const headers = getHeaders(undefined, { usingProxy: true });
    expect(headers.get('x-vercel-workflow-api-url')).toBeNull();
  });

  it('sets x-vercel-workflow-api-url when VERCEL_WORKFLOW_SERVER_URL is set and using proxy', () => {
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://custom.example.com';
    const headers = getHeaders(undefined, { usingProxy: true });
    expect(headers.get('x-vercel-workflow-api-url')).toBe(
      'https://custom.example.com'
    );
  });

  it('omits x-vercel-workflow-api-url when override is set but not using proxy', () => {
    // Direct-to-workflow-server mode uses baseUrl, so the header is redundant.
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://custom.example.com';
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-vercel-workflow-api-url')).toBeNull();
  });

  it('sets project config headers when provided', () => {
    const headers = getHeaders(
      {
        projectConfig: {
          projectId: 'prj_123',
          teamId: 'team_456',
          environment: 'preview',
        },
      },
      { usingProxy: true }
    );
    expect(headers.get('x-vercel-project-id')).toBe('prj_123');
    expect(headers.get('x-vercel-team-id')).toBe('team_456');
    expect(headers.get('x-vercel-environment')).toBe('preview');
  });
});

describe('getHttpConfig (proxied path)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.WORKFLOW_VERCEL_BACKEND_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when usingProxy and no config.token is provided', async () => {
    await expect(
      getHttpConfig({
        projectConfig: { projectId: 'prj_123', teamId: 'team_456' },
      })
    ).rejects.toThrow(/no Vercel auth token was provided/);
  });

  it('attaches Authorization bearer when usingProxy and config.token is provided', async () => {
    const { headers } = await getHttpConfig({
      projectConfig: { projectId: 'prj_123', teamId: 'team_456' },
      token: 'my-vercel-auth-token',
    });
    expect(headers.get('Authorization')).toBe('Bearer my-vercel-auth-token');
    // The trusted-sources bypass header is meaningless on the proxied
    // path (api.vercel.com is public) and must NOT be attached.
    expect(headers.get('x-vercel-trusted-oidc-idp-token')).toBeNull();
  });
});

describe('makeRequest body-parse retry', () => {
  const schema = z.object({ value: z.string() });
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.VERCEL_OIDC_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  /** Build a minimal Response-like object exercising the fields makeRequest reads. */
  function cborResponse(data: unknown) {
    const bytes = encode(data);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-type' ? 'application/cbor' : null,
      },
      // parseResponseBody does `new Uint8Array(await response.arrayBuffer())`;
      // a copy of the encoded bytes' buffer is a valid ArrayBuffer.
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
    };
  }

  /** A 2xx response whose body read fails transiently (truncated stream). */
  function truncatedBodyResponse() {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-type' ? 'application/cbor' : null,
      },
      arrayBuffer: async () => {
        throw new TypeError('terminated');
      },
    };
  }

  it('retries an idempotent GET when the body read fails, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(truncatedBodyResponse())
      .mockResolvedValueOnce(cborResponse({ value: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'GET' },
      schema,
    });

    expect(result).toEqual({ value: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws PARSE_ERROR after exhausting retries for a GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(truncatedBodyResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toMatchObject({ code: 'PARSE_ERROR' });

    // Initial attempt + MAX_BODY_PARSE_RETRIES retries.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_BODY_PARSE_RETRIES + 1);
  });

  it('does NOT retry a non-idempotent POST on body-parse failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(truncatedBodyResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'POST' },
        data: { eventType: 'run_started' },
        schema,
      })
    ).rejects.toMatchObject({ code: 'PARSE_ERROR' });

    // A write must not be replayed — exactly one attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes Vercel correlation headers in HTTP response errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'upstream timed out' }), {
        status: 504,
        headers: {
          'content-type': 'application/json',
          'x-vercel-id': 'iad1::req-abc',
          'x-vercel-error': 'FUNCTION_INVOCATION_TIMEOUT',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v2/runs/wrun_test?remoteRefBehavior=resolve',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toThrow(
      'upstream timed out (x-vercel-id=iad1::req-abc; x-vercel-error=FUNCTION_INVOCATION_TIMEOUT)'
    );
  });

  it('surfaces the firewall x-vercel-mitigated header in HTTP response errors', async () => {
    // A firewall `deny` arrives as a 403 (not retried by the RetryAgent), so
    // its mitigation + trace headers reach our response handling.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-vercel-id': 'sfo1::req-deny',
          'x-vercel-mitigated': 'deny',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toThrow('x-vercel-id=sfo1::req-deny; x-vercel-mitigated=deny');
  });

  it('maps workflow-server error fields onto WorkflowWorldError.code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'observability-upgrade-required',
          message: 'run is outside the current observability lookback window',
        }),
        {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const rejection = await makeRequest({
      endpoint: '/v2/analytics/runs/wrun_test',
      options: { method: 'GET' },
      schema,
    }).catch((e) => e);

    expect(rejection).toMatchObject({
      name: 'WorkflowWorldError',
      status: 402,
      code: 'observability-upgrade-required',
    });
  });

  it('maps a firewall challenge (429 + x-vercel-mitigated: challenge) to a retryable TRANSPORT error, not ThrottleError', async () => {
    // A challenge can't be solved by a server-to-server client, so it must NOT
    // become a ThrottleError (which the step_started path defers by re-enqueuing
    // a fresh message, resetting the delivery count → uncapped flat loop). It is
    // routed to the TRANSPORT path so the runtime rethrows it to the queue
    // (delivery-count backoff + MAX_QUEUE_DELIVERIES cap).
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-vercel-id': 'iad1::req-challenge',
          'x-vercel-mitigated': 'challenge',
          'retry-after': '5',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const rejection = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'GET' },
      schema,
    }).catch((e) => e);

    expect(rejection).toMatchObject({
      name: 'WorkflowWorldError',
      code: 'TRANSPORT',
      status: 429,
    });
    // The mitigation + trace headers stay diagnosable in the message.
    expect(rejection.message).toContain('x-vercel-mitigated=challenge');
    // Single attempt — the queue redrive is the retry layer, not body-parse.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a genuine application-level 429 (no challenge mitigation) as a ThrottleError with retryAfter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'slow down' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '12',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const rejection = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'GET' },
      schema,
    }).catch((e) => e);

    expect(rejection.name).toBe('ThrottleError');
    expect(rejection.retryAfter).toBe(12);
  });
});

describe('makeRequest transport errors', () => {
  const schema = z.object({ value: z.string() });
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.VERCEL_OIDC_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('maps an exhausted RetryAgent (UND_ERR_REQ_RETRY in cause) to a TRANSPORT error', async () => {
    // fetch() wraps the underlying undici error in a `TypeError: fetch failed`
    // whose `cause` carries the real `.code` — the firewall returning 429/503
    // that the RetryAgent retried and then gave up on surfaces this way.
    const cause = Object.assign(new Error('Request failed'), {
      code: 'UND_ERR_REQ_RETRY',
    });
    const fetchErr = Object.assign(new TypeError('fetch failed'), { cause });
    const fetchMock = vi.fn().mockRejectedValue(fetchErr);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toMatchObject({ name: 'WorkflowWorldError', code: 'TRANSPORT' });

    // Transport failures are not body-parse retried inside makeRequest — the
    // queue redrive is the retry layer, so exactly one attempt is made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a direct socket error code (ECONNRESET) to TRANSPORT', async () => {
    const fetchErr = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchErr));

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toMatchObject({ name: 'WorkflowWorldError', code: 'TRANSPORT' });
  });

  it('preserves the original error as the cause', async () => {
    const cause = Object.assign(new Error('Request failed'), {
      code: 'UND_ERR_REQ_RETRY',
    });
    const fetchErr = Object.assign(new TypeError('fetch failed'), { cause });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchErr));

    const rejection = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'GET' },
      schema,
    }).catch((e) => e);

    expect(rejection.cause).toBe(fetchErr);
  });

  it('rethrows a non-transient fetch error unchanged', async () => {
    const fetchErr = new Error('some unexpected non-network error');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchErr));

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toBe(fetchErr);
  });

  it('maps an AbortSignal timeout to a TIMEOUT error', async () => {
    const timeoutErr = Object.assign(new Error('The operation timed out'), {
      name: 'TimeoutError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toMatchObject({ name: 'WorkflowWorldError', code: 'TIMEOUT' });
  });
});
