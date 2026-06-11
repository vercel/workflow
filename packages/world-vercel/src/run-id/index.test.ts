import { describe, expect, it } from 'vitest';
import {
  bytesToUlid,
  REGION_BYTE_INDEX,
  ULID_BYTE_LENGTH,
  ulidToBytes,
  VERSION_LOW_BYTE_INDEX,
} from './codec.js';
import {
  CURRENT_VERSION,
  decode,
  encode,
  isTagged,
  MAX_REGION_ID,
  MAX_VERSION,
  REGION_IDS,
  type RegionCode,
  type RegionKey,
} from './index.js';

const SAMPLE_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('encode / decode round-trip', () => {
  it('encodes with default version=1 and the iad1 region code', () => {
    const tagged = encode(SAMPLE_ULID, 'iad1');
    expect(tagged).toBe('41ARZ3NDEK0GV4RRFFQ69G5FAV');
    expect(tagged).toHaveLength(26);
    expect(isTagged(tagged)).toBe(true);

    const decoded = decode(tagged);
    expect(decoded).toEqual({
      tagged: true,
      ulid: '01ARZ3NDEK0GV4RRFFQ69G5FAV',
      region: 'iad1',
      regionId: REGION_IDS.iad1,
      version: CURRENT_VERSION,
    });
  });

  it('accepts numeric region IDs', () => {
    const tagged = encode(SAMPLE_ULID, 7);
    expect(tagged).toBe('41ARZ3NDEK3GV4RRFFQ69G5FAV');
    const decoded = decode(tagged);
    expect(decoded.regionId).toBe(7);
    expect(decoded.region).toBe('dub1');
    expect(decoded.ulid).toBe('01ARZ3NDEK3GV4RRFFQ69G5FAV');
  });

  it('returns region: null for unknown but in-range region IDs', () => {
    const tagged = encode(SAMPLE_ULID, 63);
    expect(tagged).toBe('41ARZ3NDEKZGV4RRFFQ69G5FAV');
    const decoded = decode(tagged);
    expect(decoded.regionId).toBe(63);
    expect(decoded.region).toBeNull();
  });

  it('encodes regionId=0 as the "unknown" sentinel', () => {
    const tagged = encode(SAMPLE_ULID, 0);
    expect(tagged).toBe('41ARZ3NDEK00V4RRFFQ69G5FAV');
    const decoded = decode(tagged);
    expect(decoded.regionId).toBe(0);
    expect(decoded.region).toBeNull();
  });

  it('accepts an explicit version override', () => {
    const tagged = encode(SAMPLE_ULID, 'iad1', { version: 0 });
    expect(tagged).toBe('41ARZ3NDEK0GB4RRFFQ69G5FAV');
    expect(decode(tagged).version).toBe(0);

    const tagged2 = encode(SAMPLE_ULID, 'iad1', { version: MAX_VERSION });
    expect(tagged2).toBe('41ARZ3NDEK0ZV4RRFFQ69G5FAV');
    expect(decode(tagged2).version).toBe(MAX_VERSION);
  });

  it('preserves all metadata bits across encode → decode → encode', () => {
    for (const regionId of [0, 1, 17, 31, 32, 63]) {
      for (const version of [0, 1, 7, 16, 31]) {
        const tagged = encode(SAMPLE_ULID, regionId, { version });
        const decoded = decode(tagged);
        expect(decoded.regionId).toBe(regionId);
        expect(decoded.version).toBe(version);
        // Re-encoding the cleared ULID with the same metadata must reproduce
        // the same tagged string.
        const reTagged = encode(decoded.ulid, regionId, { version });
        expect(reTagged).toBe(tagged);
      }
    }
  });

  it('clears only the tag bit in the decoded ULID', () => {
    const tagged = encode(SAMPLE_ULID, 'fra1', { version: 5 });
    expect(tagged).toBe('41ARZ3NDEK52V4RRFFQ69G5FAV');
    const decoded = decode(tagged);
    expect(decoded.ulid).toBe('01ARZ3NDEK52V4RRFFQ69G5FAV');

    // The decoded ulid must NOT have the tag bit set.
    expect(isTagged(decoded.ulid)).toBe(false);

    // The metadata bytes (the top of the 80-bit randomness section) must be
    // preserved in the decoded ULID, not zeroed.
    const taggedBytes = ulidToBytes(tagged);
    const decodedBytes = ulidToBytes(decoded.ulid);
    expect(decodedBytes[REGION_BYTE_INDEX]).toBe(
      taggedBytes[REGION_BYTE_INDEX]
    );
    expect(decodedBytes[VERSION_LOW_BYTE_INDEX]).toBe(
      taggedBytes[VERSION_LOW_BYTE_INDEX]
    );

    // And byte[0] differs only in the top bit.
    expect(decodedBytes[0]).toBe(taggedBytes[0] & 0x7f);
  });

  it('overwrites the tag bit and metadata bits even if the input has them set', () => {
    // Synthesize a ULID with byte[0] = 0x40 (some non-tag bits set) and
    // garbage in the metadata bytes (byte[6] + top of byte[7]).
    const bytes = new Uint8Array(ULID_BYTE_LENGTH);
    bytes[0] = 0x40;
    bytes[REGION_BYTE_INDEX] = 0xff;
    bytes[VERSION_LOW_BYTE_INDEX] = 0xff;
    const dirty = bytesToUlid(bytes);
    expect(dirty).toBe('2000000000ZZZG000000000000');

    const tagged = encode(dirty, 'sfo1', { version: 3 });
    const decoded = decode(tagged);
    expect(decoded.region).toBe('sfo1');
    expect(decoded.regionId).toBe(REGION_IDS.sfo1);
    expect(decoded.version).toBe(3);
    // Re-encoding the decoded.ulid with the same metadata must reproduce
    // the same tagged string — sanity-check of the round-trip property.
    expect(encode(decoded.ulid, 'sfo1', { version: 3 })).toBe(tagged);
  });

  it('encode emits an uppercase result for lowercase Crockford input', () => {
    const tagged = encode(SAMPLE_ULID.toLowerCase(), 'iad1');
    expect(tagged).toBe('41ARZ3NDEK0GV4RRFFQ69G5FAV');
    expect(tagged).toBe(tagged.toUpperCase());
  });

  it('encodes well-known boundary inputs to exact strings', () => {
    // Zero ULID with zero metadata: only the tag bit is set, so byte[0] = 0x80.
    // 0x80 → first 5-bit chunk (0b00100) → '4'; rest are all zero.
    expect(encode('0'.repeat(26), 0, { version: 0 })).toBe(
      '40000000000000000000000000'
    );
    // Zero ULID with region=1, version=1: regionId at the top of byte[6]
    // and version straddling bytes 6/7 — the changed bits show up around
    // base32 chars 11..13 ("0GG"). The low randomness bytes remain 0.
    expect(encode('0'.repeat(26), 1, { version: 1 })).toBe(
      '40000000000GG0000000000000'
    );
    // Zero ULID with max region (63) and max version (31): the 11 metadata
    // bits are all-ones, lighting up the high bits of bytes 6 and 7.
    expect(encode('0'.repeat(26), 63, { version: 31 })).toBe(
      '4000000000ZZG0000000000000'
    );
    // Max ULID with zero metadata: the metadata bits are forced to 0 even
    // though the source had them set, demonstrating overwrite semantics.
    expect(encode('7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 0, { version: 0 })).toBe(
      '7ZZZZZZZZZ00FZZZZZZZZZZZZZ'
    );
  });
});

describe('decode on un-tagged input', () => {
  it('returns tagged: false for a plain ULID', () => {
    const decoded = decode(SAMPLE_ULID);
    expect(decoded.tagged).toBe(false);
    // Decoded ulid equals input (already had tag bit cleared).
    expect(decoded.ulid).toBe(SAMPLE_ULID);
  });

  it('surfaces null metadata fields for un-tagged input', () => {
    // Un-tagged decode results carry `null` in the metadata positions so
    // callers must discriminate on `tagged` before reading them — the
    // bits themselves are arbitrary randomness from the source ULID.
    const decoded = decode(SAMPLE_ULID);
    if (decoded.tagged) {
      throw new Error('expected un-tagged result');
    }
    expect(decoded.regionId).toBeNull();
    expect(decoded.version).toBeNull();
    expect(decoded.region).toBeNull();
  });

  it('discriminated-union type narrows on the `tagged` check', () => {
    // Type-level assertion: in the un-tagged branch, the metadata fields
    // must type as `null`; in the tagged branch they must type as
    // `number | RegionCode | null`. This is enforced at compile time by
    // the conditional below — the test body itself just sanity-checks
    // that the runtime values agree with what the types say.
    const decoded = decode(SAMPLE_ULID);
    if (decoded.tagged) {
      // Within this branch, regionId is `number`, region is `RegionCode | null`.
      expect(typeof decoded.regionId).toBe('number');
      expect(typeof decoded.version).toBe('number');
    } else {
      // Within this branch, all three are typed as `null`.
      const r: null = decoded.regionId;
      const v: null = decoded.version;
      const code: null = decoded.region;
      expect(r).toBeNull();
      expect(v).toBeNull();
      expect(code).toBeNull();
    }
  });
});

describe('encode validation', () => {
  it('rejects invalid ULID input', () => {
    expect(() => encode('not-a-ulid', 'iad1')).toThrow();
    expect(() => encode('', 'iad1')).toThrow(/Invalid ULID length/);
    expect(() => encode(SAMPLE_ULID.slice(1), 'iad1')).toThrow(
      /Invalid ULID length/
    );
  });

  it('rejects unknown region codes', () => {
    expect(() => encode(SAMPLE_ULID, 'xxx1' as RegionCode)).toThrow(
      /Unknown region/
    );
  });

  it('rejects out-of-range numeric regions', () => {
    expect(() => encode(SAMPLE_ULID, -1)).toThrow(RangeError);
    expect(() => encode(SAMPLE_ULID, 64)).toThrow(RangeError);
    expect(() => encode(SAMPLE_ULID, 1.5)).toThrow(RangeError);
    expect(() => encode(SAMPLE_ULID, Number.NaN)).toThrow(RangeError);
  });

  it('rejects out-of-range versions', () => {
    expect(() => encode(SAMPLE_ULID, 'iad1', { version: -1 })).toThrow(
      RangeError
    );
    expect(() => encode(SAMPLE_ULID, 'iad1', { version: 32 })).toThrow(
      RangeError
    );
    expect(() => encode(SAMPLE_ULID, 'iad1', { version: 1.5 })).toThrow(
      RangeError
    );
  });
});

describe('region table coverage', () => {
  it('covers all 21 known Vercel compute regions plus hel1/zrh1 + unknown', () => {
    const expected: RegionKey[] = [
      'unknown',
      'iad1',
      'sfo1',
      'pdx1',
      'cle1',
      'yul1',
      'gru1',
      'dub1',
      'lhr1',
      'cdg1',
      'fra1',
      'bru1',
      'arn1',
      'hel1',
      'zrh1',
      'cpt1',
      'dxb1',
      'bom1',
      'sin1',
      'hkg1',
      'hnd1',
      'icn1',
      'kix1',
      'syd1',
    ];
    expect(Object.keys(REGION_IDS).sort()).toEqual([...expected].sort());
  });

  it('assigns each region a unique ID in [0, 63]', () => {
    const ids = Object.values(REGION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(MAX_REGION_ID);
    }
  });

  it('all known region codes round-trip through encode/decode', () => {
    for (const key of Object.keys(REGION_IDS) as RegionKey[]) {
      if (key === 'unknown') continue;
      const code: RegionCode = key;
      const tagged = encode(SAMPLE_ULID, code);
      const decoded = decode(tagged);
      expect(decoded.region).toBe(code);
      expect(decoded.regionId).toBe(REGION_IDS[code]);
    }
  });

  it('rejects the "unknown" sentinel string as a region code in encode', () => {
    // encode(_, 'unknown') was previously silently accepted (resolving to
    // regionId=0). It is now rejected at the type level and at runtime.
    expect(() => encode(SAMPLE_ULID, 'unknown' as RegionCode)).toThrow(
      /Unknown region/
    );
  });
});

describe('lexicographic order', () => {
  it('all tagged ULIDs sort above all untagged ULIDs', () => {
    // Tag bit on byte[0] sets the first char to ≥ '4'. Plain ULIDs that
    // haven't blown past year 2248 start with '0' or '1'.
    const minTagged = encode('0'.repeat(26), 0, { version: 0 });
    expect(minTagged).toBe('40000000000000000000000000');
    expect(minTagged > '3'.repeat(26)).toBe(true);
  });

  it('two tagged ULIDs with the same metadata preserve input ordering when they differ above the metadata bits', () => {
    // Pick two ULIDs differing in the timestamp (char[5]). The metadata
    // bits (top 11 bits of randomness) get normalized to the same values,
    // but the timestamp bits are preserved verbatim apart from the tag bit.
    const a = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const b = '01ARZ3NDEMTSV4RRFFQ69G5FAV';
    expect(a < b).toBe(true);
    const ta = encode(a, 'iad1');
    const tb = encode(b, 'iad1');
    expect(ta).toBe('41ARZ3NDEK0GV4RRFFQ69G5FAV');
    expect(tb).toBe('41ARZ3NDEM0GV4RRFFQ69G5FAV');
    expect(ta < tb).toBe(true);
  });

  it('preserves intra-millisecond monotonicity (low 69 randomness bits untouched)', () => {
    // The new layout puts metadata at the top of the randomness section,
    // so a monotonic ULID factory's bottom-bit increments survive encoding
    // intact. Simulate two consecutive monotonic-factory outputs that
    // share a timestamp and differ only in the bottom of randomness, then
    // verify the encoded forms still strictly increase.
    const a = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    // Identical to `a` except for the very last char (LSB of randomness).
    const aPlus1 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    expect(a < aPlus1).toBe(true);
    const ta = encode(a, 'iad1');
    const taPlus1 = encode(aPlus1, 'iad1');
    expect(ta < taPlus1).toBe(true);
    // And both decode back to the same metadata.
    expect(decode(ta).region).toBe('iad1');
    expect(decode(taPlus1).region).toBe('iad1');
    expect(decode(ta).version).toBe(CURRENT_VERSION);
    expect(decode(taPlus1).version).toBe(CURRENT_VERSION);
  });

  it('preserves order across a sequence of incrementing bottom bits', () => {
    // Stronger version of the previous test: synthesize a sequence of
    // ULIDs that share a timestamp and increment by 1 in the bottom of
    // randomness (the operation `monotonicFactory()` performs when called
    // multiple times in the same millisecond), then verify the encoded
    // sequence is strictly increasing.
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    function incrementBottomChar(s: string): string {
      const chars = s.split('');
      for (let i = chars.length - 1; i >= 0; i--) {
        const v = ALPHABET.indexOf(chars[i]);
        if (v < ALPHABET.length - 1) {
          chars[i] = ALPHABET[v + 1];
          return chars.join('');
        }
        chars[i] = '0';
      }
      throw new Error('overflow');
    }

    let current = '01ARZ3NDEKTSV4RRFFQ69G5F00';
    let prevEncoded = encode(current, 'iad1');
    for (let i = 0; i < 64; i++) {
      current = incrementBottomChar(current);
      const encoded = encode(current, 'iad1');
      expect(encoded > prevEncoded).toBe(true);
      prevEncoded = encoded;
    }
  });
});
