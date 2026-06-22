import { describe, expect, it } from 'vitest';
import {
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
} from './spec-version.js';

describe('spec version constants', () => {
  it('current spec version is the compression version', () => {
    expect(SPEC_VERSION_CURRENT).toBe(SPEC_VERSION_SUPPORTS_COMPRESSION);
    expect(SPEC_VERSION_SUPPORTS_COMPRESSION).toBe(5);
  });
});

describe('requiresNewerWorld', () => {
  it('accepts runs at or below the current spec version', () => {
    expect(requiresNewerWorld(SPEC_VERSION_CURRENT)).toBe(false);
    expect(requiresNewerWorld(SPEC_VERSION_SUPPORTS_ATTRIBUTES)).toBe(false);
    expect(requiresNewerWorld(SPEC_VERSION_LEGACY)).toBe(false);
    expect(requiresNewerWorld(undefined)).toBe(false);
    expect(requiresNewerWorld(null)).toBe(false);
  });

  it('rejects runs newer than the current spec version', () => {
    // This is the contract that protects older SDKs from compressed
    // payloads they cannot decode: a spec-5 run read by an SDK whose
    // SPEC_VERSION_CURRENT is 4 fails this check up front (with
    // RunNotSupportedError at the storage layer) instead of failing on
    // individual gzip payloads.
    expect(requiresNewerWorld(SPEC_VERSION_CURRENT + 1)).toBe(true);
  });

  it('simulates a v4 reader rejecting a compression-era run', () => {
    // A v4 SDK has SPEC_VERSION_CURRENT = 4. Its requiresNewerWorld(v)
    // is `v > 4`, so a spec-5 run is rejected. We can't import the old
    // constant, so replicate the v4 predicate explicitly.
    const v4RequiresNewerWorld = (v: number) => v > 4;
    expect(v4RequiresNewerWorld(SPEC_VERSION_SUPPORTS_COMPRESSION)).toBe(true);
  });
});

describe('isLegacySpecVersion', () => {
  it('is unaffected by the current-version bump', () => {
    expect(isLegacySpecVersion(1)).toBe(true);
    expect(isLegacySpecVersion(undefined)).toBe(true);
    expect(isLegacySpecVersion(2)).toBe(false);
    expect(isLegacySpecVersion(4)).toBe(false);
    expect(isLegacySpecVersion(5)).toBe(false);
  });
});
