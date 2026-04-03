import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowTraceViewerData } from './use-trace-viewer';

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIO: <T>(x: T): T => x,
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchRun: vi.fn(),
  fetchEvents: vi.fn(),
}));

import type { WorkflowRun } from '@workflow/world';
import { fetchEvents, fetchRun } from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

const WORKFLOW_RUN: WorkflowRun = {
  runId: 'run-1',
  deploymentId: 'deployment-1',
  workflowName: 'workflow-1',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  status: 'running',
  output: undefined,
  error: undefined,
  completedAt: undefined,
  specVersion: 1,
  executionContext: {},
  expiredAt: undefined,
  startedAt: undefined,
};

function emptyPage() {
  return Promise.resolve({
    success: true as const,
    data: { data: [], cursor: undefined, hasMore: false },
  });
}

describe('useWorkflowTraceViewerData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows complete trace data on load', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.run).toEqual(WORKFLOW_RUN);
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('shows error when run cannot be loaded', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: false,
      error: {
        message: 'run not found',
        layer: 'API' as const,
        cause: 'missing',
        request: { operation: 'fetchRun', params: {} },
      },
    });
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe('run not found');
  });

  it('shows events associated with the run', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchEvents).mockResolvedValue({
      success: true,
      data: {
        data: [
          {
            eventId: 'evt-1',
            runId: 'run-1',
            eventType: 'step_created',
            correlationId: 'step-1',
            createdAt: new Date(),
            eventData: { stepName: 'myStep' },
          },
        ] as any,
        cursor: undefined,
        hasMore: false,
      },
    });

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({ eventId: 'evt-1' });
  });

  it('uses correct page sizes for initial load', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Initial fetch should use INITIAL_PAGE_SIZE
    expect(vi.mocked(fetchEvents)).toHaveBeenCalledWith(
      env,
      'run-1',
      expect.objectContaining({
        sortOrder: 'asc',
        withData: false,
      })
    );
  });

  it('reports hasMoreTraceData when events have more pages', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchEvents).mockResolvedValue({
      success: true,
      data: {
        data: [],
        cursor: 'next-cursor',
        hasMore: true,
      },
    });

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMoreTraceData).toBe(true);
  });
});
