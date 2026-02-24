import { describe, expect, it, vi } from 'vitest';
import { WorkflowWebAPIError } from './workflow-errors';
import {
  fetchAllPaginated,
  MAX_ITEMS,
  mergeById,
  pollResource,
} from './workflow-primitives';

// ─── mergeById ──────────────────────────────────────────────────────────────

describe('mergeById', () => {
  it('merges two arrays by id key', () => {
    const prev = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];
    const next = [{ id: '3', name: 'Charlie' }];
    const result = mergeById(prev, next, 'id');
    expect(result).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
      { id: '3', name: 'Charlie' },
    ]);
  });

  it('later items override earlier ones with the same id', () => {
    const prev = [{ id: '1', status: 'pending' }];
    const next = [{ id: '1', status: 'completed' }];
    const result = mergeById(prev, next, 'id');
    expect(result).toEqual([{ id: '1', status: 'completed' }]);
  });

  it('handles empty arrays', () => {
    expect(mergeById([], [], 'id')).toEqual([]);
    expect(mergeById([{ id: '1' }], [], 'id')).toEqual([{ id: '1' }]);
    expect(mergeById([], [{ id: '1' }], 'id')).toEqual([{ id: '1' }]);
  });

  it('uses the specified id key', () => {
    const prev = [{ stepId: 's1', data: 'old' }];
    const next = [{ stepId: 's1', data: 'new' }];
    const result = mergeById(prev, next, 'stepId');
    expect(result).toEqual([{ stepId: 's1', data: 'new' }]);
  });
});

// ─── fetchAllPaginated ───────────────────────────────────────────────────────

describe('fetchAllPaginated', () => {
  it('fetches a single page when hasMore is false', async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      error: null,
      result: { data: [{ id: '1' }], cursor: undefined, hasMore: false },
    });

    const result = await fetchAllPaginated(fetchPage);
    expect(result.data).toEqual([{ id: '1' }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it('fetches multiple pages using cursors', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '1' }], cursor: 'cur1', hasMore: true },
      })
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '2' }], cursor: 'cur2', hasMore: true },
      })
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '3' }], cursor: undefined, hasMore: false },
      });

    const result = await fetchAllPaginated(fetchPage);
    expect(result.data).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'cur1');
    expect(fetchPage).toHaveBeenNthCalledWith(3, 'cur2');
  });

  it('stops on error and returns data collected so far', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '1' }], cursor: 'cur1', hasMore: true },
      })
      .mockResolvedValueOnce({
        error: new WorkflowWebAPIError('fail', { layer: 'API' }),
        result: null,
      });

    const result = await fetchAllPaginated(fetchPage);
    expect(result.data).toEqual([{ id: '1' }]);
  });

  it('cursor is from the last page that had more items', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '1' }], cursor: 'cur1', hasMore: true },
      })
      .mockResolvedValueOnce({
        error: null,
        result: { data: [{ id: '2' }], cursor: 'cur2', hasMore: false },
      });

    const result = await fetchAllPaginated(fetchPage);
    expect(result.cursor).toBe('cur1');
  });

  it('stops after MAX_ITEMS regardless of hasMore', async () => {
    const bigBatch = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      id: String(i),
    }));
    const fetchPage = vi.fn().mockResolvedValue({
      error: null,
      result: { data: bigBatch, cursor: 'c1', hasMore: true },
    });

    const result = await fetchAllPaginated(fetchPage);
    expect(result.data).toHaveLength(MAX_ITEMS);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

// ─── pollResource ────────────────────────────────────────────────────────────

describe('pollResource', () => {
  function makeOpts(
    overrides: Partial<Parameters<typeof pollResource>[0]> = {}
  ) {
    return {
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: { data: [], cursor: undefined, hasMore: false },
      }),
      setItems: vi.fn(),
      setCursor: vi.fn(),
      setError: vi.fn(),
      idKey: 'id',
      ...overrides,
    };
  }

  it('returns false when no new items', async () => {
    const opts = makeOpts();
    const result = await pollResource(opts);
    expect(result).toBe(false);
    expect(opts.setItems).not.toHaveBeenCalled();
  });

  it('returns true and calls setItems when new items found', async () => {
    const opts = makeOpts({
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: {
          data: [{ id: '1', value: 'a' }],
          cursor: 'c1',
          hasMore: false,
        },
      }),
    });

    const result = await pollResource(opts);
    expect(result).toBe(true);
    expect(opts.setItems).toHaveBeenCalledTimes(1);
  });

  it('calls setError and returns false on error', async () => {
    const error = new WorkflowWebAPIError('fail', { layer: 'API' });
    const opts = makeOpts({
      fetchFn: vi.fn().mockResolvedValue({ error, result: null }),
    });

    const result = await pollResource(opts);
    expect(result).toBe(false);
    expect(opts.setError).toHaveBeenCalledWith(error);
  });

  it('advances cursor with default "always" strategy', async () => {
    const opts = makeOpts({
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: {
          data: [{ id: '1' }],
          cursor: 'c1',
          hasMore: false,
        },
      }),
    });

    await pollResource(opts);
    expect(opts.setCursor).toHaveBeenCalledWith('c1');
  });

  it('does not advance cursor with "onHasMore" when hasMore is false', async () => {
    const opts = makeOpts({
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: {
          data: [{ id: '1' }],
          cursor: 'c1',
          hasMore: false,
        },
      }),
      cursorStrategy: 'onHasMore' as const,
    });

    await pollResource(opts);
    expect(opts.setCursor).not.toHaveBeenCalled();
  });

  it('advances cursor with "onHasMore" when hasMore is true', async () => {
    const opts = makeOpts({
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: {
          data: [{ id: '1' }],
          cursor: 'c1',
          hasMore: true,
        },
      }),
      cursorStrategy: 'onHasMore' as const,
    });

    await pollResource(opts);
    expect(opts.setCursor).toHaveBeenCalledWith('c1');
  });

  it('applies transform to each new item before merging', async () => {
    let currentItems: { id: string; value: string }[] = [];

    await pollResource({
      fetchFn: vi.fn().mockResolvedValue({
        error: null,
        result: {
          data: [{ id: '1', value: 'raw' }],
          cursor: undefined,
          hasMore: false,
        },
      }),
      setItems: (updater: (prev: any[]) => any[]) => {
        currentItems = updater(currentItems);
      },
      setCursor: vi.fn(),
      setError: vi.fn(),
      idKey: 'id',
      transform: (item: any) => ({ ...item, value: 'transformed' }),
    });

    expect(currentItems).toEqual([{ id: '1', value: 'transformed' }]);
  });
});
