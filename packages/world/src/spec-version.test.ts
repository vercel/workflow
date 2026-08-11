import { describe, expect, it } from 'vitest';
import {
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
} from './spec-version.js';

describe('spec version constants', () => {
  it('current spec version is the compression version', () => {
    expect(SPEC_VERSION_CURRENT).toBe(SPEC_VERSION_SUPPORTS_COMPRESSION);
    expect(SPEC_VERSION_SUPPORTS_COMPRESSION).toBe(5);
  });

  it('the readable ceiling is the slot-identity version', () => {
    // The default a World stamps and the highest version this SDK can read
    // are separate dials. Slot identity is above the default on purpose: only
    // a World that actually allocates slots opts into it.
    expect(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY).toBe(6);
    expect(SPEC_VERSION_MAX_SUPPORTED).toBe(
      SPEC_VERSION_SUPPORTS_SLOT_IDENTITY
    );
    expect(SPEC_VERSION_MAX_SUPPORTED).toBeGreaterThanOrEqual(
      SPEC_VERSION_CURRENT
    );
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

  it('accepts a slot-identity run even though it is above the default', () => {
    // world-vercel stamps this version on the runs it creates. Testing
    // against SPEC_VERSION_CURRENT instead of the ceiling would make this SDK
    // reject the runs its own adapter just wrote.
    expect(requiresNewerWorld(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY)).toBe(false);
  });

  it('rejects runs newer than the highest supported spec version', () => {
    // This is the contract that protects older SDKs from compressed
    // payloads they cannot decode: a spec-5 run read by an SDK whose
    // ceiling is 4 fails this check up front (with RunNotSupportedError at
    // the storage layer) instead of failing on individual compressed
    // payloads.
    expect(requiresNewerWorld(SPEC_VERSION_MAX_SUPPORTED + 1)).toBe(true);
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
