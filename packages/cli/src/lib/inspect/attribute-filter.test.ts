import { describe, expect, it } from 'vitest';
import { parseAttributeFilters } from './attribute-filter.js';

describe('parseAttributeFilters', () => {
  it('is undefined when the flag is absent or empty', () => {
    expect(parseAttributeFilters(undefined)).toBeUndefined();
    expect(parseAttributeFilters([])).toBeUndefined();
  });

  it('collects repeated pairs', () => {
    expect(
      parseAttributeFilters(['application=next-benchmarks', 'tenant=acme'])
    ).toEqual({ application: 'next-benchmarks', tenant: 'acme' });
  });

  // Attribute values are arbitrary user strings and may contain '='.
  it('splits on the first separator only', () => {
    expect(parseAttributeFilters(['url=https://x.test/?a=1&b=2'])).toEqual({
      url: 'https://x.test/?a=1&b=2',
    });
  });

  // Matches runs whose attribute was explicitly set to the empty string,
  // which is different from not filtering at all.
  it('keeps an empty value', () => {
    expect(parseAttributeFilters(['tenant='])).toEqual({ tenant: '' });
  });

  it('accepts reserved $-prefixed keys, which are filterable', () => {
    expect(parseAttributeFilters(['$parentRunId=wrun_1'])).toEqual({
      $parentRunId: 'wrun_1',
    });
  });

  it.each([
    ['no separator', 'tenant'],
    ['empty key', '=acme'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseAttributeFilters([value])).toThrow(
      '--attribute must be key=value'
    );
  });

  it('rejects more pairs than the backend accepts, naming the flag', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `k${i}=v`);
    expect(() => parseAttributeFilters(nine)).toThrow(
      '--attribute may be given at most 8 times (received 9)'
    );
  });

  // Matching is per-key, so resolving this would mean discarding one of two
  // filters the caller typed.
  it('rejects a repeated key rather than picking one value', () => {
    expect(() => parseAttributeFilters(['tenant=a', 'tenant=b'])).toThrow(
      '--attribute "tenant" was given more than once'
    );
  });

  // On a plain object literal these are truthy for `in` before anything is
  // stored, so each was rejected as a duplicate on first sight; `__proto__`
  // would additionally have set the prototype instead of storing a value.
  it.each([
    'toString',
    'constructor',
    'hasOwnProperty',
    '__proto__',
  ])('accepts %s as an ordinary key', (key) => {
    const parsed = parseAttributeFilters([`${key}=v`]);
    expect(Object.hasOwn(parsed ?? {}, key)).toBe(true);
    expect((parsed as Record<string, string>)[key]).toBe('v');
  });

  it('still rejects a prototype-named key given twice', () => {
    expect(() => parseAttributeFilters(['toString=a', 'toString=b'])).toThrow(
      'was given more than once'
    );
  });

  it('allows the same value under different keys', () => {
    expect(parseAttributeFilters(['tenant=a', 'region=a'])).toEqual({
      tenant: 'a',
      region: 'a',
    });
  });
});
