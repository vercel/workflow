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

  // An Invalid Date used to be returned as-is and only failed once the
  // server tried to store it, as a 500 on the wait_created write.
  it('should throw on an Invalid Date', () => {
    expect(() => parseDurationToDate(new Date(Number.NaN))).toThrow(
      /Invalid date/
    );
  });

  it('should throw on a date-like object that holds no valid time', () => {
    expect(() =>
      parseDurationToDate({ getTime: () => Number.NaN } as unknown as Date)
    ).toThrow(/Invalid date/);
  });

  it('should throw on a finite duration that ends past the Date range', () => {
    expect(() => parseDurationToDate(9e15)).toThrow(
      /Invalid duration: 9000000000000000 ends past/
    );
    expect(() => parseDurationToDate('1000000000y')).toThrow(
      /Invalid duration: "1000000000y"/
    );
  });
});
