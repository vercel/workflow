import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal('fetch', mockFetch);
vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn().mockReturnValue({}),
}));

// Mock @vercel/oidc so it doesn't try to access real OIDC endpoints
vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

import { missingDeploymentIdMessage } from './deployment-id.js';
import { createResolveLatestDeploymentId } from './resolve-latest-deployment.js';

describe('createResolveLatestDeploymentId', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_current_abc123';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('should resolve the latest deployment ID from the API', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'dpl_latest_xyz789',
          url: 'my-app-latest.vercel.app',
          readyState: 'READY',
          target: 'production',
          createdAt: 1234567890,
          meta: {},
          gitSource: null,
        }),
        { status: 200 }
      )
    );

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });
    const result = await resolveLatest();

    expect(result).toBe('dpl_latest_xyz789');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.vercel.com/v1/workflow/resolve-latest-deployment/dpl_current_abc123',
      expect.objectContaining({ method: 'GET' })
    );
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('should throw when VERCEL_DEPLOYMENT_ID is not set', async () => {
    delete process.env.VERCEL_DEPLOYMENT_ID;

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });

    await expect(resolveLatest()).rejects.toThrow(
      missingDeploymentIdMessage(
        "Resolving the latest deployment for deploymentId: 'latest'"
      )
    );
  });

  it('should throw when no authentication token is available', async () => {
    delete process.env.VERCEL_TOKEN;

    const resolveLatest = createResolveLatestDeploymentId({
      // No token provided in config
    });

    await expect(resolveLatest()).rejects.toThrow(
      'no OIDC token or VERCEL_TOKEN available'
    );
  });

  it('should fall back to VERCEL_TOKEN env var when no config token is provided', async () => {
    process.env.VERCEL_TOKEN = 'env-token-123';

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'dpl_latest_from_env',
          url: 'my-app.vercel.app',
          readyState: 'READY',
          target: 'production',
          createdAt: 1234567890,
          meta: {},
          gitSource: null,
        }),
        { status: 200 }
      )
    );

    const resolveLatest = createResolveLatestDeploymentId({
      // No token in config
    });
    const result = await resolveLatest();

    expect(result).toBe('dpl_latest_from_env');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything()
    );
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer env-token-123');
  });

  it('should use OIDC token when config token is absent and VERCEL_TOKEN is unset', async () => {
    delete process.env.VERCEL_TOKEN;

    // Override the OIDC mock to resolve successfully for this test
    const { getVercelOidcToken } = await import('@vercel/oidc');
    vi.mocked(getVercelOidcToken).mockResolvedValueOnce('oidc-token-456');

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'dpl_latest_from_oidc',
          url: 'my-app.vercel.app',
          readyState: 'READY',
          target: 'production',
          createdAt: 1234567890,
          meta: {},
          gitSource: null,
        }),
        { status: 200 }
      )
    );

    const resolveLatest = createResolveLatestDeploymentId({
      // No config token
    });
    const result = await resolveLatest();

    expect(result).toBe('dpl_latest_from_oidc');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything()
    );
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer oidc-token-456');
  });

  it('prefers the OIDC token over VERCEL_TOKEN inside the Vercel runtime', async () => {
    // The shape that broke production: a deployed function whose environment
    // also carries a VERCEL_TOKEN for unrelated tooling. The token is a user
    // credential and carries no team, so authenticating with it scopes the
    // lookup to that user's default team and 404s.
    process.env.VERCEL = '1';
    process.env.VERCEL_TOKEN = 'user-token-wrong-team';

    const { getVercelOidcToken } = await import('@vercel/oidc');
    vi.mocked(getVercelOidcToken).mockResolvedValueOnce('oidc-token-789');

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_latest_from_oidc' }), {
        status: 200,
      })
    );

    const result = await createResolveLatestDeploymentId({})();

    expect(result).toBe('dpl_latest_from_oidc');
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer oidc-token-789');
  });

  it('keeps using VERCEL_TOKEN outside the Vercel runtime', async () => {
    // CLI and CI callers export VERCEL_TOKEN deliberately and have no
    // deployment identity to prefer, so the original order stands there.
    delete process.env.VERCEL;
    process.env.VERCEL_TOKEN = 'env-token-123';

    const { getVercelOidcToken } = await import('@vercel/oidc');
    vi.mocked(getVercelOidcToken).mockResolvedValueOnce('oidc-token-789');

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_from_env' }), { status: 200 })
    );

    await createResolveLatestDeploymentId({})();

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer env-token-123');
  });

  it('still prefers an explicit config token inside the Vercel runtime', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_TOKEN = 'env-token-123';

    // Queueing an OIDC value here would leak into the next test, since an
    // explicit config token short-circuits before OIDC is ever consulted.
    // Assert that directly instead.
    const { getVercelOidcToken } = await import('@vercel/oidc');
    vi.mocked(getVercelOidcToken).mockClear();

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_from_config' }), { status: 200 })
    );

    await createResolveLatestDeploymentId({ token: 'config-token' })();

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer config-token');
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it('falls back to VERCEL_TOKEN inside the runtime when OIDC is unavailable', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_TOKEN = 'env-token-123';

    const { getVercelOidcToken } = await import('@vercel/oidc');
    // mockReset clears any queue a prior test left behind; the rejection is
    // scoped to this call so it does not leak into later tests.
    vi.mocked(getVercelOidcToken).mockReset();
    vi.mocked(getVercelOidcToken).mockRejectedValueOnce(new Error('no OIDC'));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_from_env' }), { status: 200 })
    );

    await createResolveLatestDeploymentId({})();

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer env-token-123');
  });

  it('scopes the request to the configured team', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_latest' }), { status: 200 })
    );

    await createResolveLatestDeploymentId({
      token: 'test-token',
      projectConfig: { projectId: 'prj_123', teamId: 'team_abc' },
    })();

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe(
      '/v1/workflow/resolve-latest-deployment/dpl_current_abc123'
    );
    expect(url.searchParams.get('teamId')).toBe('team_abc');
  });

  it('omits the team parameter when no team is configured', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'dpl_latest' }), { status: 200 })
    );

    await createResolveLatestDeploymentId({ token: 'test-token' })();

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.vercel.com/v1/workflow/resolve-latest-deployment/dpl_current_abc123'
    );
  });

  it('explains the identity cause on a 404', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Deployment not found.', { status: 404 })
    );

    await expect(
      createResolveLatestDeploymentId({ token: 'test-token' })()
    ).rejects.toThrow(/not visible to the identity/);
  });

  it('should throw on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });

    await expect(resolveLatest()).rejects.toThrow('HTTP 404');
  });

  it('should throw on 500 server error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });

    await expect(resolveLatest()).rejects.toThrow('HTTP 500');
  });

  it('should throw on invalid response schema (missing id field)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ deploymentId: 'dpl_wrong_field' }), {
        status: 200,
      })
    );

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });

    await expect(resolveLatest()).rejects.toThrow(
      'Invalid response from Vercel API: expected { id: string }'
    );
  });

  describe('outside a deployment', () => {
    beforeEach(() => {
      delete process.env.VERCEL_DEPLOYMENT_ID;
    });

    const listResponse = (uids: string[]) =>
      new Response(
        JSON.stringify({ deployments: uids.map((uid) => ({ uid })) }),
        { status: 200 }
      );

    it('resolves from a deployment of the configured environment', async () => {
      mockFetch
        .mockResolvedValueOnce(listResponse(['dpl_any_production']))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'dpl_latest_production' }), {
            status: 200,
          })
        );

      const result = await createResolveLatestDeploymentId({
        token: 'test-token',
        projectConfig: {
          projectId: 'prj_123',
          teamId: 'team_abc',
          environment: 'production',
        },
      })();

      expect(result).toBe('dpl_latest_production');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const listUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(listUrl.pathname).toBe('/v6/deployments');
      expect(listUrl.searchParams.get('projectId')).toBe('prj_123');
      expect(listUrl.searchParams.get('target')).toBe('production');
      expect(listUrl.searchParams.get('limit')).toBe('1');
      expect(listUrl.searchParams.get('teamId')).toBe('team_abc');
      const listHeaders = mockFetch.mock.calls[0][1].headers as Headers;
      expect(listHeaders.get('Authorization')).toBe('Bearer test-token');

      // The same endpoint start() uses inside a deployment picks the
      // deployment; the listed one only stands in for the current deployment.
      const resolveUrl = new URL(mockFetch.mock.calls[1][0] as string);
      expect(resolveUrl.pathname).toBe(
        '/v1/workflow/resolve-latest-deployment/dpl_any_production'
      );
      expect(resolveUrl.searchParams.get('teamId')).toBe('team_abc');
    });

    it('uses the configured preview environment', async () => {
      mockFetch
        .mockResolvedValueOnce(listResponse(['dpl_preview']))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'dpl_latest_preview' }), {
            status: 200,
          })
        );

      const result = await createResolveLatestDeploymentId({
        token: 'test-token',
        projectConfig: { projectId: 'prj_123', environment: 'preview' },
      })();

      expect(result).toBe('dpl_latest_preview');
      const listUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(listUrl.searchParams.get('target')).toBe('preview');
      expect(listUrl.searchParams.has('teamId')).toBe(false);
    });

    it('defaults to production when no environment is configured', async () => {
      mockFetch
        .mockResolvedValueOnce(listResponse(['dpl_prod']))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'dpl_latest' }), { status: 200 })
        );

      await createResolveLatestDeploymentId({
        token: 'test-token',
        projectConfig: { projectId: 'prj_123' },
      })();

      const listUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(listUrl.searchParams.get('target')).toBe('production');
    });

    it('fails when the project has no deployments in that environment', async () => {
      mockFetch.mockResolvedValueOnce(listResponse([]));

      await expect(
        createResolveLatestDeploymentId({
          token: 'test-token',
          projectConfig: { projectId: 'prj_123', environment: 'preview' },
        })()
      ).rejects.toThrow('project prj_123 has no preview deployments');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed deployment listing', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 })
      );

      await expect(
        createResolveLatestDeploymentId({
          token: 'test-token',
          projectConfig: { projectId: 'prj_123' },
        })()
      ).rejects.toThrow(
        'Failed to list production deployments of project prj_123: HTTP 403'
      );
    });

    it('prefers VERCEL_DEPLOYMENT_ID over the configured project when both are set', async () => {
      process.env.VERCEL_DEPLOYMENT_ID = 'dpl_current_abc123';
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'dpl_latest' }), { status: 200 })
      );

      await createResolveLatestDeploymentId({
        token: 'test-token',
        projectConfig: { projectId: 'prj_123' },
      })();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(mockFetch.mock.calls[0][0] as string);
      expect(url.pathname).toBe(
        '/v1/workflow/resolve-latest-deployment/dpl_current_abc123'
      );
    });
  });
});
