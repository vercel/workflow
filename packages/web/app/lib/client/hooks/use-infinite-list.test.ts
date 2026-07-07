import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInfiniteList } from './use-infinite-list';

vi.mock('~/lib/rpc-client', () => ({
  fetchRuns: vi.fn(),
}));

import type { AnalyticsPageInfo, PaginatedResult } from '~/lib/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

interface Item {
  id: string;
}

const PAGE_INFO: AnalyticsPageInfo = {
  currentLookbackDays: 30,
  maxLookbackDays: 30,
  currentWindowStart: new Date('2026-06-07T00:00:00.000Z'),
  maxWindowStart: new Date('2026-06-07T00:00:00.000Z'),
  upgradeAvailable: false,
};

function page(
  ids: string[],
  opts: { cursor?: string; hasMore?: boolean } = {}
): PaginatedResult<Item> {
  return {
    data: ids.map((id) => ({ id })),
    cursor: opts.cursor,
    hasMore: opts.hasMore ?? Boolean(opts.cursor),
    pageInfo: PAGE_INFO,
  };
}

const getKey = (item: Item) => item.id;

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('useInfiniteList', () => {
  it('loads the first page and exposes pageInfo', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValue(page(['a', 'b'], { cursor: 'c1', hasMore: true }));

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));

    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b'])
    );
    expect(result.current.hasMore).toBe(true);
    expect(result.current.pageInfo).toEqual(PAGE_INFO);
    expect(fetchFn).toHaveBeenCalledWith(undefined);
  });

  it('appends the next page on loadMore using the server cursor', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a', 'b'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['c', 'd'], { hasMore: false }));

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b', 'c', 'd'])
    );

    expect(fetchFn).toHaveBeenLastCalledWith('c1');
    expect(result.current.isLoadingMore).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });

  it('dedupes rows that reappear on later pages (cursor drift)', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a', 'b'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['b', 'c'], { hasMore: false }));

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b', 'c'])
    );
  });

  it('ignores loadMore while a fetch is in flight', async () => {
    let resolveSecond: ((r: PaginatedResult<Item>) => void) | undefined;
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a'], { cursor: 'c1', hasMore: true }))
      .mockImplementationOnce(
        () =>
          new Promise<PaginatedResult<Item>>((resolve) => {
            resolveSecond = resolve;
          })
      );

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));

    act(() => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond?.(page(['b'], { hasMore: false }));
    });
    expect(result.current.items.map(getKey)).toEqual(['a', 'b']);
  });

  it('reload clears accumulated rows and refetches from the top', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['b'], { hasMore: false }))
      .mockResolvedValueOnce(page(['z'], { hasMore: false }));

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b'])
    );

    act(() => {
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['z'])
    );

    expect(fetchFn).toHaveBeenLastCalledWith(undefined);
    expect(result.current.hasMore).toBe(false);
  });

  it('refresh refetches from the top without clearing rows while loading', async () => {
    let resolveRefresh: ((r: PaginatedResult<Item>) => void) | undefined;
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a'], { hasMore: false }))
      .mockImplementationOnce(
        () =>
          new Promise<PaginatedResult<Item>>((resolve) => {
            resolveRefresh = resolve;
          })
      );

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));

    act(() => {
      result.current.refresh();
    });
    // Old rows stay visible and no full-page loading state is shown.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items.map(getKey)).toEqual(['a']);

    await act(async () => {
      resolveRefresh?.(page(['a', 'b'], { hasMore: false }));
    });
    expect(result.current.items.map(getKey)).toEqual(['a', 'b']);
  });

  it('surfaces fetch errors and recovers on reload', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page(['a'], { hasMore: false }));

    const { result } = renderHook(() => useInfiniteList(fetchFn, getKey));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');

    act(() => {
      result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a'])
    );
    expect(result.current.error).toBeNull();
  });
});
