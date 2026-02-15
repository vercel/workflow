import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowResourceData } from './use-resource-data';

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIO: <T>(x: T): T => x,
  waitEventsToWaitEntity: vi.fn(),
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchRun: vi.fn(),
  fetchStep: vi.fn(),
  fetchHook: vi.fn(),
  fetchEventsByCorrelationId: vi.fn(),
}));

import { waitEventsToWaitEntity } from '@workflow/web-shared';
import type { WorkflowRun } from '@workflow/world';
import {
  fetchEventsByCorrelationId,
  fetchHook,
  fetchRun,
} from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

const WORKFLOW_RUN: WorkflowRun = {
  runId: 'run-1',
  deploymentId: 'deployment-1',
  workflowName: 'workflow-1',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  status: 'completed',
  output: { result: 42 },
  error: undefined,
  completedAt: new Date(),
  specVersion: 1,
  executionContext: {},
  expiredAt: undefined,
  startedAt: undefined,
};

describe('useWorkflowResourceData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches run resource data', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'run', 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(WORKFLOW_RUN);
    expect(result.current.error).toBeNull();
  });

  it('sets error when run fetch fails', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: false,
      error: {
        message: 'not found',
        layer: 'API' as const,
        cause: 'missing',
        request: { operation: 'fetchRun', params: {} },
      },
    });

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'run', 'run-1')
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error!.message).toBe('not found');
  });

  it('fetches hook resource data', async () => {
    const hook = {
      hookId: 'hook-1',
      runId: 'run-1',
      type: 'wait',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      url: 'https://example.com',
      token: 'tok-1',
    };
    vi.mocked(fetchHook).mockResolvedValue({
      success: true,
      data: hook as any,
    });

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'hook', 'hook-1')
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data).toEqual(hook);
    expect(fetchHook).toHaveBeenCalledWith(env, 'hook-1', 'all');
  });

  it('fetches sleep resource data from events', async () => {
    const events = [{ eventId: 'e1', type: 'sleep_scheduled', data: {} }];
    vi.mocked(fetchEventsByCorrelationId).mockResolvedValue({
      success: true,
      data: { data: events, cursor: undefined, hasMore: false } as any,
    });
    vi.mocked(waitEventsToWaitEntity).mockReturnValue({ id: 'sleep-1' } as any);

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'sleep', 'sleep-corr-1')
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(fetchEventsByCorrelationId).toHaveBeenCalledWith(
      env,
      'sleep-corr-1',
      expect.objectContaining({ withData: true })
    );
  });

  it('sets error when sleep data is null', async () => {
    vi.mocked(fetchEventsByCorrelationId).mockResolvedValue({
      success: true,
      data: { data: [], cursor: undefined, hasMore: false } as any,
    });
    vi.mocked(waitEventsToWaitEntity).mockReturnValue(null);

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'sleep', 'sleep-corr-1')
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error!.message).toContain(
      'missing required event data'
    );
  });

  it('does not fetch when enabled is false', async () => {
    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'run', 'run-1', { enabled: false })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchRun).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });
});
