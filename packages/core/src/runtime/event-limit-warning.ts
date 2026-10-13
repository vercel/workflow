import { QUICKJS_SNAPSHOT_REMEDIATION } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import { runtimeLogger } from '../logger.js';

/**
 * Fractions of the per-run event ceiling at which a run logs a warning
 * recommending the QuickJS VM with snapshotting, before it is failed with
 * `MAX_EVENTS_EXCEEDED`. Ascending.
 */
export const EVENT_LIMIT_WARNING_FRACTIONS = [0.5, 0.8, 0.95] as const;

/**
 * Cap on remembered (run, milestone) keys so a long-lived process doesn't
 * grow without bound. Losing old entries only risks a repeated warning.
 */
const MAX_WARNED_KEYS = 10_000;

const warnedKeys = globalSingleton(
  '@workflow/core//eventLimitWarnings',
  1,
  () => new Set<string>()
);

/**
 * The highest milestone in {@link EVENT_LIMIT_WARNING_FRACTIONS} that
 * `eventCount` has reached for `limit`, or `undefined` when below the first
 * one (or the run has no effective ceiling).
 */
export function getEventLimitMilestone(
  eventCount: number,
  limit: number | undefined
): number | undefined {
  // Exempt runs advertise Number.MAX_SAFE_INTEGER; nothing to warn about.
  if (limit === undefined || limit <= 0 || limit >= Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  let reached: number | undefined;
  for (const fraction of EVENT_LIMIT_WARNING_FRACTIONS) {
    if (eventCount >= Math.ceil(limit * fraction)) reached = fraction;
  }
  return reached;
}

/**
 * Log a warning when a run's event log crosses a milestone of the per-run
 * event ceiling, recommending the QuickJS VM with snapshotting. Logged once
 * per (run, milestone) per process: every invocation replays the full log,
 * so without dedupe a run past a milestone would warn on every step.
 *
 * `isQuickJS` tailors the hint for QuickJS runs that still have a ceiling
 * (snapshotting disabled, or the run's `executionContext` doesn't record
 * the QuickJS snapshot policy).
 */
export function maybeWarnApproachingEventLimit(args: {
  runId: string;
  workflowName: string;
  eventCount: number;
  limit: number | undefined;
  isQuickJS: boolean;
}): void {
  const { runId, workflowName, eventCount, limit, isQuickJS } = args;
  const milestone = getEventLimitMilestone(eventCount, limit);
  if (milestone === undefined) return;

  const key = `${runId}:${milestone}`;
  if (warnedKeys.has(key)) return;
  if (warnedKeys.size >= MAX_WARNED_KEYS) warnedKeys.clear();
  warnedKeys.add(key);

  const hint = isQuickJS
    ? 'This QuickJS run is still subject to the limit because it was not started with a positive ' +
      'snapshot threshold (WORKFLOW_SNAPSHOT_THRESHOLD=0, or WORKFLOW_VM=quickjs was not set where the run was started). ' +
      'Runs started with WORKFLOW_VM=quickjs and snapshotting enabled are exempt.'
    : QUICKJS_SNAPSHOT_REMEDIATION;

  runtimeLogger
    .forRun(runId, workflowName)
    .warn(
      `Workflow run is approaching the per-run event limit (${eventCount} of ${limit} events, ${Math.round(milestone * 100)}%). ` +
        `The run will fail with MAX_EVENTS_EXCEEDED when it reaches the limit. ${hint}`,
      {
        eventCount,
        maxEvents: limit,
        milestone,
        docs: 'https://workflow-sdk.dev/err/max-events-exceeded',
      }
    );
}

/** @internal Test-only. */
export function _resetEventLimitWarningsForTests(): void {
  warnedKeys.clear();
}
