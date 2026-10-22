import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';
import { resolveWorkflowNameFilter } from './workflow-name.js';

const ORDER = 'workflow//./src/jobs/order//processOrder';
const INVOICE = 'workflow//./src/jobs/invoice//sendInvoice';

const runsNamed = (...names: string[]) =>
  names.map((workflowName, i) => ({ runId: `wrun_${i}`, workflowName }));

interface ListParams {
  workflowName?: string;
  pagination: { cursor?: string; limit?: number };
}

/**
 * A storage run listing that serves `pages` in order, newest first. A
 * `workflowName` filter matches across every page, as a backend's would.
 */
const storageWorld = (...pages: string[][]) => {
  const list = vi.fn(async ({ workflowName, pagination }: ListParams) => {
    if (workflowName !== undefined) {
      const named = runsNamed(...pages.flat()).filter(
        (run) => run.workflowName === workflowName
      );
      const limit = pagination.limit ?? named.length;
      return {
        data: named.slice(0, limit),
        cursor: null,
        hasMore: named.length > limit,
      };
    }
    const index = pagination.cursor ? Number(pagination.cursor) : 0;
    const hasMore = index + 1 < pages.length;
    return {
      data: runsNamed(...pages[index]),
      cursor: hasMore ? String(index + 1) : null,
      hasMore,
    };
  });
  /** The unfiltered listings: the short-name scan's pages. */
  const scanCalls = () =>
    list.mock.calls.filter(([params]) => params.workflowName === undefined);
  return { world: { runs: { list } } as unknown as World, list, scanCalls };
};

const storage = { useAnalytics: false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveWorkflowNameFilter', () => {
  it('passes a full name through without a request', async () => {
    const { world, list } = storageWorld([ORDER]);

    expect(await resolveWorkflowNameFilter(world, ORDER, storage)).toBe(ORDER);
    expect(list).not.toHaveBeenCalled();
  });

  it('passes no name through', async () => {
    const { world, list } = storageWorld([ORDER]);

    expect(
      await resolveWorkflowNameFilter(world, undefined, storage)
    ).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('resolves the short name the runs table shows', async () => {
    const { world, list } = storageWorld([INVOICE, ORDER, ORDER]);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).toBe(ORDER);
    // First the exact-name lookup, then the scan of recent runs.
    expect(list.mock.calls[0][0]).toEqual({
      workflowName: 'processOrder',
      pagination: { limit: 1 },
      resolveData: 'none',
    });
    expect(list.mock.calls[1][0]).toEqual({
      pagination: { sortOrder: 'desc', cursor: undefined, limit: 100 },
      resolveData: 'none',
    });
    expect(info.mock.calls.flat().join(' ')).toContain(ORDER);
  });

  it('resolves a nested function name', async () => {
    const nested = 'workflow//./src/jobs/order//processOrder/inner';
    const { world } = storageWorld([nested]);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder/inner', storage)
    ).toBe(nested);
    expect(await resolveWorkflowNameFilter(world, 'inner', storage)).toBe(
      nested
    );
  });

  it('finds a name past the first page', async () => {
    const { world, scanCalls } = storageWorld([INVOICE], [INVOICE], [ORDER]);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).toBe(ORDER);
    expect(scanCalls()).toHaveLength(3);
  });

  it('scans at most five pages', async () => {
    const { world, scanCalls } = storageWorld(
      ...Array.from({ length: 8 }, () => [INVOICE])
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resolveWorkflowNameFilter(world, 'processOrder', storage);

    expect(scanCalls()).toHaveLength(5);
  });

  // The same export under two module specifiers: guessing could list the
  // wrong workflow's runs.
  it('rejects a name two workflows share, naming both', async () => {
    const other = 'workflow//./src/legacy/order//processOrder';
    const { world } = storageWorld([ORDER, other]);

    await expect(
      resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).rejects.toThrow(`names 2 workflows in recent runs: ${ORDER}, ${other}`);
  });

  // A run whose workflowName the parser does not recognize was matched
  // exactly before; another workflow's short name must not take it over.
  it("keeps a value that is a recent run's exact workflow name", async () => {
    const legacy = 'processOrder';
    const { world, scanCalls } = storageWorld([ORDER], [legacy]);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(await resolveWorkflowNameFilter(world, legacy, storage)).toBe(
      legacy
    );
    expect(scanCalls()).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // One run named exactly `processOrder`, then 501 newer runs of a workflow
  // whose short name is `processOrder`: the exact run is past the 500 the
  // scan reads, and must still keep the filter it matched before.
  it('keeps an exact workflow name older than the scanned runs', async () => {
    const legacy = 'processOrder';
    const other = 'workflow//./other//processOrder';
    const newer = Array.from({ length: 501 }, () => other);
    const pages = Array.from({ length: 6 }, (_, i) =>
      newer.slice(i * 100, (i + 1) * 100)
    );
    pages[5].push(legacy);
    const { world, scanCalls } = storageWorld(...pages);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(await resolveWorkflowNameFilter(world, legacy, storage)).toBe(
      legacy
    );
    expect(scanCalls()).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });

  // The exact lookup reads the name back rather than trusting a non-empty
  // page, so a backend that dropped the filter still resolves the short name.
  it('does not take an unfiltered page as an exact match', async () => {
    const list = vi.fn().mockResolvedValue({
      data: runsNamed(ORDER),
      cursor: null,
      hasMore: false,
    });
    const world = { runs: { list } } as unknown as World;
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).toBe(ORDER);
  });

  it('passes an unmatched name through and warns', async () => {
    const { world } = storageWorld([INVOICE]);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).toBe('processOrder');
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'No recent run\'s workflow is named "processOrder"'
    );
  });

  it('scans analytics, in the listing window, when the listing reads it', async () => {
    const analyticsList = vi.fn().mockResolvedValue({
      data: runsNamed(ORDER),
      cursor: null,
      hasMore: false,
    });
    const storageList = vi.fn();
    const world = {
      analytics: { runs: { list: analyticsList } },
      runs: { list: storageList },
    } as unknown as World;
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const timeWindow = {
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-08T00:00:00.000Z',
    };

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', {
        useAnalytics: true,
        timeWindow,
      })
    ).toBe(ORDER);
    expect(analyticsList).toHaveBeenCalledWith({
      workflowName: 'processOrder',
      ...timeWindow,
      pagination: { limit: 1 },
    });
    expect(analyticsList).toHaveBeenCalledWith({
      ...timeWindow,
      pagination: { sortOrder: 'desc', cursor: undefined, limit: 100 },
    });
    expect(storageList).not.toHaveBeenCalled();
  });
});
