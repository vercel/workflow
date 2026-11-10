import { act, renderHook, waitFor } from '@testing-library/react';
import type { Event } from '@workflow/world';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaginatedResult, ServerActionResult } from '~/lib/types';
import { useEventsListData } from './use-events-list-data';

// Marks rows hydrated with a key, so a test can tell which read produced them.
vi.mock('@workflow/web-shared', () => ({
  hydrateResourceIOAsync: async <T>(value: T, key?: Uint8Array): Promise<T> =>
    key ? { ...value, decrypted: true } : value,
}));

vi.mock('~/lib/rpc-client', () => ({
  fetchEvent: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsByCorrelationId: vi.fn(),
}));

import { fetchEvents } from '~/lib/rpc-client';

type EventsResponse = ServerActionResult<PaginatedResult<Event>>;

interface Props {
  enabled?: boolean;
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

/** Renders the hook against its own SWR cache, so tests share no pages. */
function renderEventsList(initialProps: Props = {}) {
  const cache = new Map();
  return renderHook((props: Props) => useEventsListData(env, 'run-1', props), {
    initialProps,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children),
  });
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
    rerender({ enabled: false });
    rerender({ enabled: true });

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
    rerender({ enabled: false });
    rerender({ enabled: true });

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
    rerender({ enabled: false });
    rerender({ enabled: true });

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
    rerender({ enabled: false });
    rerender({ enabled: true });

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

    rerender({ enabled: false });
    rerender({ enabled: true });
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
    rerender({ sortOrder: 'desc', enabled: false });
    rerender({ sortOrder: 'desc', enabled: true });
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(ids(result.current.events)).toEqual(['desc-1']));
    expect(fetchEvents).toHaveBeenCalledTimes(4);
  });

  it('reads the loaded pages again when a decryption key arrives', async () => {
    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1']));
    const { result, rerender } = renderEventsList();
    await waitFor(() =>
      expect(result.current.events).toEqual([event('event-1')])
    );

    vi.mocked(fetchEvents).mockResolvedValueOnce(page(['event-1']));
    rerender({ encryptionKey: new Uint8Array([1]) });

    await waitFor(() =>
      expect(result.current.events).toEqual([
        { ...event('event-1'), decrypted: true },
      ])
    );
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });
});
