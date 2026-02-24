import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowHooks, useWorkflowRuns } from './use-paginated-list';

vi.mock('~/lib/rpc-client', () => ({
  fetchHooks: vi.fn(),
  fetchRuns: vi.fn(),
}));

import type { Hook, WorkflowRun } from '@workflow/world';
import { fetchHooks, fetchRuns } from '~/lib/rpc-client';

const mockFetchHooks = vi.mocked(fetchHooks);
const mockFetchRuns = vi.mocked(fetchRuns);

const HOOK: Hook = {
  hookId: 'hook-1',
  runId: 'run-1',
  createdAt: new Date(),
  token: 'tok-1',
  ownerId: 'owner-1',
  projectId: 'proj-1',
  environment: 'development',
};

const WORKFLOW_RUN: WorkflowRun = {
  runId: 'run-1',
  deploymentId: 'deployment-1',
  workflowName: 'workflow-1',
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

function makeRunsResponse(
  runs: WorkflowRun[],
  opts: { cursor?: string; hasMore?: boolean } = {}
) {
  return Promise.resolve({
    success: true as const,
    data: {
      data: runs,
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

describe('useWorkflowRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches initial page on mount', async () => {
    mockFetchRuns.mockReturnValue(makeRunsResponse([WORKFLOW_RUN]));

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 10 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it('handles fetch error', async () => {
    mockFetchRuns.mockReturnValue(
      Promise.resolve({
        success: false,
        error: {
          message: 'fetch failed',
          layer: 'API' as const,
          cause: 'timeout',
          request: { operation: 'fetchRuns', params: {} },
        },
      })
    );

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 10 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.data.data).toBeNull();
  });

  it('nextPage fetches with cursor', async () => {
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], { cursor: 'cursor-1', hasMore: true })
    );

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 1 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.hasNextPage).toBe(true);

    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], { hasMore: false })
    );

    act(() => {
      result.current.nextPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    expect(mockFetchRuns).toHaveBeenLastCalledWith(
      env,
      expect.objectContaining({ cursor: 'cursor-1' })
    );
  });

  it('previousPage returns to cached page without refetching', async () => {
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], { cursor: 'cursor-1', hasMore: true })
    );

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 1 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], { hasMore: false })
    );

    act(() => {
      result.current.nextPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    const callsBefore = mockFetchRuns.mock.calls.length;

    act(() => {
      result.current.previousPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    expect(mockFetchRuns.mock.calls.length).toBe(callsBefore);
  });

  it('reload clears cache and refetches', async () => {
    mockFetchRuns.mockReturnValue(makeRunsResponse([WORKFLOW_RUN]));

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 10 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    const callsBefore = mockFetchRuns.mock.calls.length;

    mockFetchRuns.mockReturnValue(makeRunsResponse([WORKFLOW_RUN]));

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    expect(mockFetchRuns.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
