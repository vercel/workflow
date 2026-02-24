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
  fetchEventsByCorrelationId: vi.fn(),
}));

import type { WorkflowRun } from '@workflow/world';
import {
  fetchEvents,
  fetchEventsByCorrelationId,
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

function emptyPage() {
  return Promise.resolve({
    success: true as const,
    data: { data: [], cursor: undefined, hasMore: false },
  });
}

describe('useWorkflowTraceViewerData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchEventsByCorrelationId).mockReturnValue(emptyPage());
  });

  it('shows complete trace data on load', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchSteps).mockReturnValue(emptyPage());
    vi.mocked(fetchHooks).mockReturnValue(emptyPage());
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

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
    vi.mocked(fetchSteps).mockReturnValue(emptyPage());
    vi.mocked(fetchHooks).mockReturnValue(emptyPage());
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe('run not found');
  });

  it('shows steps associated with the run', async () => {
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
    vi.mocked(fetchHooks).mockReturnValue(emptyPage());
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0]).toMatchObject({ stepId: 'step-1' });
  });

  it('shows hooks associated with the run', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchSteps).mockReturnValue(emptyPage());
    vi.mocked(fetchHooks).mockResolvedValue({
      success: true,
      data: {
        data: [
          {
            hookId: 'hook-1',
            runId: 'run-1',
            createdAt: new Date(),
            token: 'tok-1',
            ownerId: 'owner-1',
            projectId: 'proj-1',
            environment: 'development',
          },
        ] as any,
        cursor: undefined,
        hasMore: false,
      },
    });
    vi.mocked(fetchEvents).mockReturnValue(emptyPage());

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hooks).toHaveLength(1);
    expect(result.current.hooks[0]).toMatchObject({ hookId: 'hook-1' });
  });
});
