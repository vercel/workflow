import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PreconditionFailedError, StreamExpiredError } from '@workflow/errors';
import { NODE_HTTP_ENV_VAR } from '@workflow/world';
import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  getHeaders,
  getHttpConfig,
  getHttpUrl,
  MAX_BODY_PARSE_RETRIES,
  makeRequest,
  resolveClientEnvironment,
  WORKFLOW_SERVER_URL_OVERRIDE,
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
      baseUrl: WORKFLOW_SERVER_URL_OVERRIDE
        ? `${WORKFLOW_SERVER_URL_OVERRIDE}/api`
        : 'https://vercel-workflow.com/api',
      usingProxy: false,
    });
  });

  it('respects VERCEL_WORKFLOW_SERVER_URL when set (no proxy)', () => {
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://custom-host.example.com';
    expect(getHttpUrl()).toEqual({
      baseUrl: WORKFLOW_SERVER_URL_OVERRIDE
        ? `${WORKFLOW_SERVER_URL_OVERRIDE}/api`
        : 'https://custom-host.example.com/api',
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

  it('appends a caller user-agent token to the world-vercel user-agent', () => {
    const headers = getHeaders(
      { headers: { 'User-Agent': 'eve/0.18.1' } },
      { usingProxy: false }
    );

    expect(headers.get('User-Agent')).toMatch(
      /^@workflow\/world-vercel\/\S+ node-\S+ \S+ \([^)]*\)(?: \S+)? eve\/0\.18\.1$/
    );
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
    expect(headers.get('x-vercel-workflow-api-url')).toBe(
      WORKFLOW_SERVER_URL_OVERRIDE || null
    );
  });

  it('sets x-vercel-workflow-api-url when VERCEL_WORKFLOW_SERVER_URL is set and using proxy', () => {
    process.env.VERCEL_WORKFLOW_SERVER_URL = 'https://custom.example.com';
    const headers = getHeaders(undefined, { usingProxy: true });
    expect(headers.get('x-vercel-workflow-api-url')).toBe(
      WORKFLOW_SERVER_URL_OVERRIDE || 'https://custom.example.com'
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

describe('resolveClientEnvironment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_TARGET_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses the projectConfig environment on the proxied path', () => {
    expect(
      resolveClientEnvironment({
        projectConfig: {
          projectId: 'prj_1',
          teamId: 'team_1',
          environment: 'preview',
        },
      })
    ).toBe('preview');
  });

  it("defaults a projectConfig without an environment to 'production'", () => {
    expect(
      resolveClientEnvironment({
        projectConfig: { projectId: 'prj_1', teamId: 'team_1' },
      })
    ).toBe('production');
  });

  it('reads VERCEL_ENV when there is no projectConfig (in-deployment OIDC path)', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(resolveClientEnvironment(undefined)).toBe('preview');
  });

  it('prefers VERCEL_TARGET_ENV over VERCEL_ENV (custom environments)', () => {
    // In a Vercel custom environment the OIDC token's `environment` claim is
    // the custom environment's slug (the platform mints
    // `customEnvironment?.slug ?? envTarget`), while VERCEL_ENV reports
    // 'preview'. VERCEL_TARGET_ENV is populated from the same
    // slug-or-target pair as the claim, so it is the value the backend keys
    // the tenant on — returning 'preview' here would false-refuse a
    // legitimate delivery to a custom-environment deployment.
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_TARGET_ENV = 'staging';
    expect(resolveClientEnvironment(undefined)).toBe('staging');
  });

  it('agrees with VERCEL_TARGET_ENV in the standard environments too', () => {
    // For production/preview, VERCEL_TARGET_ENV equals VERCEL_ENV, so
    // preferring it changes nothing outside custom environments.
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    expect(resolveClientEnvironment(undefined)).toBe('production');
  });

  it('returns undefined when neither source is available', () => {
    // Guessing 'production' here would fabricate a mismatch against a real
    // preview deployment, so callers need the honest "unknown".
    expect(resolveClientEnvironment(undefined)).toBeUndefined();
    expect(resolveClientEnvironment({})).toBeUndefined();
  });

  it('ignores VERCEL_ENV when a projectConfig is present', () => {
    // The proxy attributes the write to the header, not to the local env var —
    // a CLI run from a preview checkout must not claim the deployment's env.
    process.env.VERCEL_ENV = 'production';
    expect(
      resolveClientEnvironment({
        projectConfig: {
          projectId: 'prj_1',
          teamId: 'team_1',
          environment: 'preview',
        },
      })
    ).toBe('preview');
  });

  // The whole point of the shared helper: the value stamped into runInput must
  // be byte-identical to what the backend attributes this client's writes to.
  // A drift makes the cross-environment guard either miss a real fork or reject
  // a legitimate start.
  it.each([
    ['explicit preview', 'preview'],
    ['explicit production', 'production'],
    ['explicit development', 'development'],
    ['absent (defaulted)', undefined],
  ])('agrees with the x-vercel-environment header: %s', (_label, environment) => {
    const config = {
      projectConfig: { projectId: 'prj_1', teamId: 'team_1', environment },
    };
    const headers = getHeaders(config, { usingProxy: true });
    expect(resolveClientEnvironment(config)).toBe(
      headers.get('x-vercel-environment')
    );
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

describe('makeRequest stream expiry errors', () => {
  // These drive the response from a stubbed `fetch`, which the node:http
  // client never calls, so the flag is pinned off for them.
  beforeEach(() => {
    vi.stubEnv(NODE_HTTP_ENV_VAR, '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['/v2/runs/wrun_test/streams/stream-test/chunks'],
    ['/v2/runs/wrun_test/streams/stream-test/info'],
  ])('preserves stream-expired details from %s', async (endpoint) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json(
        {
          error: 'stream-expired',
          message: 'The stream reached its storage retention limit',
          details: {
            runId: 'wrun_test',
            streamId: 'stream-test',
            expiredAt: '2026-08-10T14:40:00.000Z',
          },
        },
        { status: 410 }
      )
    );

    const error = await makeRequest({
      endpoint,
      schema: z.never(),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StreamExpiredError);
    expect(error).toMatchObject({
      runId: 'wrun_test',
      streamId: 'stream-test',
      expiredAt: new Date('2026-08-10T14:40:00.000Z'),
    });
  });
});

describe('makeRequest body-parse retry', () => {
  const schema = z.object({ value: z.string() });
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_WORKFLOW_SERVER_URL;
    delete process.env.VERCEL_OIDC_TOKEN;
    // These tests drive the retry loop from a stubbed `fetch`, so they only
    // reach the code under test while requests go through `fetch`.
    process.env[NODE_HTTP_ENV_VAR] = '0';
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

  /** A non-2xx CBOR error response with the given status and error code. */
  function cborErrorResponse(status: number, code: string) {
    const bytes = encode({ success: false, error: code, code, message: code });
    return {
      ok: false,
      status,
      statusText: 'ERR',
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-type' ? 'application/cbor' : null,
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
    };
  }

  it('maps a 412 response to PreconditionFailedError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(cborErrorResponse(412, 'precondition-failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'POST' },
        data: { eventType: 'run_completed' },
        schema,
      })
    ).rejects.toBeInstanceOf(PreconditionFailedError);

    // A 412 is a deterministic rejection — no transport retries.
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
    // The `UND_ERR_*` codes below only ever come out of undici, so these
    // cases are specific to the `fetch` path. The node:http path raises
    // Node's own socket codes and is covered separately.
    process.env[NODE_HTTP_ENV_VAR] = '0';
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

// The suites above pin the flag off and simulate the transport with a `fetch`
// stub, which the node:http client never calls. These run against a loopback
// origin instead, covering the two contracts the runtime branches on: a
// failed request has to stay retryable, and a typed error status has to keep
// producing the same typed error whichever transport carried it.
describe('makeRequest over node:http', () => {
  const schema = z.object({ value: z.string() });
  const originalEnv = process.env;
  let server: Server | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env[NODE_HTTP_ENV_VAR] = '1';
  });

  afterEach(async () => {
    process.env = originalEnv;
    const toClose = server;
    server = undefined;
    if (toClose) {
      toClose.closeAllConnections();
      await new Promise((resolve) => toClose.close(resolve));
    }
  });

  /** Start a loopback origin and point the client at it. */
  async function listen(handler: RequestListener): Promise<void> {
    server = createServer(handler);
    await new Promise<void>((resolve) =>
      server?.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    process.env.VERCEL_WORKFLOW_SERVER_URL = `http://127.0.0.1:${port}`;
  }

  it('maps a dropped socket to a retryable TRANSPORT error', async () => {
    await listen((request) => request.socket.destroy());

    // Node raises ECONNRESET on the error itself rather than on a `cause`, so
    // this only passes if getTransientTransportCode reads the top-level code.
    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'GET' },
        schema,
      })
    ).rejects.toMatchObject({ name: 'WorkflowWorldError', code: 'TRANSPORT' });
  });

  it('maps a 412 response to PreconditionFailedError', async () => {
    await listen((request, response) => {
      request.resume();
      response.statusCode = 412;
      response.setHeader('content-type', 'application/cbor');
      response.end(
        encode({
          success: false,
          error: 'precondition-failed',
          code: 'precondition-failed',
          message: 'precondition-failed',
        })
      );
    });

    await expect(
      makeRequest({
        endpoint: '/v3/runs/wrun_test/events',
        options: { method: 'POST' },
        data: { eventType: 'run_completed' },
        schema,
      })
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('round-trips a CBOR POST body to the origin', async () => {
    let seen: { method?: string; length?: string } = {};
    await listen((request, response) => {
      seen = {
        method: request.method,
        length: request.headers['content-length'],
      };
      request.resume();
      response.setHeader('content-type', 'application/cbor');
      response.end(encode({ value: 'ok' }));
    });

    const result = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      options: { method: 'POST' },
      data: { eventType: 'run_completed' },
      schema,
    });

    expect(result).toEqual({ value: 'ok' });
    expect(seen.method).toBe('POST');
    // A declared length, not a chunked body: some origins reject the latter.
    expect(Number(seen.length)).toBeGreaterThan(0);
  });
});
