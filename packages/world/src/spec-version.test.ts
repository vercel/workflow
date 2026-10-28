import { describe, expect, it } from 'vitest';
import * as specVersions from './spec-version.js';
import {
  CAPABILITY_ONLY_SPEC_VERSIONS,
  crossesStructuralSpecVersion,
  isLegacySpecVersion,
  mintedSpecVersion,
  requiresNewerWorld,
  SEALED_LOG_ENV_VAR,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  SPEC_VERSION_SUPPORTS_SEALED_LOG,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  STRUCTURAL_SPEC_VERSIONS,
} from './spec-version.js';

describe('spec version classification', () => {
  const versionConstants = Object.entries(specVersions).filter(([name]) =>
    name.startsWith('SPEC_VERSION_SUPPORTS_')
  ) as [string, number][];

  it.each(
    versionConstants
  )('%s is classified as capability-only or structural', (_name, version) => {
    // A new version constant must be placed in exactly one set: a backend
    // raises running runs across capability-only versions, so leaving a
    // structural one out of STRUCTURAL_SPEC_VERSIONS is only safe because
    // the check is an allow-list, and this keeps the lists honest.
    expect(
      Number(CAPABILITY_ONLY_SPEC_VERSIONS.has(version)) +
        Number(STRUCTURAL_SPEC_VERSIONS.has(version))
    ).toBe(1);
  });

  it('treats slot identity and the sealed log as structural', () => {
    expect(crossesStructuralSpecVersion(5, 6)).toBe(true);
    expect(crossesStructuralSpecVersion(6, 7)).toBe(true);
    expect(crossesStructuralSpecVersion(3, 8)).toBe(true);
  });

  it('lets capability-only versions be crossed', () => {
    expect(crossesStructuralSpecVersion(3, 5)).toBe(false);
    expect(crossesStructuralSpecVersion(7, 8)).toBe(false);
    expect(crossesStructuralSpecVersion(8, 8)).toBe(false);
  });

  it('treats an unclassified future version as structural', () => {
    expect(
      crossesStructuralSpecVersion(
        SPEC_VERSION_MAX_SUPPORTED,
        SPEC_VERSION_MAX_SUPPORTED + 1
      )
    ).toBe(true);
  });
});

describe('spec version constants', () => {
  it('current spec version is the hook-force-claim version', () => {
    expect(SPEC_VERSION_SUPPORTS_SLOT_IDENTITY).toBe(6);
    expect(SPEC_VERSION_SUPPORTS_SEALED_LOG).toBe(7);
    expect(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM).toBe(8);
    expect(SPEC_VERSION_CURRENT).toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
  });

  describe('mintedSpecVersion', () => {
    it('stamps the current version by default', () => {
      expect(mintedSpecVersion({})).toBe(SPEC_VERSION_CURRENT);
      expect(mintedSpecVersion({})).toBeGreaterThanOrEqual(
        SPEC_VERSION_SUPPORTS_SEALED_LOG
      );
    });

    it('falls back to slot identity when switched off', () => {
      for (const off of ['0', 'false']) {
        expect(mintedSpecVersion({ [SEALED_LOG_ENV_VAR]: off })).toBe(
          SPEC_VERSION_SUPPORTS_SLOT_IDENTITY
        );
      }
    });

    it('stays on by default for an unset or malformed value', () => {
      // A flag is an escape hatch, not a hard requirement: a typo must not
      // silently move a deployment onto the older identity scheme.
      for (const raw of ['', '1', 'true', 'yes-please']) {
        expect(mintedSpecVersion({ [SEALED_LOG_ENV_VAR]: raw })).toBe(
          SPEC_VERSION_CURRENT
        );
      }
    });

    it('never stamps a version this build cannot read back', () => {
      expect(mintedSpecVersion({})).toBeLessThanOrEqual(
        SPEC_VERSION_MAX_SUPPORTED
      );
    });
  });

  it('the readable ceiling moves with the version we stamp', () => {
    // "What do we write?" and "what can we still read?" are separate dials,
    // and the ceiling must never sit below the default: an SDK that stamps a
    // version it cannot read back would reject its own runs.
    expect(SPEC_VERSION_MAX_SUPPORTED).toBe(
      SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
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
