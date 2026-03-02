import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowWebAPIError } from './workflow-errors';
import { listStreams, readStream } from './workflow-streams';

vi.mock('~/lib/rpc-client', () => ({
  fetchStreams: vi.fn(),
}));

import { fetchStreams } from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── listStreams ─────────────────────────────────────────────────────────────

describe('listStreams', () => {
  it('returns stream IDs on success', async () => {
    vi.mocked(fetchStreams).mockResolvedValue({
      success: true,
      data: ['stream-1', 'stream-2'],
    });
    const result = await listStreams(env, 'run-1');
    expect(result).toEqual(['stream-1', 'stream-2']);
  });

  it('throws WorkflowWebAPIError on failure', async () => {
    vi.mocked(fetchStreams).mockResolvedValue({
      success: false,
      error: {
        message: 'not found',
        layer: 'API' as const,
        cause: 'missing',
        request: { operation: 'fetchStreams', params: {} },
      },
    });
    await expect(listStreams(env, 'run-1')).rejects.toThrow(
      WorkflowWebAPIError
    );
  });
});

// ─── readStream ──────────────────────────────────────────────────────────────

describe('readStream', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns response body on success', async () => {
    const mockBody = new ReadableStream();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    const result = await readStream(env, 'stream-1');
    expect(result).toBe(mockBody);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/stream/stream-1',
      expect.any(Object)
    );
  });

  it('includes startIndex query param when provided', async () => {
    const mockBody = new ReadableStream();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockBody,
    });

    await readStream(env, 'stream-1', 5);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/stream/stream-1?startIndex=5',
      expect.any(Object)
    );
  });

  it('throws WorkflowWebAPIError when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve(null),
    });

    await expect(readStream(env, 'stream-1')).rejects.toThrow(
      'Failed to read stream: 500'
    );
  });

  it('throws with structured error from response body when available', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          message: 'invalid stream',
          layer: 'API',
          cause: 'bad id',
          request: { operation: 'readStream', params: {} },
        }),
    });

    await expect(readStream(env, 'stream-1')).rejects.toThrow('invalid stream');
  });

  it('throws WorkflowWebAPIError when body is null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });

    await expect(readStream(env, 'stream-1')).rejects.toThrow(
      'Failed to read stream: no body'
    );
  });

  it('wraps non-WorkflowWebAPIError in WorkflowWebAPIError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network fail'));

    const err = await readStream(env, 'stream-1').catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowWebAPIError);
    expect(err.message).toBe('Failed to read stream');
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});
