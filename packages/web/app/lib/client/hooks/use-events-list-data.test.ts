import { act, render, waitFor } from '@testing-library/react';
import type { Event } from '@workflow/world';
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaginatedResult, ServerActionResult } from '~/lib/types';
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

type EventsResponse = ServerActionResult<PaginatedResult<Event>>;

interface Props {
  /** Whether the Events tab is selected. Defaults to true. */
  active?: boolean;
  sortOrder?: 'asc' | 'desc';
  encryptionKey?: Uint8Array;
}

const env = { SOME_VAR: 'test' };

function event(eventId: string): Event {
  return {
    eventId,
    runId: 'run-1',
    eventType: 'run_created',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    eventData: {},
  } as Event;
}

/** A page of events; passing a cursor means another page follows. */
function page(eventIds: string[], cursor?: string): EventsResponse {
  return {
    success: true,
    data: { data: eventIds.map(event), cursor, hasMore: Boolean(cursor) },
  };
}

function failure(message: string): EventsResponse {
  return { success: false, error: { message, layer: 'server' } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const ids = (events: Event[]) => events.map((e) => e.eventId);

/**
 * Renders the hook in a tab that is mounted only while `active`, under a page
 * that stays, as the run page does. Each call gets its own SWR cache.
 */
function renderEventsList(initialProps: Props = {}) {
  const cache = new Map();
  const swrConfig = { provider: () => cache };
  const result = {} as { current: ReturnType<typeof useEventsListData> };

  function Tab(options: Omit<Props, 'active'>) {
    result.current = useEventsListData(env, 'run-1', options);
    return null;
  }
  function Page({ active = true, ...options }: Props) {
    return createElement(
      SWRConfig,
      { value: swrConfig },
      active ? createElement(Tab, options) : null
    );
  }

  const view = render(createElement(Page, initialProps));
  return {
    result,
    rerender: (props: Props) => view.rerender(createElement(Page, props)),
  };
}

describe('useEventsListData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps the rows on screen while a re-entered tab reads them again', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1'], 'cursor-1'));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    const reread = deferred<EventsResponse>();
    vi.mocked(fetchEvents).mockReturnValueOnce(reread.promise);
    rerender({ active: false });
    rerender({ active: true });

    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(ids(result.current.events)).toEqual(['event-1']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadingMore).toBe(false);

    await act(async () => reread.resolve(page(['event-2'])));
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-2'])
    );
    expect(result.current.hasMore).toBe(false);
  });

  it('starts empty when the query changes', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1']));
    const { result, rerender } = renderEventsList({ sortOrder: 'asc' });
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    const nextQuery = deferred<EventsResponse>();
    vi.mocked(fetchEvents).mockReturnValueOnce(nextQuery.promise);
    rerender({ sortOrder: 'desc' });

    expect(result.current.loading).toBe(true);
    expect(result.current.events).toEqual([]);

    await act(async () => nextQuery.resolve(page(['event-2'])));
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-2'])
    );
  });

  it('reads the same number of pages again on re-entry', async () => {
    vi.mocked(fetchEvents)
      .mockResolvedValueOnce(page(['event-1'], 'cursor-1'))
      .mockResolvedValueOnce(page(['event-2']));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1', 'event-2'])
    );

    vi.mocked(fetchEvents)
      .mockResolvedValueOnce(page(['event-1'], 'reread-cursor-1'))
      .mockResolvedValueOnce(page(['event-3']));
    rerender({ active: false });
    rerender({ active: true });

    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1', 'event-3'])
    );
    expect(fetchEvents).toHaveBeenCalledTimes(4);
  });

  it('holds pagination until the re-read settles, then pages from its cursor', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1'], 'cursor-1'));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    const reread = deferred<EventsResponse>();
    vi.mocked(fetchEvents)
      .mockReturnValueOnce(reread.promise)
      .mockResolvedValueOnce(page(['event-2']));
    rerender({ active: false });
    rerender({ active: true });

    act(() => result.current.loadMore());
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(result.current.loadingMore).toBe(false);

    await act(async () => reread.resolve(page(['event-1'], 'reread-cursor-1')));
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1', 'event-2'])
    );
    expect(fetchEvents).toHaveBeenLastCalledWith(env, 'run-1', {
      cursor: 'reread-cursor-1',
      sortOrder: 'asc',
      limit: 100,
      withData: false,
    });
  });

  it('keeps the rows when the re-read fails', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1'], 'cursor-1'));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    vi.mocked(fetchEvents).mockResolvedValueOnce(failure('boom'));
    rerender({ active: false });
    rerender({ active: true });

    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(ids(result.current.events)).toEqual(['event-1']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('ignores a page that resolves after the query changed', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1'], 'cursor-1'));
    const { result, rerender } = renderEventsList({ sortOrder: 'asc' });
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    const stalePage = deferred<EventsResponse>();
    vi.mocked(fetchEvents).mockReturnValueOnce(stalePage.promise);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-2']));
    rerender({ sortOrder: 'desc' });
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-2'])
    );

    await act(async () => stalePage.resolve(page(['stale-event'])));
    expect(ids(result.current.events)).toEqual(['event-2']);
    expect(result.current.loadingMore).toBe(false);
  });

  it('reports a first load that fails after the tab was left and re-entered', async () => {
    const firstLoad = deferred<EventsResponse>();
    vi.mocked(fetchEvents).mockReturnValueOnce(firstLoad.promise);
    const { result, rerender } = renderEventsList();
    expect(result.current.loading).toBe(true);

    rerender({ active: false });
    rerender({ active: true });
    expect(result.current.loading).toBe(true);

    await act(async () => firstLoad.resolve(failure('boom')));
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.loading).toBe(false);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
  });

  it('loads one page for a query that never loaded, whatever another had', async () => {
    vi.mocked(fetchEvents)
      .mockResolvedValueOnce(page(['asc-1'], 'asc-cursor-1'))
      .mockResolvedValueOnce(page(['asc-2'], 'asc-cursor-2'));
    const { result, rerender } = renderEventsList({ sortOrder: 'asc' });
    await waitFor(() => expect(ids(result.current.events)).toEqual(['asc-1']));
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['asc-1', 'asc-2'])
    );

    vi.mocked(fetchEvents).mockResolvedValueOnce(failure('boom'));
    rerender({ sortOrder: 'desc' });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));

    vi.mocked(fetchEvents).mockResolvedValueOnce(
      page(['desc-1'], 'desc-cursor-1')
    );
    rerender({ sortOrder: 'desc', active: false });
    rerender({ sortOrder: 'desc', active: true });
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(ids(result.current.events)).toEqual(['desc-1']));
    expect(fetchEvents).toHaveBeenCalledTimes(4);
  });

  it('reads a restored query again when the sort order returns to it', async () => {
    vi.mocked(fetchEvents)
      .mockResolvedValueOnce(page(['asc-1']))
      .mockResolvedValueOnce(page(['desc-1']));
    const { result, rerender } = renderEventsList({ sortOrder: 'asc' });
    await waitFor(() => expect(ids(result.current.events)).toEqual(['asc-1']));
    rerender({ sortOrder: 'desc' });
    await waitFor(() => expect(ids(result.current.events)).toEqual(['desc-1']));

    const reread = deferred<EventsResponse>();
    vi.mocked(fetchEvents).mockReturnValueOnce(reread.promise);
    rerender({ sortOrder: 'asc' });

    expect(ids(result.current.events)).toEqual(['asc-1']);
    expect(result.current.loading).toBe(false);
    expect(fetchEvents).toHaveBeenCalledTimes(3);

    await act(async () => reread.resolve(page(['asc-2'])));
    await waitFor(() => expect(ids(result.current.events)).toEqual(['asc-2']));
  });

  it('reads nothing again when a decryption key arrives', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1']));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(ids(result.current.events)).toEqual(['event-1'])
    );

    rerender({ encryptionKey: new Uint8Array([1]) });
    await act(async () => {});

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(ids(result.current.events)).toEqual(['event-1']);
  });
});
