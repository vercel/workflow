import { setTimeout } from 'node:timers/promises';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { cloneClientConfig, compact, Mutex } from './util.js';

describe('compact', () => {
  it('removes null values and keeps other values', () => {
    const result = compact({
      a: 1,
      b: null,
      c: 'test',
      d: null,
      e: undefined,
      f: false,
    });

    expectTypeOf(result).toEqualTypeOf<{
      a: number;
      b: undefined;
      c: string;
      d: undefined;
      e: undefined;
      f: boolean;
    }>();

    expect(result).toEqual({
      a: 1,
      c: 'test',
      f: false,
    });
  });
});

describe('Mutex', () => {
  it(`can register andThen to sync`, async () => {
    const mutex = new Mutex();
    const results: string[] = [];
    mutex.andThen(async () => {
      results.push('<1>');
      await setTimeout(10);
      results.push('</1>');
    });
    await mutex.andThen(async () => {
      results.push('<2>');
      await setTimeout(10);
      results.push('</2>');
    });
    expect(results).toEqual(['<1>', '</1>', '<2>', '</2>']);
  });
});

describe('cloneClientConfig', () => {
  it('preserves non-enumerable properties such as password', () => {
    const password = async () => 'token-123';
    const source: Record<string, unknown> = {
      host: 'localhost',
      user: 'postgres',
    };
    Object.defineProperty(source, 'password', {
      value: password,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const cloned = cloneClientConfig(source);
    expect(cloned.password).toBe(password);
    expect(
      Object.getOwnPropertyDescriptor(cloned, 'password')?.enumerable
    ).toBe(false);
  });

  it('applies overrides while retaining non-enumerable credentials', () => {
    const source: Record<string, unknown> = {
      host: 'localhost',
      user: 'postgres',
    };
    Object.defineProperty(source, 'password', {
      value: 'secret',
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const cloned = cloneClientConfig(source, {
      connectionTimeoutMillis: 5_000,
      application_name: 'test:app',
    });

    expect(cloned.password).toBe('secret');
    expect(cloned.connectionTimeoutMillis).toBe(5_000);
    expect(cloned.application_name).toBe('test:app');
    expect(cloned.host).toBe('localhost');
  });
});
