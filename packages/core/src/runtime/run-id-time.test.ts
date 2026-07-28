import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { runIdCreatedAt } from './run-id-time.js';

describe('runIdCreatedAt', () => {
  it('recovers the creation time from a wrun_<ulid> run ID', () => {
    const t = Date.UTC(2024, 0, 1, 0, 0, 0);
    const runId = `wrun_${ulid(t)}`;
    expect(runIdCreatedAt(runId)).toBe(t);
  });

  it('decodes a bare ULID without the wrun_ prefix', () => {
    const t = Date.UTC(2025, 5, 15, 12, 30, 0);
    expect(runIdCreatedAt(ulid(t))).toBe(t);
  });

  it('clears the metadata tag bit from a tagged run ID (region-tagged ULIDs)', () => {
    // Tagging schemes (e.g. world-vercel region-tagged run IDs) set the MSB
    // of the 48-bit ULID timestamp. In Crockford base32 the first character
    // encodes the timestamp's top 3 bits (values 0-7), so for any
    // present-day timestamp (< 2^45) setting the tag bit turns a leading
    // '0' into a '4'.
    const t = Date.UTC(2026, 6, 14, 8, 30, 0);
    const plain = ulid(t);
    expect(plain[0]).toBe('0');
    const tagged = `4${plain.slice(1)}`;
    expect(runIdCreatedAt(`wrun_${tagged}`)).toBe(t);
    expect(runIdCreatedAt(tagged)).toBe(t);
  });

  it('returns undefined for a non-ULID run ID', () => {
    // Common in unit fixtures (e.g. `wrun_123`, `wrun_test`).
    expect(runIdCreatedAt('wrun_123')).toBeUndefined();
    expect(runIdCreatedAt('wrun_test')).toBeUndefined();
    expect(runIdCreatedAt('not-a-run-id')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(runIdCreatedAt('')).toBeUndefined();
  });
});
