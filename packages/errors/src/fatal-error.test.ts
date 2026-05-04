import { describe, expect, it } from 'vitest';
import { FatalError } from './index.js';

describe('FatalError.is', () => {
  it('returns true for direct FatalError instances', () => {
    expect(FatalError.is(new FatalError('boom'))).toBe(true);
  });

  it('returns true for any error with fatal: true', () => {
    // The runtime uses `FatalError.is()` as its non-retry gate. Structured
    // error classes that aren't direct subclasses (e.g. context-violation
    // errors) opt in via a `fatal: true` own property — otherwise the
    // step handler would burn three retry attempts on an error that will
    // never succeed, producing a wall of duplicated log output.
    class ContextViolation extends Error {
      fatal = true;
      name = 'ContextViolation';
    }
    expect(FatalError.is(new ContextViolation())).toBe(true);
  });

  it('returns false for plain errors', () => {
    expect(FatalError.is(new Error('boom'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(FatalError.is('boom')).toBe(false);
    expect(FatalError.is(null)).toBe(false);
    expect(FatalError.is(undefined)).toBe(false);
    expect(FatalError.is({ fatal: true })).toBe(false);
  });

  it('returns false when fatal is not strictly true', () => {
    // Defensive: we intentionally check `=== true`, not truthy, so an
    // error with `fatal: 1` or `fatal: 'yes'` doesn't accidentally flip
    // the retry gate.
    class Weird extends Error {
      fatal: unknown = 1;
    }
    expect(FatalError.is(new Weird())).toBe(false);
  });
});
