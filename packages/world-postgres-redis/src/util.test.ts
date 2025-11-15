import { describe, expect, expectTypeOf, it } from 'vitest';
import { compact } from './util.js';

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
