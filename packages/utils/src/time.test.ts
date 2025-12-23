import { describe, expect, it } from 'vitest';
import { parseDurationToDate } from './time';

describe('parseDurationToDate', () => {
  it('should parse duration strings correctly', () => {
    const result = parseDurationToDate('5s');
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it('should parse numbers as milliseconds', () => {
    const result = parseDurationToDate(1000);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it('should handle Date objects', () => {
    const futureDate = new Date(Date.now() + 5000);
    const result = parseDurationToDate(futureDate);
    expect(result).toEqual(futureDate);
  });

  it('should throw on invalid duration strings', () => {
    // @ts-expect-error - invalid duration string
    expect(() => parseDurationToDate('invalid')).toThrow();
  });

  it('should throw on negative numbers', () => {
    expect(() => parseDurationToDate(-1000)).toThrow();
  });
});
