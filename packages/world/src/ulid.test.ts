import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { ulidToDate, validateUlidTimestamp } from './ulid.js';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function withRegionTagBit(id: string): string {
  const first = id[0];
  const value = CROCKFORD_BASE32.indexOf(first);
  if (value < 0) throw new Error(`invalid ULID first char ${first}`);
  return `${CROCKFORD_BASE32[value | 0b100]}${id.slice(1)}`;
}

describe('ulidToDate', () => {
  it('clears the region-tag timestamp bit before decoding time', () => {
    const now = Date.now();
    const tagged = withRegionTagBit(ulid(now));

    expect(ulidToDate(tagged)?.getTime()).toBe(now);
  });
});

describe('validateUlidTimestamp', () => {
  it('accepts a current region-tagged run ID', () => {
    const taggedRunId = `wrun_${withRegionTagBit(ulid())}`;

    expect(validateUlidTimestamp(taggedRunId, 'wrun_')).toBeNull();
  });
});
