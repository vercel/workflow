import { RunExpiredError, WorkflowWorldError } from '@workflow/errors';
import { encode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  getHeaders,
  getHttpConfig,
  getHttpUrl,
  inspectWorkflowBackendDeprecationResponse,
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
  });

  afterEach(() => {
    process.env = originalEnv;
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

describe('workflow backend deprecation notices', () => {
  const schema = z.object({ value: z.string() });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function successResponse(headers: HeadersInit) {
    return new Response(encode({ value: 'ok' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/cbor',
        ...headers,
      },
    });
  }

  it('parses standard headers and lets callbacks own presentation', async () => {
    const onDeprecation = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        successResponse({
          Deprecation: '@32472144000',
          Sunset: 'Fri, 01 Jan 3000 00:00:00 GMT',
          'X-API-Endpoint-Preferred': '/api/v3/runs/[runId]/events',
          Link: '<https://example.com/migrate>; rel="deprecation"',
        })
      )
    );

    await makeRequest({
      endpoint: '/v2/events?correlationId=step_1',
      schema,
      config: { onDeprecation },
    });

    expect(onDeprecation).toHaveBeenCalledWith({
      endpoint: '/v2/events',
      state: 'scheduled',
      deprecationDate: '2999-01-01',
      sunsetDate: '3000-01-01',
      preferredVersion: undefined,
      preferredEndpoint: '/api/v3/runs/[runId]/events',
      documentationUrl: 'https://example.com/migrate',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to legacy headers and deduplicates built-in warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = new Response(null, {
      headers: {
        'X-API-Deprecated': 'true',
        'X-API-Deprecation-Date': '2026-03-01',
        'X-API-Version-Preferred': 'v3',
      },
    });

    const first = inspectWorkflowBackendDeprecationResponse(
      response,
      '/v2/events?correlationId=step_1'
    );
    inspectWorkflowBackendDeprecationResponse(
      response,
      '/v2/events?correlationId=step_2'
    );

    expect(first).toMatchObject({
      endpoint: '/v2/events',
      state: 'deprecated',
      deprecationDate: '2026-03-01',
      preferredVersion: 'v3',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Update `workflow`');
  });

  it('does not fail an operation when an onDeprecation callback throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(successResponse({ 'X-API-Deprecated': 'true' }))
    );

    await expect(
      makeRequest({
        endpoint: '/v2/events',
        schema,
        config: {
          onDeprecation: () => {
            throw new Error('presentation failed');
          },
        },
      })
    ).resolves.toEqual({ value: 'ok' });
  });

  it('classifies a removed endpoint 410 separately from run expiration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { message: 'Endpoint removed' },
          {
            status: 410,
            headers: {
              'X-API-Sunset': 'true',
              'X-API-Deprecated': 'true',
              'X-API-Sunset-Date': '2026-06-01',
            },
          }
        )
      )
    );

    const error = await makeRequest({
      endpoint: '/v2/events',
      schema,
      config: { onDeprecation: vi.fn() },
    }).catch((cause) => cause);

    expect(WorkflowWorldError.is(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'WorkflowWorldError',
      status: 410,
      code: 'WORKFLOW_SERVER_ENDPOINT_SUNSET',
    });
    expect(RunExpiredError.is(error)).toBe(false);
  });

  it('keeps ordinary 410 responses mapped to RunExpiredError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: 'Run expired' }, { status: 410 })
        )
    );

    const error = await makeRequest({
      endpoint: '/v3/runs/wrun_test/events',
      schema,
    }).catch((cause) => cause);

    expect(RunExpiredError.is(error)).toBe(true);
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
});
