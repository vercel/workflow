import { describe, expect, it } from 'vitest';
import { formatEventGap } from '../src/lib/utils.js';

/**
 * Tests for `formatEventGap`, the compact signed gap label shown between
 * consecutive rows in the sidebar Events list. A zero gap is special-cased to
 * "+0ms" (instead of the "0s" that `formatDuration` returns) so events that
 * share a millisecond timestamp still read as a delta. Long gaps stay in
 * hours (e.g. "+26h") rather than decomposing into days, matching the compact
 * timeline-marker format.
 */
describe('formatEventGap', () => {
  it('special-cases a zero gap', () => {
    expect(formatEventGap(0)).toBe('+0ms');
  });

  it('formats sub-second gaps in milliseconds', () => {
    expect(formatEventGap(1)).toBe('+1ms');
    expect(formatEventGap(380)).toBe('+380ms');
    expect(formatEventGap(999)).toBe('+999ms');
  });

  it('formats second- and minute-scale gaps', () => {
    expect(formatEventGap(1000)).toBe('+1s');
    expect(formatEventGap(45000)).toBe('+45s');
    expect(formatEventGap(60000)).toBe('+1m');
    expect(formatEventGap(90000)).toBe('+1m 30s');
  });

  it('keeps long gaps in hours instead of days', () => {
    expect(formatEventGap(3600000)).toBe('+1h');
    expect(formatEventGap(9000000)).toBe('+2h 30m');
    expect(formatEventGap(93600000)).toBe('+26h');
  });
});
