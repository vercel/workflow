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

import { makeRequest } from './utils.js';

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
