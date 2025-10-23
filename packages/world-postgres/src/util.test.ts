import { setTimeout } from 'node:timers/promises';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { compact, Mutex } from './util.js';

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
