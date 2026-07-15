import type { Event } from '@workflow/world';

/**
 * Client-side latency measurement (TTFS / STSO) threaded from the
 * orchestrator's inline execution path into `executeStep`.
 *
 * TTFS (time-to-first-step) measures run creation → the first step's body
 * beginning to execute. STSO (step-to-step overhead) measures the previous
 * step's terminal event → the next step's body beginning to execute. Both are
 * attached to the step's terminal event so a backend can emit latency metrics
 * from the event write alone, without extra event-log queries.
 *
 * Eligibility is decided by the orchestrator (which owns the event log) via
 * {@link computeStepLatencyTracking}; the final values are computed by
 * `executeStep` right before user code runs via
 * {@link computeStepLatencyEventData}.
 */
export interface StepLatencyTracking {
  /**
   * Epoch ms of run creation (from the run-id ULID, falling back to the run
   * snapshot's `createdAt`). Present only when the step qualifies for TTFS.
   */
  ttfsAnchorMs?: number;
  /**
   * Wall-clock ms this invocation spent committing `hook_created` events
   * before the first step (fire-and-forget `createHook()` ahead of the first
   * step commits in the same suspension batch). Subtracted from TTFS so the
   * metric reflects runtime overhead rather than the user's hook writes.
   */
  preStepBlockingMs?: number;
  /**
   * Epoch ms the first pre-step `attr_set` write began (its client-stamped
   * `occurredAt`, falling back to `createdAt`). When present, the TTFS
   * measurement ENDS here instead of at the step's code start: a
   * workflow-body `setAttributes` before the first step
   * resolves through an extra replay (see the `hasAttributeEvents` branch in
   * runtime.ts), so everything from this write until the step body runs is
   * the duration of the setAttributes call — which is subtracted by ending
   * the measurement at the point where the step would otherwise have been
   * scheduled.
   */
  preStepAttrStartMs?: number;
  /**
   * Epoch ms the previous step's terminal event was recorded (its
   * client-stamped `occurredAt`, falling back to `createdAt`). Present only
   * when the step qualifies for STSO.
   */
  prevStepEndMs?: number;
  /** Number of unique terminal steps already in the event log. */
  stepCount?: number;
  /** Number of events already in the event log. */
  eventCount?: number;
  /** Whether turbo mode is active for this invocation. */
  turbo: boolean;
}

/**
 * Most negative raw duration still attributed to cross-machine clock skew
 * (and clamped to 0). Anything more negative means a corrupt anchor — e.g. a
 * mis-decoded run-ID timestamp — and the sample is dropped instead: a
 * systematically corrupt anchor would otherwise report an exact-zero latency
 * on every sample, silently dragging entire percentile distributions to 0
 * rather than surfacing as missing data.
 */
const MAX_CLOCK_SKEW_MS = 60_000;

/** Latency telemetry attached to a step's terminal event's `eventData`. */
export interface StepLatencyEventData {
  ttfs?: number;
  stso?: number;
  stepCount?: number;
  eventCount?: number;
  optimizations?: string[];
}

/**
 * Event types that disqualify TTFS when present in the event log at the time
 * the run's first step batch is scheduled:
 *
 * - Any step event means this is not the run's first step execution.
 * - `hook_received` / `wait_created` / `wait_completed` mean the run's path to
 *   the first step depended on user-driven timing (a webhook arriving, a
 *   sleep elapsing), so the measurement would not reflect runtime overhead.
 *
 * Deliberately absent, with their cost subtracted instead:
 *
 * - `hook_created`: a fire-and-forget `createHook()` before the first step
 *   commits in the same invocation, whose measured duration is subtracted via
 *   {@link StepLatencyTracking.preStepBlockingMs}.
 * - `attr_set` (workflow-body `setAttributes`): resolves through
 *   an extra replay before steps run. Subtracted by ending the measurement at
 *   the first attr write's timestamp instead — see
 *   {@link StepLatencyTracking.preStepAttrStartMs}.
 */
const TTFS_DISQUALIFYING_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set(
  [
    'step_created',
    'step_started',
    'step_completed',
    'step_failed',
    'step_retrying',
    'hook_received',
    'wait_created',
    'wait_completed',
  ]
);

/**
 * Decide, from the orchestrator's view of the event log, whether the inline
 * step batch about to execute qualifies for TTFS and/or STSO measurement.
 * Returns undefined when neither applies. Called once per batch; the result
 * is passed to the batch's first step only, so a parallel first batch emits a
 * single sample rather than one per sibling.
 */
export function computeStepLatencyTracking(params: {
  /** The orchestrator's current in-memory event log (ascending order). */
  events: Event[];
  /**
   * Whether this invocation's initial event load contained nothing beyond
   * run_created/run_started/attr_set. Pre-existing hook events were written
   * by an earlier invocation, so the time they added (including the queue
   * hop back to this invocation) is unmeasurable and disqualifies TTFS.
   * attr_set is permitted: a redelivery can land after a committed pre-step
   * attr_set, and the detour it marks is subtracted via `preStepAttrStartMs`
   * regardless of which invocation wrote it.
   */
  invocationStartedClean: boolean;
  /** Epoch ms of run creation, if recoverable. Absent disqualifies TTFS. */
  runCreatedAtMs: number | undefined;
  /** See {@link StepLatencyTracking.preStepBlockingMs}. */
  preStepBlockingMs: number;
  /**
   * The accumulator's value as of the suspension that wrote the run's first
   * attr_set (its hook phase runs before its attr writes). When the
   * measurement ends at the attr write, only hook time from before that
   * point may be subtracted — later hook writes fall outside the measured
   * window. Undefined when no attr suspension happened in this invocation
   * (e.g. the attr_set was loaded from a redelivery's snapshot, where no
   * same-invocation hook time precedes it).
   */
  preStepBlockingBeforeAttrMs: number | undefined;
  /**
   * Whether the suspension that scheduled this batch also created waits.
   * Those `wait_created` writes are not in `events` yet (they were committed
   * by this very suspension pass), so they must be reported separately. A
   * wait disqualifies both measurements.
   */
  suspensionHasWaits: boolean;
  /**
   * Whether the suspension that scheduled this batch also created hooks
   * (also not in `events` yet). Hooks keep TTFS eligible — their measured
   * write time is subtracted via `preStepBlockingMs` — but disqualify STSO,
   * which is only meaningful for a pure back-to-back step gap.
   */
  suspensionCreatedHooks: boolean;
  /** Whether turbo mode is active for this invocation. */
  turbo: boolean;
}): StepLatencyTracking | undefined {
  const { events } = params;

  let ttfsEligible =
    params.invocationStartedClean &&
    params.runCreatedAtMs !== undefined &&
    !params.suspensionHasWaits;
  let preStepAttrStartMs: number | undefined;
  if (ttfsEligible) {
    for (const event of events) {
      if (TTFS_DISQUALIFYING_EVENT_TYPES.has(event.eventType)) {
        ttfsEligible = false;
        break;
      }
      if (event.eventType === 'attr_set') {
        const attrStartMs = +(event.occurredAt ?? event.createdAt);
        preStepAttrStartMs =
          preStepAttrStartMs === undefined
            ? attrStartMs
            : Math.min(preStepAttrStartMs, attrStartMs);
      }
    }
  }

  // STSO: the two steps ran back-to-back — the newest known event is the
  // previous step's terminal event, with nothing (hook_received, waits,
  // attr_set, ...) in between and this suspension scheduling nothing but
  // steps.
  let prevStepEndMs: number | undefined;
  let stepCount: number | undefined;
  let eventCount: number | undefined;
  const lastEvent = events[events.length - 1];
  if (
    !params.suspensionHasWaits &&
    !params.suspensionCreatedHooks &&
    lastEvent &&
    (lastEvent.eventType === 'step_completed' ||
      lastEvent.eventType === 'step_failed')
  ) {
    prevStepEndMs = +(lastEvent.occurredAt ?? lastEvent.createdAt);
    const terminalStepIds = new Set<string>();
    for (const event of events) {
      if (
        (event.eventType === 'step_completed' ||
          event.eventType === 'step_failed') &&
        event.correlationId !== undefined
      ) {
        terminalStepIds.add(event.correlationId);
      }
    }
    stepCount = terminalStepIds.size;
    eventCount = events.length;
  }

  if (!ttfsEligible && prevStepEndMs === undefined) {
    return undefined;
  }

  return {
    ...(ttfsEligible
      ? {
          ttfsAnchorMs: params.runCreatedAtMs,
          // When the measurement ends at the first attr write, only hook
          // time from before that point is inside the measured window.
          preStepBlockingMs:
            preStepAttrStartMs !== undefined
              ? (params.preStepBlockingBeforeAttrMs ?? 0)
              : params.preStepBlockingMs,
          ...(preStepAttrStartMs !== undefined ? { preStepAttrStartMs } : {}),
        }
      : {}),
    ...(prevStepEndMs !== undefined
      ? { prevStepEndMs, stepCount, eventCount }
      : {}),
    turbo: params.turbo,
  };
}

/**
 * Compute the latency telemetry to attach to the step's terminal event.
 * Called by `executeStep` with the wall-clock timestamp taken immediately
 * before user step code runs. Returns undefined when there is nothing to
 * report (no tracking, or a retry attempt — retries measure neither TTFS nor
 * STSO).
 */
export function computeStepLatencyEventData(params: {
  tracking: StepLatencyTracking | undefined;
  /** `Date.now()` taken immediately before user step code began executing. */
  stepCodeStartedAtMs: number;
  attempt: number;
  /** Whether this step was started lazily (no separate step_created write). */
  lazyStepStart: boolean;
  /** Whether the body ran optimistically, without awaiting step_started. */
  optimisticStart: boolean;
}): StepLatencyEventData | undefined {
  const { tracking } = params;
  if (!tracking || params.attempt !== 1) {
    return undefined;
  }

  // Small negative durations clamp to 0: cross-invocation timestamps can
  // come from another machine's clock, so bounded skew must not produce
  // negative values. Durations more negative than MAX_CLOCK_SKEW_MS are not
  // skew but a corrupt anchor, and the sample is dropped (see the constant's
  // doc comment).
  //
  // A pre-step setAttributes detour ends the measurement at the first attr
  // write instead of the step's code start — the remainder is the duration
  // of the setAttributes call (resolved via an extra replay), which is
  // subtracted rather than disqualifying the sample. In that case
  // `tracking.preStepBlockingMs` already holds only the hook time from
  // BEFORE the attr write — hook writes after the window closed are excluded
  // by computeStepLatencyTracking (see preStepBlockingBeforeAttrMs).
  const ttfsEndMs = tracking.preStepAttrStartMs ?? params.stepCodeStartedAtMs;
  const rawTtfs =
    tracking.ttfsAnchorMs !== undefined
      ? ttfsEndMs - tracking.ttfsAnchorMs - (tracking.preStepBlockingMs ?? 0)
      : undefined;
  const ttfs =
    rawTtfs !== undefined && rawTtfs >= -MAX_CLOCK_SKEW_MS
      ? Math.max(0, rawTtfs)
      : undefined;
  const rawStso =
    tracking.prevStepEndMs !== undefined
      ? params.stepCodeStartedAtMs - tracking.prevStepEndMs
      : undefined;
  const stso =
    rawStso !== undefined && rawStso >= -MAX_CLOCK_SKEW_MS
      ? Math.max(0, rawStso)
      : undefined;

  if (ttfs === undefined && stso === undefined) {
    return undefined;
  }

  const optimizations: string[] = [];
  if (tracking.turbo) optimizations.push('turbo');
  if (params.lazyStepStart) optimizations.push('lazyStepStart');
  if (params.optimisticStart) optimizations.push('optimisticStart');

  return {
    ...(ttfs !== undefined ? { ttfs } : {}),
    ...(stso !== undefined ? { stso } : {}),
    ...(stso !== undefined && tracking.stepCount !== undefined
      ? { stepCount: tracking.stepCount }
      : {}),
    ...(stso !== undefined && tracking.eventCount !== undefined
      ? { eventCount: tracking.eventCount }
      : {}),
    optimizations,
  };
}
