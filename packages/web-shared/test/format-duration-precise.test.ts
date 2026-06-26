import { describe, expect, it } from 'vitest';
import { formatDurationPrecise } from '../src/lib/utils.js';

/**
 * Tests for `formatDurationPrecise`, with particular focus on unit-boundary
 * carry cases. The formatter rounds to centisecond precision FIRST and then
 * decomposes in integer space, so a value just below a unit boundary (e.g.
 * 59999ms) re-buckets into the next unit ("1m 0.00s") instead of rendering an
 * impossible component like "60.00s".
 */
describe('formatDurationPrecise', () => {
  it('formats normal durations', () => {
    expect(formatDurationPrecise(0)).toBe('0s');
    expect(formatDurationPrecise(626)).toBe('626ms');
    expect(formatDurationPrecise(1626)).toBe('1.63s');
    expect(formatDurationPrecise(45200)).toBe('45.20s');
    expect(formatDurationPrecise(73450)).toBe('1m 13.45s');
  });

  it('re-buckets values that carry across unit boundaries', () => {
    expect(formatDurationPrecise(999.6)).toBe('1.00s');
    expect(formatDurationPrecise(999.5)).toBe('1.00s');
    expect(formatDurationPrecise(59999)).toBe('1m 0.00s');
    expect(formatDurationPrecise(59995)).toBe('1m 0.00s');
    expect(formatDurationPrecise(119999)).toBe('2m 0.00s');
    expect(formatDurationPrecise(3659999)).toBe('1h 1m 0.00s');
    expect(formatDurationPrecise(86459999)).toBe('1d 1m 0.00s');
  });
});
