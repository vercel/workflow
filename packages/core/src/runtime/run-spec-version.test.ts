import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world/spec-version';
import { describe, expect, it } from 'vitest';
import { specVersionForRunWrite } from './run-spec-version.js';

describe('specVersionForRunWrite', () => {
  it("stamps an older run's own version", () => {
    expect(specVersionForRunWrite(2)).toBe(2);
  });

  it('stamps a default run at the version this SDK mints', () => {
    expect(specVersionForRunWrite(SPEC_VERSION_CURRENT)).toBe(
      SPEC_VERSION_CURRENT
    );
  });

  it('stamps a spec 9 run at spec 9, though an unknown run is assumed spec 8', () => {
    // A process that mints spec 8 (WORKFLOW_SPEC_VERSION=8, or a World
    // without the fence) still writes hook resumes, cancels and wakes to
    // spec 9 runs created by one that mints spec 9.
    expect(specVersionForRunWrite(SPEC_VERSION_SINGLE_ORCHESTRATOR)).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
  });

  it('never stamps above the highest version this SDK supports', () => {
    expect(specVersionForRunWrite(SPEC_VERSION_MAX_SUPPORTED + 1)).toBe(
      SPEC_VERSION_MAX_SUPPORTED
    );
  });

  it('stamps the default version when the run has none recorded', () => {
    expect(specVersionForRunWrite(undefined)).toBe(SPEC_VERSION_CURRENT);
  });

  it('uses the given fallback when the run has none recorded', () => {
    expect(specVersionForRunWrite(undefined, SPEC_VERSION_LEGACY)).toBe(
      SPEC_VERSION_LEGACY
    );
  });
});
