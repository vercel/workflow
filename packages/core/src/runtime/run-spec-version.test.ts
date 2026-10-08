import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
} from '@workflow/world/spec-version';
import { describe, expect, it } from 'vitest';
import { specVersionForRunWrite } from './run-spec-version.js';

describe('specVersionForRunWrite', () => {
  it("stamps an older run's own version", () => {
    expect(specVersionForRunWrite(2)).toBe(2);
  });

  it("stamps this SDK's version for a current run", () => {
    expect(specVersionForRunWrite(SPEC_VERSION_CURRENT)).toBe(
      SPEC_VERSION_CURRENT
    );
  });

  it("never stamps above this SDK's version", () => {
    expect(specVersionForRunWrite(SPEC_VERSION_CURRENT + 1)).toBe(
      SPEC_VERSION_CURRENT
    );
  });

  it("stamps this SDK's version when the run has none recorded", () => {
    expect(specVersionForRunWrite(undefined)).toBe(SPEC_VERSION_CURRENT);
  });

  it('uses the given fallback when the run has none recorded', () => {
    expect(specVersionForRunWrite(undefined, SPEC_VERSION_LEGACY)).toBe(
      SPEC_VERSION_LEGACY
    );
  });
});
