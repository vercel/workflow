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
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('should throw when VERCEL_DEPLOYMENT_ID is not set', async () => {
    delete process.env.VERCEL_DEPLOYMENT_ID;

    const resolveLatest = createResolveLatestDeploymentId({
      token: 'test-token',
    });

    await expect(resolveLatest()).rejects.toThrow(
      'VERCEL_DEPLOYMENT_ID environment variable is not set'
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
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer env-token-123',
        }),
      })
    );
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
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oidc-token-456',
        }),
      })
    );
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
});
