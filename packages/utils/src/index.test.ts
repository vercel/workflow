import { describe, expect, it } from 'vitest';
import { once, parseDurationToDate, withResolvers } from './index';

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
    expect(() => parseDurationToDate('invalid')).toThrow();
  });

  it('should throw on negative numbers', () => {
    expect(() => parseDurationToDate(-1000)).toThrow();
  });
});

describe('withResolvers', () => {
  it('should create a promise with resolvers', () => {
    const { promise, resolve, reject } = withResolvers<string>();
    expect(promise).toBeInstanceOf(Promise);
    expect(typeof resolve).toBe('function');
    expect(typeof reject).toBe('function');
  });

  it('should resolve the promise', async () => {
    const { promise, resolve } = withResolvers<string>();
    resolve('test');
    const result = await promise;
    expect(result).toBe('test');
  });

  it('should reject the promise', async () => {
    const { promise, reject } = withResolvers<string>();
    reject(new Error('test error'));
    await expect(promise).rejects.toThrow('test error');
  });
});

describe('once', () => {
  it('should call function only once', () => {
    let callCount = 0;
    const fn = once(() => {
      callCount++;
      return 'result';
    });

    expect(fn.value).toBe('result');
    expect(callCount).toBe(1);

    expect(fn.value).toBe('result');
    expect(callCount).toBe(1);
  });

  it('should cache the result', () => {
    const fn = once(() => Date.now());
    const first = fn.value;
    const second = fn.value;
    expect(first).toBe(second);
  });
});
