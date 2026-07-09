import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceListingWindow,
  getListingWindow,
  resetListingWindows,
} from './listing-window';

const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  resetListingWindows();
  vi.restoreAllMocks();
});

describe('listing windows', () => {
  it('returns the same frozen window across calls (remounts)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-07-07T12:00:00.000Z').getTime()
    );
    const first = getListingWindow('24h', 24 * HOUR_MS);

    // A later mount (e.g. after a tab switch) must observe the same window
    // so SWR cache keys stay stable.
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-07-07T12:05:00.000Z').getTime()
    );
    expect(getListingWindow('24h', 24 * HOUR_MS)).toBe(first);
  });

  it('tracks windows per period', () => {
    const day = getListingWindow('24h', 24 * HOUR_MS);
    const week = getListingWindow('7d', 7 * 24 * HOUR_MS);
    expect(day).not.toBe(week);
    expect(getListingWindow('24h', 24 * HOUR_MS)).toBe(day);
  });

  it('advance slides the window to now and replaces the stored one', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-07-07T12:00:00.000Z').getTime()
    );
    getListingWindow('24h', 24 * HOUR_MS);

    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-07-07T13:00:00.000Z').getTime()
    );
    const advanced = advanceListingWindow('24h', 24 * HOUR_MS);
    expect(advanced).toEqual({
      startTime: '2026-07-06T13:00:00.000Z',
      endTime: '2026-07-07T13:00:00.000Z',
    });
    expect(getListingWindow('24h', 24 * HOUR_MS)).toBe(advanced);
  });
});
