import { describe, expect, it } from 'vitest';
import { once, withResolvers } from './promise';

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
