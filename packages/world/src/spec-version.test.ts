import { describe, expect, it } from 'vitest';
import {
  isLegacySpecVersion,
  mintedSpecVersion,
  requiresNewerWorld,
  SLOT_IDENTITY_ENV_VAR,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SLOT_IDENTITY,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
} from './spec-version.js';

describe('spec version constants', () => {
  it('current spec version is the compression version', () => {
    expect(SPEC_VERSION_CURRENT).toBe(SPEC_VERSION_SUPPORTS_COMPRESSION);
    expect(SPEC_VERSION_SUPPORTS_COMPRESSION).toBe(5);
  });

  it('can read a newer spec version than it mints', () => {
    // Slot identity is readable by every world before any world mints it, so
    // that turning it on for new runs cannot make those same worlds reject
    // them. Once slots are the default the two constants coincide again.
    expect(SPEC_VERSION_MAX_SUPPORTED).toBe(SPEC_VERSION_SLOT_IDENTITY);
    expect(SPEC_VERSION_MAX_SUPPORTED).toBeGreaterThanOrEqual(
      SPEC_VERSION_CURRENT
    );
  });
});

describe('requiresNewerWorld', () => {
  it('accepts runs at or below the newest readable spec version', () => {
    expect(requiresNewerWorld(SPEC_VERSION_MAX_SUPPORTED)).toBe(false);
    expect(requiresNewerWorld(SPEC_VERSION_CURRENT)).toBe(false);
    expect(requiresNewerWorld(SPEC_VERSION_SUPPORTS_ATTRIBUTES)).toBe(false);
    expect(requiresNewerWorld(SPEC_VERSION_LEGACY)).toBe(false);
    expect(requiresNewerWorld(undefined)).toBe(false);
    expect(requiresNewerWorld(null)).toBe(false);
  });

  it('accepts a slot-identity run', () => {
    // Gates the flag rollout: a world that rejected spec-6 would reject the
    // runs it had just stamped spec-6 itself, at their first event after
    // run_created.
    expect(requiresNewerWorld(SPEC_VERSION_SLOT_IDENTITY)).toBe(false);
  });

  it('rejects runs newer than the newest readable spec version', () => {
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

describe('mintedSpecVersion', () => {
  it('mints the current version by default', () => {
    expect(mintedSpecVersion({})).toBe(SPEC_VERSION_CURRENT);
  });

  it('mints slot identity when the flag is set', () => {
    for (const value of ['1', 'true']) {
      expect(mintedSpecVersion({ [SLOT_IDENTITY_ENV_VAR]: value })).toBe(
        SPEC_VERSION_SLOT_IDENTITY
      );
    }
  });

  it('treats any other value as off', () => {
    // An unset-but-present variable is the shape a shell leaves behind, and it
    // must not silently switch a deployment's event identity scheme.
    for (const value of ['', '0', 'false', 'yes']) {
      expect(mintedSpecVersion({ [SLOT_IDENTITY_ENV_VAR]: value })).toBe(
        SPEC_VERSION_CURRENT
      );
    }
  });

  it('mints nothing a world cannot read', () => {
    expect(
      requiresNewerWorld(mintedSpecVersion({ [SLOT_IDENTITY_ENV_VAR]: '1' }))
    ).toBe(false);
  });
});
