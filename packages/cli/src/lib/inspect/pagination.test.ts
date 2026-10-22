import { describe, expect, it, vi } from 'vitest';
import {
  fetchAllPages,
  moreResultsMessage,
  type PageData,
} from './pagination.js';

/** A fetcher serving `pages` in order, keyed by the cursor that reaches each. */
const pagedFetcher = (pages: Record<string, PageData<number>>) =>
  vi.fn(async (cursor: string | undefined) => {
    const page = pages[cursor ?? ''];
    if (!page) throw new Error(`unexpected cursor ${cursor}`);
    return page;
  });

describe('fetchAllPages', () => {
  it('follows each cursor once and returns every row in order', async () => {
    const fetchPage = pagedFetcher({
      '': { data: [1, 2], cursor: 'c1', hasMore: true },
      c1: { data: [3, 4], cursor: 'c2', hasMore: true },
      c2: { data: [5], cursor: 'c3', hasMore: false },
    });

    const page = await fetchAllPages(fetchPage);

    expect(page.data).toEqual([1, 2, 3, 4, 5]);
    expect(page.hasMore).toBe(false);
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'c1',
      'c2',
    ]);
  });

  it('starts from the initial cursor', async () => {
    const fetchPage = pagedFetcher({
      c1: { data: [3], cursor: 'c2', hasMore: true },
      c2: { data: [4], cursor: null, hasMore: false },
    });

    const page = await fetchAllPages(fetchPage, 'c1');

    expect(page.data).toEqual([3, 4]);
    expect(fetchPage.mock.calls[0][0]).toBe('c1');
  });

  // The CLI's --cursor flag defaults to the empty string.
  it('treats an empty initial cursor as none', async () => {
    const fetchPage = pagedFetcher({
      '': { data: [1], cursor: null, hasMore: false },
    });

    await fetchAllPages(fetchPage, '');

    expect(fetchPage.mock.calls[0][0]).toBeUndefined();
  });

  it('keeps the last page metadata', async () => {
    const pageInfo = {
      currentLookbackDays: 2,
      maxLookbackDays: 30,
      currentWindowStart: '2026-06-28T00:00:00.000Z',
      maxWindowStart: '2026-06-01T00:00:00.000Z',
      upgradeAvailable: true,
    };
    const fetchPage = pagedFetcher({
      '': { data: [1], cursor: 'c1', hasMore: true },
      c1: { data: [2], cursor: 'c2', hasMore: false, pageInfo },
    });

    expect((await fetchAllPages(fetchPage)).pageInfo).toEqual(pageInfo);
  });

  it('throws instead of looping when a cursor repeats', async () => {
    const fetchPage = pagedFetcher({
      '': { data: [1], cursor: 'c1', hasMore: true },
      c1: { data: [2], cursor: 'c1', hasMore: true },
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(
      'returned cursor "c1" twice'
    );
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('throws instead of stopping short when more rows have no cursor', async () => {
    const fetchPage = pagedFetcher({
      '': { data: [1], cursor: null, hasMore: true },
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(
      'returned no cursor'
    );
  });
});

describe('moreResultsMessage', () => {
  it('names the cursor, --all and --interactive', () => {
    expect(
      moreResultsMessage({ cursor: 'abc123' }, { supportsAll: true })
    ).toBe(
      'More results available. Pass --cursor abc123 for the next page, --all for every page, or --interactive (-i) to page through them.'
    );
  });

  // world-local cursors are `<iso timestamp>|<id>`: unquoted, a copied hint
  // pipes into a command named after the id.
  it('quotes a cursor the shell would split', () => {
    expect(
      moreResultsMessage({ cursor: '2026-06-30T00:00:00.000Z|evnt_1' })
    ).toContain("--cursor '2026-06-30T00:00:00.000Z|evnt_1' for the next page");
    expect(moreResultsMessage({ cursor: "it's" })).toContain(
      `--cursor 'it'\\''s'`
    );
  });

  it('leaves out --interactive for JSON output, which ignores it', () => {
    expect(
      moreResultsMessage({ cursor: 'abc' }, { supportsAll: true, json: true })
    ).toBe(
      'More results available. Pass --cursor abc for the next page or --all for every page.'
    );
  });

  it('leaves out --all where the listing does not take it', () => {
    expect(moreResultsMessage({ cursor: 'abc' })).not.toContain('--all');
  });

  // A storage-fallback cursor handed to a new invocation would go to
  // analytics, which did not issue it.
  it('leaves out a cursor that a new invocation could not reuse', () => {
    expect(
      moreResultsMessage(
        { cursor: 'storage-cursor', cursorReusable: false },
        { supportsAll: true, json: true }
      )
    ).toBe('More results available. Pass --all for every page.');
  });
});
