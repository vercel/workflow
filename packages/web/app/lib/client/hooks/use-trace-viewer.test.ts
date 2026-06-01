import { act, renderHook, waitFor } from '@testing-library/react';
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

// Mirrors AUTO_LOAD_MAX_EVENTS in use-trace-viewer.ts. Keep in sync.
const AUTO_LOAD_MAX_EVENTS = 500;

function makeEvents(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt-${start + i}`,
    runId: 'run-1',
    eventType: 'step_created',
    correlationId: `step-${start + i}`,
    createdAt: new Date(),
    eventData: {},
  })) as any;
}

function eventsPage(
  data: unknown[],
  { cursor, hasMore }: { cursor?: string; hasMore: boolean }
) {
  return { success: true as const, data: { data, cursor, hasMore } };
}

// `withData: true` is the one-shot encryption probe in fetchAllData — never a
// pagination fetch. Tests count only the real (withData: false) page fetches.
function isProbe(call: unknown[]): boolean {
  return Boolean((call[2] as { withData?: boolean } | undefined)?.withData);
}
function pageFetchCount(): number {
  return vi.mocked(fetchEvents).mock.calls.filter((c) => !isProbe(c)).length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  it('auto-backfills pages only until events reach AUTO_LOAD_MAX_EVENTS', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });

    // Every page reports more is available, so the only thing that can stop the
    // auto-backfill is the event cap itself.
    let next = 0;
    vi.mocked(fetchEvents).mockImplementation((_env, _runId, opts: any) => {
      if (opts?.withData) {
        return Promise.resolve(eventsPage([], { hasMore: false }));
      }
      const page = makeEvents(next, 100);
      next += 100;
      return Promise.resolve(
        eventsPage(page, { cursor: `c-${next}`, hasMore: true })
      );
    });

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.events).toHaveLength(AUTO_LOAD_MAX_EVENTS);
    });

    // Stopped exactly at the cap: initial page + 4 backfill pages (100 each),
    // even though hasMore is still true.
    expect(pageFetchCount()).toBe(5);
    expect(result.current.events).toHaveLength(AUTO_LOAD_MAX_EVENTS);
    expect(result.current.hasMoreTraceData).toBe(true);
  });

  it('does not load more once there are no more pages', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });
    vi.mocked(fetchEvents).mockImplementation((_env, _runId, opts: any) => {
      if (opts?.withData) {
        return Promise.resolve(eventsPage([], { hasMore: false }));
      }
      return Promise.resolve(eventsPage(makeEvents(0, 1), { hasMore: false }));
    });

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.hasMoreTraceData).toBe(false);

    const before = pageFetchCount();
    await act(async () => {
      await result.current.loadMoreTraceData();
    });

    // !eventsHasMore short-circuits loadMoreTraceData — no extra fetch.
    expect(pageFetchCount()).toBe(before);
  });

  it('does not load more while a load is already in flight', async () => {
    vi.mocked(fetchRun).mockResolvedValue({
      success: true,
      data: WORKFLOW_RUN,
    });

    const pending = deferred<ReturnType<typeof eventsPage>>();
    let initialDone = false;
    vi.mocked(fetchEvents).mockImplementation((_env, _runId, opts: any) => {
      if (opts?.withData) {
        return Promise.resolve(eventsPage([], { hasMore: false }));
      }
      if (!initialDone) {
        initialDone = true;
        // Initial page already at the cap so auto-backfill never fires; the
        // only load-more calls are the explicit ones below.
        return Promise.resolve(
          eventsPage(makeEvents(0, AUTO_LOAD_MAX_EVENTS), {
            cursor: 'c1',
            hasMore: true,
          })
        );
      }
      // The load-more fetch hangs so we can observe the in-flight guard.
      return pending.promise;
    });

    const { result } = renderHook(() =>
      useWorkflowTraceViewerData(env, 'run-1')
    );

    await waitFor(() => {
      expect(result.current.events).toHaveLength(AUTO_LOAD_MAX_EVENTS);
    });

    // Kick off a load-more that stays in flight.
    act(() => {
      void result.current.loadMoreTraceData();
    });
    await waitFor(() => {
      expect(result.current.isLoadingMoreTraceData).toBe(true);
    });
    expect(pageFetchCount()).toBe(2); // initial + first load-more

    // A second call while the first is in flight is a no-op.
    await act(async () => {
      await result.current.loadMoreTraceData();
    });
    expect(pageFetchCount()).toBe(2);

    // Let the in-flight load settle so there are no dangling state updates.
    await act(async () => {
      pending.resolve(eventsPage([], { hasMore: false }));
      await pending.promise;
    });
    await waitFor(() => {
      expect(result.current.isLoadingMoreTraceData).toBe(false);
    });
  });
});
