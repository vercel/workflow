/**
 * The per-run event ceiling a workflow invocation enforces.
 *
 * The World owns the number: it rides back on the responses that set a replay
 * up (`run_started`, and the lazy hook resume's preload) as `maxEvents`. The
 * runtime is what *enforces* it — both engines re-check their event count
 * every replay / dispatch turn and fail the run with `MAX_EVENTS_EXCEEDED`
 * once it reaches the ceiling — so the World advertising no ceiling means no
 * enforcement at all.
 *
 * Two client-side rules sit between the advertised number and the number that
 * gets enforced, and this module is the single place both are applied:
 *
 * 1. `WORKFLOW_MAX_EVENTS_OVERRIDE` clamps the ceiling *down*.
 * 2. A run executing under the QuickJS engine with VM-memory snapshotting
 *    enabled is exempt from the ceiling entirely.
 */

import { getMaxEventsOverride } from './constants.js';
import {
  getSnapshotThreshold,
  type RunEnginePolicy,
  useQuickJSVm,
} from './vm-mode.js';

/**
 * Whether a run is exempt from the World's per-run event ceiling: the QuickJS
 * engine with VM-memory snapshotting switched on.
 *
 * The ceiling exists because a replay re-reads the whole log and re-executes
 * the workflow from the top, so a log that grows without bound eventually
 * cannot be replayed inside one invocation — the run dies of a replay timeout
 * instead of reporting anything useful, and the ceiling converts that into a
 * legible `MAX_EVENTS_EXCEEDED`. Snapshotting removes the premise: the engine
 * restores the VM and replays only the events recorded since the last
 * snapshot, so resume cost stops scaling with total log length and a long log
 * is no longer evidence of a run that can't make progress. See
 * `WORKFLOW_SNAPSHOT_THRESHOLD` in the runtime-tuning docs.
 *
 * Deliberately keyed on the *effective* policy rather than only the stamped
 * one. `useQuickJSVm` and `getSnapshotThreshold` both fall back to the
 * workflow handler's `WORKFLOW_VM` / `WORKFLOW_SNAPSHOT_THRESHOLD` when the
 * run carries no stamped policy (a run started from a deployment that doesn't
 * set those variables carries neither), and such a run snapshots exactly like
 * a stamped one. A World can only see what was persisted, so its advertised
 * ceiling cannot account for handler-side policy; this is the gap the
 * exemption has to close client-side.
 */
export function isExemptFromEventCeiling(run: RunEnginePolicy): boolean {
  try {
    return useQuickJSVm(run) && getSnapshotThreshold(run) > 0;
  } catch {
    // Both resolvers throw on an unparseable policy (unknown engine, negative
    // or non-integer threshold). A policy that doesn't parse is not one we can
    // show is snapshotting, so keep enforcing: lifting the ceiling must take
    // positive evidence. The engine reports the misconfiguration on its own
    // path (`useQuickJSVm` at dispatch, `getSnapshotThresholdForHandler` with
    // a warning); the ceiling is not the place to reinterpret it.
    return false;
  }
}

/**
 * Resolve the ceiling this invocation enforces from the World's advertised
 * `maxEvents` and the run's policy. `undefined` ⇒ enforce nothing.
 *
 * `run` is optional because the ceiling can arrive on a response that carried
 * no run snapshot; with no run there is no policy to read, so the World's
 * number stands.
 */
export function resolveMaxEventsLimit(
  worldLimit: number | undefined,
  run: RunEnginePolicy | undefined
): number | undefined {
  const override = getMaxEventsOverride();
  if (override !== undefined) {
    // Checked before the exemption, so the override stays the way to bound a
    // snapshotting run: setting it is an explicit request for a ceiling, and
    // an escape hatch the exemption can swallow is not an escape hatch. Still
    // clamp-down only, and still applies when the World advertises nothing.
    return worldLimit === undefined ? override : Math.min(worldLimit, override);
  }
  if (run !== undefined && isExemptFromEventCeiling(run)) return undefined;
  return worldLimit;
}
