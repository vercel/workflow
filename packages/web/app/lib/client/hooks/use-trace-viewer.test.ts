import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowTraceViewerData } from './use-trace-viewer';

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIO: <T>(x: T): T => x,
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchRun: vi.fn(),
  fetchSteps: vi.fn(),
  fetchHooks: vi.fn(),
  fetchEvents: vi.fn(),
}));

import type { WorkflowRun } from '@workflow/world';
import {
  fetchEvents,
  fetchHooks,
  fetchRun,
  fetchSteps,
} from '~/lib/rpc-client';

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

function emptyPaginatedResult() {
  return Promise.resolve({
    success: true as const,
    data: { data: [], cursor: undefined, hasMore: false },
  });
}

describe('useWorkflowTraceViewerData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches run, steps, hooks, and events on mount', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchSteps).mockReturnValue(emptyPaginatedResult());
    vi.mocked(fetchHooks).mockReturnValue(emptyPaginatedResult());
    vi.mocked(fetchEvents).mockReturnValue(emptyPaginatedResult());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.run).toEqual(WORKFLOW_RUN);
    expect(result.current.steps).toEqual([]);
    expect(result.current.hooks).toEqual([]);
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('sets error when fetchRun fails', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: false,
      error: {
        message: 'run not found',
        layer: 'API' as const,
        cause: 'missing',
        request: { operation: 'fetchRun', params: {} },
      },
    });
    vi.mocked(fetchSteps).mockReturnValue(emptyPaginatedResult());
    vi.mocked(fetchHooks).mockReturnValue(emptyPaginatedResult());
    vi.mocked(fetchEvents).mockReturnValue(emptyPaginatedResult());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.error!.message).toBe('run not found');
  });

  it('populates steps from paginated fetch', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchSteps).mockResolvedValue({
      success: true,
      data: {
        data: [
          {
            stepId: 'step-1',
            runId: 'run-1',
            status: 'completed',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ] as any,
        cursor: undefined,
        hasMore: false,
      },
    });
    vi.mocked(fetchHooks).mockReturnValue(emptyPaginatedResult());
    vi.mocked(fetchEvents).mockReturnValue(emptyPaginatedResult());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]).toMatchObject({ stepId: 'step-1' });
  });
});
