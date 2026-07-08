import { describe, expect, it } from 'vitest';
import { formatDurationPrecise } from './utils';

describe('formatDurationPrecise', () => {
  it('shows whole milliseconds below 1s', () => {
    expect(formatDurationPrecise(0)).toBe('0s');
    expect(formatDurationPrecise(626)).toBe('626ms');
  });

  it('keeps sub-second precision instead of rounding up to a whole second', () => {
    // The bug this guards: 1626ms must not read as "2s".
    expect(formatDurationPrecise(1626)).toBe('1.63s');
  });

  it('trims trailing zeros so whole/half seconds read cleanly', () => {
    expect(formatDurationPrecise(2000)).toBe('2s');
    expect(formatDurationPrecise(1500)).toBe('1.5s');
    expect(formatDurationPrecise(1600)).toBe('1.6s');
    expect(formatDurationPrecise(45_000)).toBe('45s');
  });

  it('honors a custom fraction-digit count (used by the timeline ruler)', () => {
    // Fewer digits also coarsen the rounding: 1 digit rounds to 100ms.
    expect(formatDurationPrecise(1500, 1)).toBe('1.5s');
    expect(formatDurationPrecise(1620, 1)).toBe('1.6s');
    expect(formatDurationPrecise(2000, 1)).toBe('2s');
  });

  it('decomposes durations of a minute or more', () => {
    expect(formatDurationPrecise(65_000)).toBe('1m 5s');
    expect(formatDurationPrecise(63_450)).toBe('1m 3.45s');
  });
});
