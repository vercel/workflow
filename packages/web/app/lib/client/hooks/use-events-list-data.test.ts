import { act, renderHook, waitFor } from '@testing-library/react';
import type { Event } from '@workflow/world';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEventsListData } from './use-events-list-data';

vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIOAsync: async <T>(value: T): Promise<T> => value,
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchEvent: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsByCorrelationId: vi.fn(),
}));

import { fetchEvents } from '~/lib/rpc-client';

const env = { SOME_VAR: 'test' };

function event(eventId: string, runId = 'run-1'): Event {
  return {
    eventId,
    runId,
    eventType: 'run_created',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    eventData: {},
  } as Event;
}

function page(data: Event[], cursor?: string) {
  return Promise.resolve({
    success: true as const,
    data: { data, cursor, hasMore: Boolean(cursor) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useEventsListData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps settled rows visible while the same query revalidates', async () => {
    const firstPage = [event('event-1')];
    vi.mocked(fetchEvents).mockReturnValue(page(firstPage, 'cursor-1'));

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useEventsListData(env, 'run-1', { enabled, sortOrder: 'asc' }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.events).toEqual(firstPage);
    expect(result.current.hasMore).toBe(true);

    const revalidation = deferred<Awaited<ReturnType<typeof fetchEvents>>>();
    vi.mocked(fetchEvents).mockReturnValue(revalidation.promise);

    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual(firstPage);
    expect(result.current.hasMore).toBe(true);
    expect(fetchEvents).toHaveBeenCalledTimes(2);

    await act(async () => {
      revalidation.resolve({
        success: true,
        data: { data: [event('event-2')], hasMore: false },
      });
    });
    await waitFor(() =>
      expect(result.current.events).toEqual([event('event-2')])
    );
  });

  it('cold-resets rows when the query identity changes', async () => {
    vi.mocked(fetchEvents).mockReturnValue(page([event('event-1')]));

    const { result, rerender } = renderHook(
      ({ sortOrder }) =>
        useEventsListData(env, 'run-1', { enabled: true, sortOrder }),
      { initialProps: { sortOrder: 'asc' as const } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const nextQuery = deferred<Awaited<ReturnType<typeof fetchEvents>>>();
    vi.mocked(fetchEvents).mockReturnValue(nextQuery.promise);
    rerender({ sortOrder: 'desc' as const });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.events).toEqual([]);

    await act(async () => {
      nextQuery.resolve({
        success: true,
        data: { data: [event('event-2')], hasMore: false },
      });
    });
  });

  it('refreshes the same number of pages loaded before tab reentry', async () => {
    vi.mocked(fetchEvents).mockReturnValue(
      page([event('event-1')], 'cursor-1')
    );
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useEventsListData(env, 'run-1', { enabled, sortOrder: 'asc' }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(fetchEvents).mockReturnValue(page([event('event-2')]));
    await act(async () => result.current.loadMore());
    expect(result.current.events).toEqual([event('event-1'), event('event-2')]);

    const refreshedFirstPage =
      deferred<Awaited<ReturnType<typeof fetchEvents>>>();
    vi.mocked(fetchEvents)
      .mockReturnValueOnce(refreshedFirstPage.promise)
      .mockReturnValueOnce(page([event('event-3')]));
    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual([event('event-1'), event('event-2')]);

    await act(async () => {
      refreshedFirstPage.resolve({
        success: true,
        data: {
          data: [event('event-1')],
          cursor: 'refreshed-cursor-1',
          hasMore: true,
        },
      });
    });
    await waitFor(() =>
      expect(result.current.events).toEqual([
        event('event-1'),
        event('event-3'),
      ])
    );
  });

  it('ignores pagination that resolves after the query changes', async () => {
    vi.mocked(fetchEvents).mockReturnValue(
      page([event('event-1')], 'cursor-1')
    );

    const { result, rerender } = renderHook(
      ({ sortOrder }) =>
        useEventsListData(env, 'run-1', { enabled: true, sortOrder }),
      { initialProps: { sortOrder: 'asc' as const } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const stalePage = deferred<Awaited<ReturnType<typeof fetchEvents>>>();
    vi.mocked(fetchEvents).mockReturnValue(stalePage.promise);
    let staleLoadMore: Promise<void> | undefined;
    act(() => {
      staleLoadMore = result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    vi.mocked(fetchEvents).mockReturnValue(page([event('event-2')]));
    rerender({ sortOrder: 'desc' as const });
    await waitFor(() =>
      expect(result.current.events).toEqual([event('event-2')])
    );

    await act(async () => {
      stalePage.resolve({
        success: true,
        data: { data: [event('stale-event')], hasMore: false },
      });
      await staleLoadMore;
    });

    expect(result.current.events).toEqual([event('event-2')]);
  });
});
