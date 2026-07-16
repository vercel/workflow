import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunId, describeRun, regionForRunId } from './create-run-id.js';
import { decode } from './run-id/index.js';
import { REGION_IDS } from './run-id/regions.js';

describe('createRunId', () => {
  const originalRegion = process.env.VERCEL_REGION;

  afterEach(() => {
    if (originalRegion === undefined) delete process.env.VERCEL_REGION;
    else process.env.VERCEL_REGION = originalRegion;
    vi.useRealTimers();
  });

  describe('when VERCEL_REGION is a known region', () => {
    beforeEach(() => {
      process.env.VERCEL_REGION = 'iad1';
    });

    it('returns a 26-character tagged ULID', () => {
      const id = createRunId();
      expect(id).toHaveLength(26);
      const decoded = decode(id);
      expect(decoded.tagged).toBe(true);
    });

    it('embeds the resolved region ID and current version', () => {
      const id = createRunId();
      const decoded = decode(id);
      expect(decoded.regionId).toBe(REGION_IDS.iad1);
      expect(decoded.region).toBe('iad1');
      expect(decoded.version).toBe(1);
    });

    it('is monotonically increasing within a process', () => {
      const ids = Array.from({ length: 16 }, () => createRunId());
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
      // And all unique.
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('remains monotonic when 4096 IDs are minted in the same ms', () => {
      // Freeze time so every call deterministically lands in the same
      // millisecond. The metadata sits at the top of the randomness
      // section, so the underlying monotonic factory's bottom-bit
      // increments must survive encoding across a high call volume.
      vi.useFakeTimers();
      const ids = Array.from({ length: 4096 }, () => createRunId());
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true);
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('remains monotonic when the region changes within the same ms', () => {
      // Switching to a lower-numbered region mid-millisecond would, without
      // the lastRunId guard, produce a smaller ID (the region tag sits in
      // the most-significant randomness bits). This exercises the
      // bump-above-metadata fallback path in createRunId.
      vi.useFakeTimers();
      const first = createRunId({ region: 'fra1' });
      const second = createRunId({ region: 'iad1' });
      expect(REGION_IDS.iad1).toBeLessThan(REGION_IDS.fra1);
      expect(second > first).toBe(true);
      expect(decode(second).region).toBe('iad1');
      const third = createRunId({ region: 'fra1' });
      expect(third > second).toBe(true);
      expect(decode(third).region).toBe('fra1');
    });

    it('reflects later updates to process.env.VERCEL_REGION', () => {
      const iad = createRunId();
      expect(decode(iad).region).toBe('iad1');
      process.env.VERCEL_REGION = 'fra1';
      const fra = createRunId();
      expect(decode(fra).region).toBe('fra1');
    });
  });

  describe('when VERCEL_REGION is missing or unrecognised', () => {
    it('falls back to the default region (iad1) when unset', () => {
      delete process.env.VERCEL_REGION;
      const decoded = decode(createRunId());
      expect(decoded.tagged).toBe(true);
      expect(decoded.regionId).toBe(REGION_IDS.iad1);
      expect(decoded.region).toBe('iad1');
    });

    it('falls back to the default region (iad1) when the env var is empty', () => {
      process.env.VERCEL_REGION = '';
      const decoded = decode(createRunId());
      expect(decoded.regionId).toBe(REGION_IDS.iad1);
      expect(decoded.region).toBe('iad1');
    });

    it('falls back to the default region (iad1) for an unrecognised region code', () => {
      process.env.VERCEL_REGION = 'xyz9';
      const decoded = decode(createRunId());
      expect(decoded.regionId).toBe(REGION_IDS.iad1);
      expect(decoded.region).toBe('iad1');
    });

    it('does not treat the literal string "unknown" as a region', () => {
      // Defensive: the REGION_IDS table contains an `unknown` key but it is
      // a sentinel, not an actual region name. The env var should not be
      // matched against it — it falls back to the default region instead.
      process.env.VERCEL_REGION = 'unknown';
      const decoded = decode(createRunId());
      expect(decoded.regionId).toBe(REGION_IDS.iad1);
      expect(decoded.region).toBe('iad1');
    });

    it('never mints the "unknown" (0) region tag', () => {
      delete process.env.VERCEL_REGION;
      for (const region of [undefined, '', 'xyz9', 'unknown']) {
        if (region === undefined) delete process.env.VERCEL_REGION;
        else process.env.VERCEL_REGION = region;
        const decoded = decode(createRunId());
        expect(decoded.regionId).not.toBe(REGION_IDS.unknown);
        expect(decoded.region).not.toBeNull();
      }
    });
  });

  describe('with an explicit `options.region`', () => {
    it('prefers an explicit region over VERCEL_REGION', () => {
      process.env.VERCEL_REGION = 'iad1';
      const decoded = decode(createRunId({ region: 'fra1' }));
      expect(decoded.region).toBe('fra1');
      expect(decoded.regionId).toBe(REGION_IDS.fra1);
    });

    it('still falls back to VERCEL_REGION when options.region is missing', () => {
      process.env.VERCEL_REGION = 'sfo1';
      const decoded = decode(createRunId({}));
      expect(decoded.region).toBe('sfo1');
    });

    it('falls back to VERCEL_REGION when options.region is an unrecognised string', () => {
      process.env.VERCEL_REGION = 'sfo1';
      const decoded = decode(createRunId({ region: 'xyz9' }));
      expect(decoded.region).toBe('sfo1');
    });

    it('falls back to VERCEL_REGION when options.region is the empty string', () => {
      process.env.VERCEL_REGION = 'sfo1';
      const decoded = decode(createRunId({ region: '' }));
      expect(decoded.region).toBe('sfo1');
    });

    it('ignores non-string region hints (no throw, fall back)', () => {
      process.env.VERCEL_REGION = 'sfo1';
      const decoded = decode(
        createRunId({ region: 42 as unknown as undefined })
      );
      expect(decoded.region).toBe('sfo1');
    });

    it('ignores unrelated keys in the options bag', () => {
      // start()'s opts object contains keys like `deploymentId`,
      // `specVersion`, `world`, etc. — `createRunId` reads only the
      // fields it recognises and ignores the rest.
      process.env.VERCEL_REGION = 'iad1';
      const decoded = decode(
        createRunId({
          deploymentId: 'dpl_test',
          specVersion: 3,
          unrelated: 'value',
        })
      );
      expect(decoded.region).toBe('iad1');
    });

    it('accepts an undefined options bag (matching the World.createRunId signature)', () => {
      process.env.VERCEL_REGION = 'iad1';
      const decoded = decode(createRunId(undefined));
      expect(decoded.region).toBe('iad1');
    });
  });
});

describe('regionForRunId', () => {
  it('decodes the region from tagged run IDs (with or without prefix)', () => {
    const runId = `wrun_${createRunId({ region: 'sfo1' })}`;
    expect(regionForRunId(runId)).toBe('sfo1');
    expect(regionForRunId(runId.slice('wrun_'.length))).toBe('sfo1');
  });

  it('resolves untagged legacy run IDs to the default region', () => {
    expect(regionForRunId('wrun_01KX2M5N3RBNC12RYWYYH4WWQJ')).toBe('iad1');
  });

  it('returns null for malformed run IDs instead of throwing', () => {
    expect(regionForRunId('wrun_not-a-ulid')).toBeNull();
    expect(regionForRunId('')).toBeNull();
  });
});

describe('describeRun', () => {
  it('returns a region field derived from the run ID tag', () => {
    const runId = `wrun_${createRunId({ region: 'sfo1' })}`;
    expect(describeRun({ runId })).toEqual({ region: 'sfo1' });
  });

  it('resolves untagged legacy runs to the default region', () => {
    expect(describeRun({ runId: 'wrun_01KX2M5N3RBNC12RYWYYH4WWQJ' })).toEqual({
      region: 'iad1',
    });
  });

  it('returns a null region for undecodable run IDs (never throws)', () => {
    expect(describeRun({ runId: 'wrun_not-a-ulid' })).toEqual({
      region: null,
    });
  });

  it('contributes nothing when the entity has no usable runId', () => {
    expect(describeRun({})).toBeNull();
    expect(describeRun({ runId: 42 })).toBeNull();
    expect(describeRun({ runId: '' })).toBeNull();
  });
});
