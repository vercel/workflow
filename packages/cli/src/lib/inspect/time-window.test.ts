import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseTimeInput,
  planWindowStartFromResponse,
  resolveTimeWindow,
} from './time-window.js';

const NOW = new Date('2026-07-07T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTimeInput', () => {
  it('parses relative durations as that long ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    expect(parseTimeInput('30m', 'since').toISOString()).toBe(
      '2026-07-07T11:30:00.000Z'
    );
    expect(parseTimeInput('12h', 'since').toISOString()).toBe(
      '2026-07-07T00:00:00.000Z'
    );
    expect(parseTimeInput('7d', 'since').toISOString()).toBe(
      '2026-06-30T12:00:00.000Z'
    );
    expect(parseTimeInput('2w', 'since').toISOString()).toBe(
      '2026-06-23T12:00:00.000Z'
    );
  });

  it('parses absolute timestamps', () => {
    expect(parseTimeInput('2026-07-01T00:00:00Z', 'since').toISOString()).toBe(
      '2026-07-01T00:00:00.000Z'
    );
  });

  it('rejects invalid values with the flag name in the error', () => {
    expect(() => parseTimeInput('yesterday-ish', 'since')).toThrow('--since');
  });
});

describe('resolveTimeWindow', () => {
  it('returns undefined when neither flag is given', () => {
    expect(resolveTimeWindow({})).toBeUndefined();
  });

  it('defaults the end to now when only --since is given', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    expect(resolveTimeWindow({ since: '24h' })).toEqual({
      startTime: '2026-07-06T12:00:00.000Z',
      endTime: '2026-07-07T12:00:00.000Z',
    });
  });

  it('rejects --until without --since', () => {
    expect(() => resolveTimeWindow({ until: '1h' })).toThrow(
      '--until requires --since'
    );
  });

  it('rejects inverted windows', () => {
    expect(() => resolveTimeWindow({ since: '1h', until: '2h' })).toThrow(
      '--since must be earlier than --until'
    );
  });
});

describe('planWindowStartFromResponse', () => {
  it('extracts the plan window start from page metadata', () => {
    expect(
      planWindowStartFromResponse({
        data: [],
        pageInfo: {
          currentLookbackDays: 30,
          maxLookbackDays: 30,
          currentWindowStart: '2026-06-07T12:00:00.000Z',
          maxWindowStart: '2026-06-07T12:00:00.000Z',
          upgradeAvailable: false,
        },
      })
    ).toBe('2026-06-07T12:00:00.000Z');
  });

  it('returns undefined without page metadata', () => {
    expect(planWindowStartFromResponse({ data: [] })).toBeUndefined();
    expect(planWindowStartFromResponse(null)).toBeUndefined();
  });
});
