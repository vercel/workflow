import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getErrorMessage,
  unwrapServerActionResult,
  useWorkflowRuns,
  WorkflowWebAPIError,
} from './workflow-api-client';

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
// Mock dependencies
vi.mock('@workflow/errors', () => ({
  VERCEL_403_ERROR_MESSAGE:
    'You do not have permission to access this resource.',
}));

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIO: <T>(x: T): T => x,
  waitEventsToWaitEntity: vi.fn(),
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchRuns: vi.fn(),
  fetchRun: vi.fn(),
  fetchSteps: vi.fn(),
  fetchHooks: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsByCorrelationId: vi.fn(),
  fetchStep: vi.fn(),
  fetchHook: vi.fn(),
  fetchStreams: vi.fn(),
  cancelRun: vi.fn(),
  recreateRun: vi.fn(),
  reenqueueRun: vi.fn(),
  resumeHook: vi.fn(),
  wakeUpRun: vi.fn(),
}));

import type { WorkflowRun } from '@workflow/world';

// Import the mock so we can control it in tests
import { fetchRuns } from '~/lib/rpc-client';

const mockFetchRuns = vi.mocked(fetchRuns);

// ─── WorkflowWebAPIError ────────────────────────────────────────────

describe('WorkflowWebAPIError', () => {
  it('sets name, message, layer, request, and cause', () => {
    const cause = new Error('root cause');
    const request = { operation: 'fetchRuns', params: {}, status: 500 };

    const err = new WorkflowWebAPIError('something broke', {
      cause,
      request,
      layer: 'API',
    });

    expect(err.name).toBe('WorkflowWebAPIError');
    expect(err.message).toBe('something broke');
    expect(err.layer).toBe('API');
    expect(err.request).toBe(request);
    expect(err.cause).toBe(cause);
  });

  it('is an instance of Error', () => {
    const err = new WorkflowWebAPIError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('appends cause stack when cause is an Error', () => {
    const cause = new Error('inner');
    const err = new WorkflowWebAPIError('outer', { cause });
    expect(err.stack).toContain('Caused by:');
  });
});

// ─── getErrorMessage ────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('returns 403 message for WorkflowWebAPIError with status 403', () => {
    const err = new WorkflowWebAPIError('forbidden', {
      layer: 'API',
      request: { operation: 'fetchRuns', params: {}, status: 403 },
    });
    expect(getErrorMessage(err)).toBe(
      'You do not have permission to access this resource.'
    );
  });

  it('returns message for errors with layer', () => {
    const err = new WorkflowWebAPIError('server error', { layer: 'server' });
    expect(getErrorMessage(err)).toBe('server error');
  });

  it('returns message for plain Error', () => {
    const err = new Error('plain error');
    expect(getErrorMessage(err)).toBe('plain error');
  });
});

// ─── unwrapServerActionResult ───────────────────────────────────────

describe('unwrapServerActionResult', () => {
  it('returns data on success', async () => {
    const result = await unwrapServerActionResult(
      Promise.resolve({ success: true, data: { id: '1' } })
    );
    expect(result.error).toBeNull();
    expect(result.result).toEqual({ id: '1' });
  });

  it('returns WorkflowWebAPIError on failure with error info', async () => {
    const result = await unwrapServerActionResult(
      Promise.resolve({
        success: false,
        error: {
          message: 'not found',
          layer: 'API' as const,
          cause: 'missing',
          request: { operation: 'fetchRun', params: { id: '1' }, status: 404 },
        },
      })
    );
    expect(result.error).toBeInstanceOf(WorkflowWebAPIError);
    expect(result.error!.message).toBe('not found');
    expect(result.result).toBeNull();
  });

  it('returns unknown error when failure has no error details', async () => {
    const result = await unwrapServerActionResult(
      Promise.resolve({ success: false })
    );
    expect(result.error).toBeInstanceOf(WorkflowWebAPIError);
    expect(result.error!.message).toBe('Unknown error occurred');
  });

  it('handles thrown promise rejection', async () => {
    const result = await unwrapServerActionResult(
      Promise.reject(new Error('network error'))
    );
    expect(result.error).toBeInstanceOf(WorkflowWebAPIError);
    expect(result.result).toBeNull();
  });
});

// ─── useWorkflowRuns ────────────────────────────────────────────────

const env = { SOME_VAR: 'test' };

function makeRunsResponse(
  runs: Array<WorkflowRun>,
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

describe('useWorkflowRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches initial page on mount and returns data', async () => {
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

    expect(result.current.error).toBeInstanceOf(WorkflowWebAPIError);
    expect(result.current.data.data).toBeNull();
  });

  it('nextPage fetches with cursor', async () => {
    // Page 1: has more
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse(
        [
          {
            ...WORKFLOW_RUN,
          },
        ],
        {
          cursor: 'cursor-1',
          hasMore: true,
        }
      )
    );

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 1 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    expect(result.current.hasNextPage).toBe(true);

    // Page 2
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse(
        [
          {
            ...WORKFLOW_RUN,
          },
        ],
        { hasMore: false }
      )
    );

    act(() => {
      result.current.nextPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    // The second call should have used cursor-1
    expect(mockFetchRuns).toHaveBeenLastCalledWith(
      env,
      expect.objectContaining({ cursor: 'cursor-1' })
    );
  });

  it('previousPage returns to cached page', async () => {
    // Page 1
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], {
        cursor: 'cursor-1',
        hasMore: true,
      })
    );

    const { result } = renderHook(() => useWorkflowRuns(env, { limit: 1 }));

    await waitFor(() => {
      expect(result.current.data.isLoading).toBe(false);
    });

    // Go to page 2
    mockFetchRuns.mockReturnValueOnce(
      makeRunsResponse([WORKFLOW_RUN], { hasMore: false })
    );

    act(() => {
      result.current.nextPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    // Go back - should use cache, no new fetch needed
    const callsBefore = mockFetchRuns.mock.calls.length;

    act(() => {
      result.current.previousPage();
    });

    await waitFor(() => {
      expect(result.current.data.data).toEqual([WORKFLOW_RUN]);
    });

    // Should not have made a new fetch (used cache)
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
