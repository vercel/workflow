import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  usePaginatedList,
  useWorkflowHooks,
  useWorkflowRuns,
} from './use-paginated-list';

vi.mock('~/lib/rpc-client', () => ({
  fetchHooks: vi.fn(),
  fetchRuns: vi.fn(),
}));

import type { Hook, WorkflowRun } from '@workflow/world';
import { fetchHooks, fetchRuns } from '~/lib/rpc-client';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const env = { SOME_VAR: 'test' };

const RUN: WorkflowRun = {
  runId: 'run-1',
  deploymentId: 'dep-1',
  workflowName: 'wf-1',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  status: 'pending',
  output: undefined,
  error: undefined,
  completedAt: undefined,
  specVersion: 1,
  executionContext: {},
  expiredAt: undefined,
  startedAt: undefined,
};

const HOOK: Hook = {
  hookId: 'hook-1',
  runId: 'run-1',
  createdAt: new Date(),
  token: 'tok-1',
  ownerId: 'owner-1',
  projectId: 'proj-1',
  environment: 'development',
};

/** Resolved PaginatedResult for usePaginatedList's fetchFn */
function page<T>(data: T[], opts: { cursor?: string; hasMore?: boolean } = {}) {
  return Promise.resolve({
    data,
    cursor: opts.cursor,
    hasMore: opts.hasMore ?? false,
  });
}

/** Resolved rpc-client result for useWorkflowRuns/useWorkflowHooks mocks */
function rpcPage<T>(
  data: T[],
  opts: { cursor?: string; hasMore?: boolean } = {}
) {
  return Promise.resolve({
    success: true as const,
    data: { data, cursor: opts.cursor, hasMore: opts.hasMore ?? false },
  });
}

function rpcError(message: string) {
  return Promise.resolve({
    success: false as const,
    error: {
      message,
      layer: 'API' as const,
      cause: 'test',
      request: { operation: 'test', params: {} },
    },
  });
}

// ─── usePaginatedList ───────────────────────────────────────────────────────

describe('usePaginatedList', () => {
  it('shows first page data after loading', async () => {
    const fetchFn = vi.fn().mockReturnValue(page(['a', 'b']));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.data.data).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
  });

  it('shows error when fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.error?.message).toBe('network error');
    expect(result.current.data.data).toBeNull();
  });

  it('has no next or previous page when server returns a single page', async () => {
    const fetchFn = vi.fn().mockReturnValue(page(['a'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it('signals next page available when server returns hasMore', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValue(page(['a'], { cursor: 'c1', hasMore: true }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.hasNextPage).toBe(true);
  });

  it('shows second page data and enables back navigation after nextPage()', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['page-1'], { cursor: 'c1', hasMore: true }))
      .mockReturnValueOnce(page(['page-2'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });

    await waitFor(() => expect(result.current.data.data).toEqual(['page-2']));

    expect(result.current.hasPreviousPage).toBe(true);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.currentPage).toBe(1);
  });

  it('returns to first page after previousPage()', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['page-1'], { cursor: 'c1', hasMore: true }))
      .mockReturnValue(page(['page-2'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['page-2']));

    act(() => {
      result.current.previousPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['page-1']));

    expect(result.current.hasPreviousPage).toBe(false);
    expect(result.current.currentPage).toBe(0);
  });

  it('back navigation returns the original page data even if server state has changed', async () => {
    // fetchFn returns different data on each call — cache should serve the original
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['original'], { cursor: 'c1', hasMore: true }))
      .mockReturnValueOnce(page(['page-2'], { hasMore: false }))
      .mockReturnValue(page(['would-overwrite-if-refetched']));

    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['page-2']));

    act(() => {
      result.current.previousPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['original']));
  });

  it('reload resets to page 1 with fresh data', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['page-1'], { cursor: 'c1', hasMore: true }))
      .mockReturnValueOnce(page(['page-2'], { hasMore: false }))
      .mockReturnValue(page(['refreshed'], { hasMore: false }));

    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['page-2']));

    act(() => {
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.data.data).toEqual(['refreshed'])
    );

    expect(result.current.currentPage).toBe(0);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it('refresh reloads current page with fresh data without resetting to page 1', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['page-1'], { cursor: 'c1', hasMore: true }))
      .mockReturnValueOnce(page(['page-2'], { hasMore: false }))
      .mockReturnValue(page(['page-2-refreshed'], { hasMore: false }));

    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.data.data).toEqual(['page-2']));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.data.data).toEqual(['page-2-refreshed'])
    );

    expect(result.current.currentPage).toBe(1);
  });

  it('nextPage() is a no-op when there is no next page', async () => {
    const fetchFn = vi.fn().mockReturnValue(page(['a'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.nextPage();
    });

    // Data and page position are unchanged
    expect(result.current.data.data).toEqual(['a']);
    expect(result.current.currentPage).toBe(0);
  });

  it('previousPage() is a no-op when already on the first page', async () => {
    const fetchFn = vi.fn().mockReturnValue(page(['a'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    act(() => {
      result.current.previousPage();
    });

    expect(result.current.data.data).toEqual(['a']);
    expect(result.current.currentPage).toBe(0);
  });

  it('tracks currentPage as the user navigates forward', async () => {
    const fetchFn = vi
      .fn()
      .mockReturnValueOnce(page(['a'], { cursor: 'c1', hasMore: true }))
      .mockReturnValueOnce(page(['b'], { cursor: 'c2', hasMore: true }))
      .mockReturnValue(page(['c'], { hasMore: false }));
    const { result } = renderHook(() => usePaginatedList(fetchFn));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));
    expect(result.current.currentPage).toBe(0);

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.currentPage).toBe(1));

    act(() => {
      result.current.nextPage();
    });
    await waitFor(() => expect(result.current.currentPage).toBe(2));
  });
});

// ─── useWorkflowRuns ───────────────────────────────────────────────────────

describe('useWorkflowRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows runs from the server', async () => {
    vi.mocked(fetchRuns).mockReturnValue(rpcPage([RUN]));

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 10 }));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.data.data).toEqual([RUN]);
    expect(result.current.error).toBeNull();
  });

  it('shows error when server returns failure', async () => {
    vi.mocked(fetchRuns).mockReturnValue(rpcError('fetch failed'));

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 10 }));

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.error).not.toBeNull();
    expect(result.current.data.data).toBeNull();
  });

  it('refetches when the workflowName filter changes', async () => {
    vi.mocked(fetchRuns)
      .mockReturnValueOnce(rpcPage([RUN]))
      .mockReturnValue(rpcPage([]));

    const { result, rerender } = renderHook(
      ({ workflowName }: { workflowName?: string }) =>
        useWorkflowRuns(env, { workflowName, limit: 10 }),
      { initialProps: { workflowName: undefined as string | undefined } }
    );

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));
    expect(result.current.data.data).toEqual([RUN]);

    rerender({ workflowName: 'other-workflow' });

    await waitFor(() => expect(result.current.data.data).toEqual([]));
  });
});

// ─── useWorkflowHooks ─────────────────────────────────────────────────────

describe('useWorkflowHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows hooks from the server', async () => {
    vi.mocked(fetchHooks).mockReturnValue(rpcPage([HOOK]));

    const { result } = renderHook(() =>
      useWorkflowHooks(env, { runId: 'run-1', limit: 10 })
    );

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.data.data).toEqual([HOOK]);
    expect(result.current.error).toBeNull();
  });

  it('shows error when server returns failure', async () => {
    vi.mocked(fetchHooks).mockReturnValue(rpcError('fetch failed'));

    const { result } = renderHook(() =>
      useWorkflowHooks(env, { runId: 'run-1', limit: 10 })
    );

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));

    expect(result.current.error).not.toBeNull();
    expect(result.current.data.data).toBeNull();
  });

  it('refetches when the runId filter changes', async () => {
    vi.mocked(fetchHooks)
      .mockReturnValueOnce(rpcPage([HOOK]))
      .mockReturnValue(rpcPage([]));

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) =>
        useWorkflowHooks(env, { runId, limit: 10 }),
      { initialProps: { runId: 'run-1' } }
    );

    await waitFor(() => expect(result.current.data.isLoading).toBe(false));
    expect(result.current.data.data).toEqual([HOOK]);

    rerender({ runId: 'run-2' });

    await waitFor(() => expect(result.current.data.data).toEqual([]));
  });
});
