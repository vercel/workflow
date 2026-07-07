import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
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

/**
 * Fresh SWR cache per test (or a shared one to simulate tab switches —
 * unmount + remount against the same cache).
 */
function makeWrapper(cache = new Map()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      children
    );
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('useInfiniteList', () => {
  it('loads the first page and exposes pageInfo', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValue(page(['a', 'b'], { cursor: 'c1', hasMore: true }));

    const { result } = renderHook(
      () => useInfiniteList('k1', fetchFn, getKey),
      { wrapper: makeWrapper() }
    );

    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b'])
    );
    expect(result.current.hasMore).toBe(true);
    expect(result.current.pageInfo).toEqual(PAGE_INFO);
    expect(fetchFn).toHaveBeenCalledWith(undefined);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('appends the next page on loadMore using the server cursor', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a', 'b'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['c', 'd'], { hasMore: false }));

    const { result } = renderHook(
      () => useInfiniteList('k1', fetchFn, getKey),
      { wrapper: makeWrapper() }
    );
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b'])
    );

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b', 'c', 'd'])
    );

    expect(fetchFn).toHaveBeenLastCalledWith('c1');
    // revalidateFirstPage is off: loading page 2 must not refetch page 1.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('dedupes rows that reappear on later pages (cursor drift)', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a', 'b'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['b', 'c'], { hasMore: false }));

    const { result } = renderHook(
      () => useInfiniteList('k1', fetchFn, getKey),
      { wrapper: makeWrapper() }
    );
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b'])
    );

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a', 'b', 'c'])
    );
  });

  it('serves cached pages instantly on remount (tab switch) without refetching', async () => {
    const cache = new Map();
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a', 'b'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['c'], { hasMore: false }));

    const first = renderHook(() => useInfiniteList('k1', fetchFn, getKey), {
      wrapper: makeWrapper(cache),
    });
    await waitFor(() =>
      expect(first.result.current.items.map(getKey)).toEqual(['a', 'b'])
    );
    act(() => {
      first.result.current.loadMore();
    });
    await waitFor(() =>
      expect(first.result.current.items.map(getKey)).toEqual(['a', 'b', 'c'])
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // Simulate switching away and back: unmount, then mount fresh against
    // the same SWR cache.
    first.unmount();
    const second = renderHook(() => useInfiniteList('k1', fetchFn, getKey), {
      wrapper: makeWrapper(cache),
    });

    // Cached rows are available without any new fetches.
    await waitFor(() =>
      expect(second.result.current.items.map(getKey)).toEqual(['a', 'b', 'c'])
    );
    expect(second.result.current.isLoading).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('reload resets to the first page and revalidates it', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockResolvedValueOnce(page(['a'], { cursor: 'c1', hasMore: true }))
      .mockResolvedValueOnce(page(['b'], { hasMore: false }))
      .mockResolvedValueOnce(page(['z'], { hasMore: false }));

    const { result } = renderHook(
      () => useInfiniteList('k1', fetchFn, getKey),
      { wrapper: makeWrapper() }
    );
    await waitFor(() =>
      expect(result.current.items.map(getKey)).toEqual(['a'])
    );
    act(() => {
      result.current.loadMore();
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

  it('surfaces fetch errors', async () => {
    const fetchFn = vi
      .fn<(cursor?: string) => Promise<PaginatedResult<Item>>>()
      .mockRejectedValue(new Error('boom'));

    const { result } = renderHook(
      () => useInfiniteList('k1', fetchFn, getKey),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
  });
});
