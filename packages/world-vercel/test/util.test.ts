import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { withWaitUntilObject } from '../src/utils';

describe('withWaitUntilObject', () => {
  test('calling waitUntil method to the object', async () => {
    const before = {
      number: 0,
      string: 'hello',
      syncFunction: () => 'world' as const,
      asyncFunction: async () => 'async world' as const,
    };
    const waitUntilFn = vi.fn(<T>(t: T) => t);
    const after = withWaitUntilObject(before, { waitUntilFn });
    expectTypeOf(after).toEqualTypeOf<typeof before>();

    expect(after).toEqual({
      number: 0,
      string: 'hello',
      syncFunction: expect.any(Function),
      asyncFunction: expect.any(Function),
    });
    expect(after.syncFunction()).toEqual('world');
    await expect(after.asyncFunction()).resolves.toEqual('async world');

    // check that waitUntilFn was called only for the async function
    expect(waitUntilFn).toHaveBeenCalledTimes(1);
    await expect(waitUntilFn.mock.lastCall?.[0]).resolves.toEqual(
      'async world'
    );
  });
});
