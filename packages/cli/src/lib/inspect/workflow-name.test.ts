import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';
import { resolveWorkflowNameFilter } from './workflow-name.js';

const ORDER = 'workflow//./src/jobs/order//processOrder';
const INVOICE = 'workflow//./src/jobs/invoice//sendInvoice';

const runsNamed = (...names: string[]) =>
  names.map((workflowName, i) => ({ runId: `wrun_${i}`, workflowName }));

/** A storage run listing that serves `pages` in order. */
const storageWorld = (...pages: string[][]) => {
  const list = vi.fn(
    async ({ pagination }: { pagination: { cursor?: string } }) => {
      const index = pagination.cursor ? Number(pagination.cursor) : 0;
      const hasMore = index + 1 < pages.length;
      return {
        data: runsNamed(...pages[index]),
        cursor: hasMore ? String(index + 1) : null,
        hasMore,
      };
    }
  );
  return { world: { runs: { list } } as unknown as World, list };
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
    expect(list.mock.calls[0][0]).toEqual({
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
    const { world, list } = storageWorld([INVOICE], [INVOICE], [ORDER]);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    expect(
      await resolveWorkflowNameFilter(world, 'processOrder', storage)
    ).toBe(ORDER);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('scans at most five pages', async () => {
    const { world, list } = storageWorld(
      ...Array.from({ length: 8 }, () => [INVOICE])
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await resolveWorkflowNameFilter(world, 'processOrder', storage);

    expect(list).toHaveBeenCalledTimes(5);
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
    const { world } = storageWorld([ORDER], [legacy]);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(await resolveWorkflowNameFilter(world, legacy, storage)).toBe(
      legacy
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
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
      ...timeWindow,
      pagination: { sortOrder: 'desc', cursor: undefined, limit: 100 },
    });
    expect(storageList).not.toHaveBeenCalled();
  });
});
