import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSpanDetailResource,
  useWorkflowResourceData,
} from './use-resource-data';

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIOAsync: vi.fn(async <T>(x: T): Promise<T> => x),
  waitEventsToWaitEntity: vi.fn(),
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchRun: vi.fn(),
  fetchStep: vi.fn(),
  fetchHook: vi.fn(),
  fetchEvents: vi.fn(),
}));

import {
  hydrateResourceIOAsync,
  waitEventsToWaitEntity,
} from '@workflow/web-shared';
import type { Step, WorkflowRun } from '@workflow/world';
import { fetchEvents, fetchHook, fetchRun, fetchStep } from '~/lib/rpc-client';

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

describe('useWorkflowResourceData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows run data after loading', async () => {
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

  it('shows error when run fetch fails', async () => {
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

    expect(result.current.error?.message).toBe('not found');
  });

  it('shows hook data after loading', async () => {
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
    expect(result.current.error).toBeNull();
  });

  it('hydrates step data through the async path without an encryption key', async () => {
    const rawStep = {
      runId: 'run-1',
      stepId: 'step-1',
      stepName: 'step-1',
      status: 'failed',
      input: new Uint8Array([1, 2, 3]),
      error: new Uint8Array([122, 115, 116, 100]),
      attempt: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      specVersion: 5,
    } as Step;
    const hydratedStep = {
      ...rawStep,
      error: new Error('Fatal step error'),
    } as Step;

    vi.mocked(fetchStep).mockResolvedValue({
      success: true,
      data: rawStep,
    });
    vi.mocked(hydrateResourceIOAsync).mockResolvedValueOnce(hydratedStep);

    await expect(
      fetchSpanDetailResource(env, {
        resource: 'step',
        resourceId: 'step-1',
        runId: 'run-1',
      })
    ).resolves.toBe(hydratedStep);

    expect(hydrateResourceIOAsync).toHaveBeenCalledWith(rawStep, undefined);
  });

  it('shows sleep entity constructed from events', async () => {
    const events = [
      {
        eventId: 'e1',
        type: 'sleep_scheduled',
        correlationId: 'sleep-corr-1',
        data: {},
      },
      {
        eventId: 'e2',
        type: 'other_event',
        correlationId: 'other-id',
        data: {},
      },
    ];
    vi.mocked(fetchEvents).mockResolvedValue({
      success: true,
      data: { data: events, cursor: undefined, hasMore: false } as any,
    });
    vi.mocked(waitEventsToWaitEntity).mockReturnValue({ id: 'sleep-1' } as any);

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'sleep', 'sleep-corr-1', { runId: 'run-1' })
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data).toEqual({ id: 'sleep-1' });
    expect(result.current.error).toBeNull();
  });

  it('shows error when sleep event data is missing', async () => {
    vi.mocked(fetchEvents).mockResolvedValue({
      success: true,
      data: { data: [], cursor: undefined, hasMore: false } as any,
    });
    vi.mocked(waitEventsToWaitEntity).mockReturnValue(null);

    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'sleep', 'sleep-corr-1', { runId: 'run-1' })
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain(
      'missing required event data'
    );
  });

  it('returns null data and stays idle when disabled', async () => {
    const { result } = renderHook(() =>
      useWorkflowResourceData(env, 'run', 'run-1', { enabled: false })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
