import { WorkflowWorldError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));
vi.stubGlobal('fetch', mockFetch);
vi.mock('./http-client.js', () => ({
  getDispatcher: vi.fn().mockReturnValue({}),
}));
vi.mock('@vercel/oidc', () => ({
  getVercelOidcToken: vi.fn().mockRejectedValue(new Error('no OIDC')),
}));

import {
  getHeaders,
  getHttpUrl,
  getProtectionBypassHeader,
  makeRequest,
} from './utils.js';

describe('makeRequest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('converts AbortSignal.timeout TimeoutError into WorkflowWorldError', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    const promise = makeRequest({
      endpoint: '/runs/run_123',
      options: { method: 'POST' },
      config: { token: 'test-token' },
      schema: z.object({ ok: z.boolean() }),
    });

    await expect(promise).rejects.toBeInstanceOf(WorkflowWorldError);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('POST /runs/run_123 timed out after'),
      cause: timeoutError,
    });
  });

  it('does not wrap non-timeout fetch errors', async () => {
    const networkError = new TypeError('fetch failed');
    mockFetch.mockRejectedValueOnce(networkError);

    const promise = makeRequest({
      endpoint: '/runs/run_123',
      options: { method: 'GET' },
      config: { token: 'test-token' },
      schema: z.object({ ok: z.boolean() }),
    });

    await expect(promise).rejects.toBe(networkError);
  });
});

describe('getProtectionBypassHeader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty object when env var is unset', () => {
    delete process.env.VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS;
    expect(getProtectionBypassHeader()).toEqual({});
  });

  it('returns empty object when env var is empty', () => {
    process.env.VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS = '';
    expect(getProtectionBypassHeader()).toEqual({});
  });

  it('returns x-vercel-protection-bypass header when env var is set', () => {
    process.env.VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS = 'my-bypass-secret';
    expect(getProtectionBypassHeader()).toEqual({
      'x-vercel-protection-bypass': 'my-bypass-secret',
    });
  });
});

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
    delete process.env.VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('omits x-vercel-protection-bypass when env var is unset', () => {
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-vercel-protection-bypass')).toBeNull();
  });

  it('sets x-vercel-protection-bypass when env var is set', () => {
    process.env.VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS = 'my-secret';
    const headers = getHeaders(undefined, { usingProxy: false });
    expect(headers.get('x-vercel-protection-bypass')).toBe('my-secret');
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
