import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHeaders, getHttpConfig, getHttpUrl } from './utils.js';

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
