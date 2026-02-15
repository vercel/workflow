import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowHooks } from './use-paginated-list';

vi.mock('~/lib/rpc-client', () => ({
  fetchHooks: vi.fn(),
  fetchRuns: vi.fn(),
}));

import type { Hook } from '@workflow/world';
import { fetchHooks } from '~/lib/rpc-client';

const mockFetchHooks = vi.mocked(fetchHooks);

const HOOK: Hook = {
  hookId: 'hook-1',
  runId: 'run-1',
  createdAt: new Date(),
  token: 'tok-1',
  ownerId: 'owner-1',
  projectId: 'proj-1',
  environment: 'development',
};

const env = { SOME_VAR: 'test' };

function makeHooksResponse(
  hooks: Hook[],
  opts: { cursor?: string; hasMore?: boolean } = {}
) {
  return Promise.resolve({
    success: true as const,
    data: {
      data: hooks,
      cursor: opts.cursor,
      hasMore: opts.hasMore ?? false,
    },
  });
}

describe('useWorkflowHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches initial page on mount', async () => {
    mockFetchHooks.mockReturnValue(makeHooksResponse([HOOK]));

    const { result } = renderHook(() =>
      useWorkflowHooks(env, { runId: 'run-1', limit: 10 })
    );

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.data.data).toEqual([HOOK]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasNextPage).toBe(false);
  });

  it('handles fetch error', async () => {
    mockFetchHooks.mockReturnValue(
      Promise.resolve({
        success: false,
        error: {
          message: 'fetch failed',
          layer: 'API' as const,
          cause: 'timeout',
          request: { operation: 'fetchHooks', params: {} },
        },
      })
    );

    const { result } = renderHook(() =>
      useWorkflowHooks(env, { runId: 'run-1', limit: 10 })
    );

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.data.data).toBeNull();
  });

  it('passes runId to fetchHooks', async () => {
    mockFetchHooks.mockReturnValue(makeHooksResponse([]));

    renderHook(() => useWorkflowHooks(env, { runId: 'run-42', limit: 5 }));

    await waitFor(() => {
      expect(mockFetchHooks).toHaveBeenCalled();
    });

    expect(mockFetchHooks).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ runId: 'run-42', limit: 5 })
    );
  });
});
