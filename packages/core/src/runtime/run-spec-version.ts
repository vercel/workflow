import { SPEC_VERSION_CURRENT } from '@workflow/world/spec-version';

/**
 * The spec version to stamp on an event written to a run by a process that may
 * not be the one executing it: the run's own version when it is lower than this
 * SDK's.
 *
 * The runtime executing a run reads every event in its log, and one built
 * against a lower spec version (an older deployment, or another SDK) rejects an
 * event stamped above what it supports. The Python SDK rejects the run's whole
 * event log over a single such event. Capped at this SDK's version too, since
 * that is the newest format this SDK can write.
 *
 * `whenUnknown` is used for a run with no recorded version. It defaults to this
 * SDK's; callers that treat such a run as legacy pass `SPEC_VERSION_LEGACY`.
 */
export function specVersionForRunWrite(
  runSpecVersion: number | undefined,
  whenUnknown: number = SPEC_VERSION_CURRENT
): number {
  return Math.min(SPEC_VERSION_CURRENT, runSpecVersion ?? whenUnknown);
}
