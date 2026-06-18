import { describe, expect, it, vi } from 'vitest';
import {
  createStepHydrationCache,
  getOrHydrateStepReturnValue,
  isMemoizablePrimitive,
  MAX_MEMOIZED_PRIMITIVE_LENGTH,
} from './step-hydration-cache.js';

describe('isMemoizablePrimitive', () => {
  it('returns true for primitives', () => {
    expect(isMemoizablePrimitive('hello')).toBe(true);
    expect(isMemoizablePrimitive(42)).toBe(true);
    expect(isMemoizablePrimitive(0)).toBe(true);
    expect(isMemoizablePrimitive(true)).toBe(true);
    expect(isMemoizablePrimitive(false)).toBe(true);
    expect(isMemoizablePrimitive(null)).toBe(true);
    expect(isMemoizablePrimitive(undefined)).toBe(true);
    expect(isMemoizablePrimitive(10n)).toBe(true);
    expect(isMemoizablePrimitive(Symbol('x'))).toBe(true);
  });

  it('returns false for objects, arrays, and functions', () => {
    expect(isMemoizablePrimitive({})).toBe(false);
    expect(isMemoizablePrimitive({ a: 1 })).toBe(false);
    expect(isMemoizablePrimitive([])).toBe(false);
    expect(isMemoizablePrimitive([1, 2, 3])).toBe(false);
    expect(isMemoizablePrimitive(() => {})).toBe(false);
    expect(isMemoizablePrimitive(new Date())).toBe(false);
    expect(isMemoizablePrimitive(new Map())).toBe(false);
  });

  it('memoizes a string at the length bound but not beyond it', () => {
    const atBound = 'x'.repeat(MAX_MEMOIZED_PRIMITIVE_LENGTH);
    const overBound = 'x'.repeat(MAX_MEMOIZED_PRIMITIVE_LENGTH + 1);
    expect(isMemoizablePrimitive(atBound)).toBe(true);
    expect(isMemoizablePrimitive(overBound)).toBe(false);
  });

  it('bounds oversized bigints by their decimal length', () => {
    const overBound = BigInt('9'.repeat(MAX_MEMOIZED_PRIMITIVE_LENGTH + 1));
    expect(isMemoizablePrimitive(overBound)).toBe(false);
    // A small bigint is always memoizable.
    expect(isMemoizablePrimitive(123n)).toBe(true);
  });
});

describe('getOrHydrateStepReturnValue', () => {
  it('hydrates on a miss and returns the value', async () => {
    const cache = createStepHydrationCache();
    const hydrate = vi.fn().mockResolvedValue('result');
    const value = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    expect(value).toBe('result');
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('memoizes a primitive: second call with same eventId does not re-hydrate', async () => {
    const cache = createStepHydrationCache();
    const hydrate = vi.fn().mockResolvedValue('result');

    const first = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    const second = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);

    expect(first).toBe('result');
    expect(second).toBe('result');
    // The expensive hydrate must only run once across replays.
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('memoizes falsy primitives (0, false, "", null, undefined) as hits', async () => {
    for (const sample of [0, false, '', null, undefined]) {
      const cache = createStepHydrationCache();
      const hydrate = vi.fn().mockResolvedValue(sample);
      const first = await getOrHydrateStepReturnValue(cache, 'evnt', hydrate);
      const second = await getOrHydrateStepReturnValue(cache, 'evnt', hydrate);
      expect(first).toBe(sample);
      expect(second).toBe(sample);
      expect(hydrate).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT memoize non-primitives: re-hydrates a fresh object each replay', async () => {
    const cache = createStepHydrationCache();
    // Return a fresh object every call so we can assert distinct references.
    const hydrate = vi.fn().mockImplementation(async () => ({ count: 0 }));

    const first = (await getOrHydrateStepReturnValue(
      cache,
      'evnt_0',
      hydrate
    )) as { count: number };
    // Simulate workflow code mutating the result on this replay.
    first.count++;

    const second = (await getOrHydrateStepReturnValue(
      cache,
      'evnt_0',
      hydrate
    )) as { count: number };

    // A fresh object must be produced — the mutation from the first replay
    // must NOT leak into the second.
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.count).toBe(0);
  });

  it('memoizes a string at the length bound (cache hit on replay)', async () => {
    const cache = createStepHydrationCache();
    const atBound = 'x'.repeat(MAX_MEMOIZED_PRIMITIVE_LENGTH);
    const hydrate = vi.fn().mockResolvedValue(atBound);

    const first = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    const second = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);

    expect(first).toBe(atBound);
    expect(second).toBe(atBound);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('does NOT memoize an oversized string: re-hydrates every replay and stays unbounded-free', async () => {
    const cache = createStepHydrationCache();
    const big = 'x'.repeat(MAX_MEMOIZED_PRIMITIVE_LENGTH + 1);
    const hydrate = vi.fn().mockResolvedValue(big);

    const first = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    const second = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);

    // Correct value still returned, but the large payload is never retained:
    // it falls through to a fresh re-hydrate on every replay.
    expect(first).toBe(big);
    expect(second).toBe(big);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('keys by eventId: different events hydrate independently', async () => {
    const cache = createStepHydrationCache();
    const hydrate = vi
      .fn()
      .mockResolvedValueOnce('a')
      .mockResolvedValueOnce('b');

    const a = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    const b = await getOrHydrateStepReturnValue(cache, 'evnt_1', hydrate);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('does not cache when no cache is provided', async () => {
    const hydrate = vi.fn().mockResolvedValue('result');
    await getOrHydrateStepReturnValue(undefined, 'evnt_0', hydrate);
    await getOrHydrateStepReturnValue(undefined, 'evnt_0', hydrate);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('does not cache when eventId is undefined', async () => {
    const cache = createStepHydrationCache();
    const hydrate = vi.fn().mockResolvedValue('result');
    await getOrHydrateStepReturnValue(cache, undefined, hydrate);
    await getOrHydrateStepReturnValue(cache, undefined, hydrate);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('does not cache rejected hydrations: re-attempts on the next call', async () => {
    const cache = createStepHydrationCache();
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');

    await expect(
      getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate)
    ).rejects.toThrow('boom');

    // A subsequent replay re-attempts (no parked rejected promise).
    const value = await getOrHydrateStepReturnValue(cache, 'evnt_0', hydrate);
    expect(value).toBe('recovered');
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
