import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_MAX_SUPPORTED,
} from '@workflow/world/spec-version';

/**
 * The spec version to stamp on an event written to a run by a process that may
 * not be the one executing it: the run's own version when it is lower than this
 * SDK's.
 *
 * The runtime executing a run reads every event in its log, and one built
 * against a lower spec version (an older deployment, or another SDK) rejects an
 * event stamped above what it supports. The Python SDK rejects the run's whole
 * event log over a single such event. Capped at the highest version this SDK
 * can drive, `SPEC_VERSION_MAX_SUPPORTED`, not at the version it mints: a
 * process that creates spec 8 runs still stamps 9 on the `hook_received`,
 * `run_cancelled` and wake events it writes to a spec 9 run, which may have
 * been created by a process with `WORKFLOW_SPEC_VERSION=9` set.
 *
 * `whenUnknown` is used for a run with no recorded version. It defaults to the
 * version this SDK mints by default (`SPEC_VERSION_CURRENT`); callers that
 * treat such a run as legacy pass `SPEC_VERSION_LEGACY`.
 */
export function specVersionForRunWrite(
  runSpecVersion: number | undefined,
  whenUnknown: number = SPEC_VERSION_CURRENT
): number {
  return Math.min(SPEC_VERSION_MAX_SUPPORTED, runSpecVersion ?? whenUnknown);
}
