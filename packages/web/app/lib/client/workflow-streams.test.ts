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

  function mockFetchResponse(overrides: {
    ok?: boolean;
    status?: number;
    body?: ReadableStream | null;
    headers?: Record<string, string>;
    json?: () => Promise<unknown>;
  }) {
    const headers = new Headers(overrides.headers ?? {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      body: overrides.body ?? null,
      headers,
      json: overrides.json ?? (() => Promise.resolve(null)),
    });
  }

  it('returns body, cursor and done on success', async () => {
    const mockBody = new ReadableStream();
    mockFetchResponse({
      ok: true,
      body: mockBody,
      headers: { 'X-Stream-Cursor': 'abc123', 'X-Stream-Done': 'false' },
    });

    const result = await readStream(env, 'stream-1', 'run-1');
    expect(result.body).toBe(mockBody);
    expect(result.cursor).toBe('abc123');
    expect(result.done).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/stream/stream-1?runId=run-1',
      expect.any(Object)
    );
  });

  it('passes cursor as query parameter when provided', async () => {
    mockFetchResponse({
      ok: true,
      body: new ReadableStream(),
      headers: { 'X-Stream-Done': 'true' },
    });

    const result = await readStream(
      env,
      'stream-1',
      'run-1',
      undefined,
      'cur_xyz'
    );
    expect(result.done).toBe(true);
    expect(result.cursor).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/stream/stream-1?runId=run-1&cursor=cur_xyz',
      expect.any(Object)
    );
  });

  it('throws WorkflowWebAPIError when response is not ok', async () => {
    mockFetchResponse({ ok: false, status: 500 });

    await expect(readStream(env, 'stream-1', 'run-1')).rejects.toThrow(
      'Failed to read stream: 500'
    );
  });

  it('throws with structured error from response body when available', async () => {
    mockFetchResponse({
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

    await expect(readStream(env, 'stream-1', 'run-1')).rejects.toThrow(
      'invalid stream'
    );
  });

  it('throws WorkflowWebAPIError when body is null', async () => {
    mockFetchResponse({ ok: true, body: null });

    await expect(readStream(env, 'stream-1', 'run-1')).rejects.toThrow(
      'Failed to read stream: no body'
    );
  });

  it('wraps non-WorkflowWebAPIError in WorkflowWebAPIError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network fail'));

    const err = await readStream(env, 'stream-1', 'run-1').catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowWebAPIError);
    expect(err.message).toBe('Failed to read stream');
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});
