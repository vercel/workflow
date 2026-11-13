import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthToken, mockFetch } = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  mockFetch: vi.fn(),
}));
vi.mock('./auth.js', () => ({ getAuthToken }));
vi.stubGlobal('fetch', mockFetch);

const { inferVercelEnvVars } = await import('./env.js');
const { resetVercelExtension, setRunAsVercelExtension } = await import(
  './vercel-extension.js'
);

const PROXY = 'http://127.0.0.1:4321';

describe('inferVercelEnvVars run as `vercel workflow`', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WORKFLOW_VERCEL_PROJECT: 'prj_123',
      WORKFLOW_VERCEL_PROJECT_NAME: 'my-app',
      WORKFLOW_VERCEL_TEAM: 'team_456',
    };
    delete process.env.WORKFLOW_VERCEL_AUTH_TOKEN;
    delete process.env.WORKFLOW_VERCEL_API_URL;
    getAuthToken.mockReset().mockResolvedValue('token-from-auth-file');
    mockFetch
      .mockReset()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'team_456', slug: 'my-team' }))
      );
  });

  afterEach(() => {
    process.env = originalEnv;
    resetVercelExtension();
  });

  it('authenticates through the Vercel CLI API proxy', async () => {
    setRunAsVercelExtension(PROXY);

    const result = await inferVercelEnvVars();

    expect(getAuthToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      token: undefined,
      vercelApiUrl: PROXY,
      projectId: 'prj_123',
      teamId: 'my-team',
    });
    expect(process.env.WORKFLOW_VERCEL_API_URL).toBe(PROXY);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${PROXY}/v2/teams/team_456`);
    expect(init.headers).toEqual({});
  });

  it('uses an explicit token as given, without the proxy', async () => {
    setRunAsVercelExtension(PROXY);
    process.env.WORKFLOW_VERCEL_AUTH_TOKEN = 'explicit-token';

    const result = await inferVercelEnvVars();

    expect(result).toMatchObject({
      token: 'explicit-token',
      vercelApiUrl: undefined,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.vercel.com/v2/teams/team_456');
    expect(init.headers).toEqual({ Authorization: 'Bearer explicit-token' });
  });

  it('reads the Vercel CLI login when not run as an extension', async () => {
    const result = await inferVercelEnvVars();

    expect(getAuthToken).toHaveBeenCalled();
    expect(result).toMatchObject({
      token: 'token-from-auth-file',
      vercelApiUrl: undefined,
    });
  });
});
