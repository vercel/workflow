import type { HookResumeTiming } from '@workflow/world';
import * as Attribute from '../telemetry/semantic-conventions.js';

/**
 * Hook-triggered time-to-resume (TTR): wall-clock from entry into
 * `resumeHook()` (T0) to the first line of the next durable step (T7), plus a
 * decomposition into non-overlapping phases that sum exactly to it.
 *
 * ```text
 * T0 resumeHook() entered
 *      producer_prep   : hook lookup, serialization, encryption
 * T1 queue publish requested
 *      queue_delivery  : network + VQS delivery (incl. any affinity re-route)
 * T2 final consumer's queue handler entered
 *      resume_setup    : affinity check, hook_received re-ensure, replay preload
 * T3 replay begins
 *      replay          : VM/session creation and workflow replay
 * T4 next durable step encountered
 *      step_dispatch   : suspension handling, inline batch or queue dispatch
 * T5 step_started request begins
 *      step_claim      : the claim round trip
 * T6 step_started response returned
 *      step_prepare    : key resolution, argument hydration, context setup
 * T7 immediately before stepFn.apply()
 * ```
 *
 * On the lazy path the producer writes no `hook_received` at all (the
 * consumer materializes it from `hookInput`), so the window has no producer
 * write phase. On the sequential path that write is awaited inside
 * `producer_prep`, and for messages from an older producer, which raced the
 * write against the publish, it overlapped `producer_prep` rather than adding
 * to it. Either way it has no phase of its own; it remains visible as a
 * contextual span (`hook.resume`).
 *
 * T0/T1 are stamped on the producer's machine and T2..T7 on the consumer's, so
 * the measurement is subject to cross-machine clock skew. Rather than clamp
 * (which would break the sum-equals-total property this decomposition exists
 * for), a non-monotonic boundary set drops the whole sample; see
 * {@link computeResumeTtrAttributes}.
 */

/** What caused the resumption being measured. Only hooks are measured today. */
export type ResumeTrigger = 'hook';

/**
 * Which `resumeHook()` dispatch path produced this resume.
 *
 * `parallel` is only ever received from an older producer, which raced its own
 * `hook_received` write against the publish. Current producers send `lazy` (no
 * producer write: the consumer materializes the event from `hookInput`) or
 * `sequential`.
 */
export type ResumeStrategy = 'lazy' | 'parallel' | 'sequential';

/**
 * How the consuming invocation initialized its replay state:
 *
 * - `hook_preload`: the hoisted `hook_received` write returned a usable
 *   replay preload, so neither `run_started` nor the initial `events.list` ran.
 * - `run_started`: the generic `run_started` setup ran (including the fast
 *   path's fallback, where the hoisted write succeeded but returned no usable
 *   preload).
 * - `event_load`: neither setup ran because the run arrived already loaded,
 *   so setup was a plain event load. No current path produces it (the one
 *   preloaded-run path, the background-step fall-through, consumes the
 *   tracking on its own step first); it is the honest default rather than a
 *   live value, and keeps the dimension total if such a path is added.
 */
export type ResumeSetupSource = 'hook_preload' | 'run_started' | 'event_load';

/** Whether the measured step ran in the resuming invocation or a queued one. */
export type ResumeStepExecution = 'inline' | 'dispatched';

/**
 * The resume boundaries observed so far, threaded from the queue handler into
 * `executeStep`. Producer fields arrive on the queue message
 * ({@link HookResumeTiming}); consumer fields are stamped by the invocation
 * that replays the resume.
 *
 * The runtime holds at most one of these per invocation and CONSUMES it when
 * it hands it to the execution that will attempt the next durable step, so a
 * later step in the same invocation (or a retry of the same step) never
 * re-reports the same resumption. Within one inline batch the object is
 * shared by every step and the {@link ResumeTtrTracking.reported} latch picks
 * the single reporter.
 */
export interface ResumeTtrTracking {
  trigger: ResumeTrigger;
  /** Absent only if an older producer omitted it from the queue message. */
  strategy?: ResumeStrategy;
  /** T0: entry into `resumeHook()`. */
  resumeRequestedAtMs: number;
  /** T1: immediately before the queue publish was requested. */
  queuePublishRequestedAtMs: number;
  /**
   * T2: entry into the FINAL consumer's queue handler. A delivery that
   * re-routes for deployment affinity never stamps this, so the re-routed hop
   * stays inside `queue_delivery` where it belongs.
   */
  consumerStartedAtMs: number;
  /** T3: this invocation's first replay pass. */
  replayStartedAtMs?: number;
  /** T4: replay first encountered a durable step after the resume. */
  nextStepEncounteredAtMs?: number;
  setupSource?: ResumeSetupSource;
  stepExecution: ResumeStepExecution;
  /**
   * One-shot latch, set by the step executor once this resumption has been
   * reported. Every step of an inline batch is handed the SAME tracking
   * object, so the first one to reach user code takes the measurement and the
   * rest see this and skip: one resumption, one sample, without pinning the
   * sample to a step that may lose its create-claim and never run.
   *
   * Deliberately not part of {@link HookResumeTiming}: it is invocation-local
   * state, and a queue message carries the boundaries, not the claim.
   */
  reported?: boolean;
}

/**
 * Rebuild tracking from a queue message's timing object. Returns undefined for
 * a message that carries none (an older producer, or any non-hook delivery);
 * the caller then reports no TTR.
 */
export function resumeTrackingFromMessage(
  timing: HookResumeTiming | undefined,
  stepExecution: ResumeStepExecution
): ResumeTtrTracking | undefined {
  if (!timing) return undefined;
  if (
    !Number.isFinite(timing.resumeRequestedAtMs) ||
    !Number.isFinite(timing.queuePublishRequestedAtMs)
  ) {
    return undefined;
  }
  return {
    trigger: 'hook',
    ...(timing.strategy === 'lazy' ||
    timing.strategy === 'parallel' ||
    timing.strategy === 'sequential'
      ? { strategy: timing.strategy }
      : {}),
    resumeRequestedAtMs: timing.resumeRequestedAtMs,
    queuePublishRequestedAtMs: timing.queuePublishRequestedAtMs,
    // A dispatched step reads the resuming invocation's boundaries off the
    // message; an inline one has them stamped locally by the caller, which
    // overwrites this placeholder immediately after construction.
    consumerStartedAtMs: timing.consumerStartedAtMs ?? Number.NaN,
    ...(timing.replayStartedAtMs !== undefined
      ? { replayStartedAtMs: timing.replayStartedAtMs }
      : {}),
    ...(timing.nextStepEncounteredAtMs !== undefined
      ? { nextStepEncounteredAtMs: timing.nextStepEncounteredAtMs }
      : {}),
    ...(timing.setupSource === 'hook_preload' ||
    timing.setupSource === 'run_started' ||
    timing.setupSource === 'event_load'
      ? { setupSource: timing.setupSource }
      : {}),
    stepExecution,
  };
}

/**
 * Serialize tracking back onto a queue message, for the case where the
 * resuming invocation dispatches the next durable step to another invocation
 * instead of running it inline. Returns undefined when the tracking is not
 * complete enough to be worth forwarding.
 */
export function resumeTimingForMessage(
  tracking: ResumeTtrTracking | undefined
): HookResumeTiming | undefined {
  if (!tracking) return undefined;
  if (!Number.isFinite(tracking.consumerStartedAtMs)) return undefined;
  return {
    resumeRequestedAtMs: tracking.resumeRequestedAtMs,
    queuePublishRequestedAtMs: tracking.queuePublishRequestedAtMs,
    ...(tracking.strategy !== undefined ? { strategy: tracking.strategy } : {}),
    consumerStartedAtMs: tracking.consumerStartedAtMs,
    ...(tracking.replayStartedAtMs !== undefined
      ? { replayStartedAtMs: tracking.replayStartedAtMs }
      : {}),
    ...(tracking.nextStepEncounteredAtMs !== undefined
      ? { nextStepEncounteredAtMs: tracking.nextStepEncounteredAtMs }
      : {}),
    ...(tracking.setupSource !== undefined
      ? { setupSource: tracking.setupSource }
      : {}),
  };
}

/** Every boundary the emission gate requires, plus the optional claim end. */
interface ResumeBoundaries {
  /** T0 */ resumeRequestedAtMs: number;
  /** T1 */ queuePublishRequestedAtMs: number;
  /** T2 */ consumerStartedAtMs: number;
  /** T3 */ replayStartedAtMs: number;
  /** T4 */ nextStepEncounteredAtMs: number;
  /** T5 */ stepClaimStartedAtMs: number;
  /** T6: absent on the optimistic-start path; see below. */
  stepClaimCompletedAtMs: number | undefined;
  /** T7 */ stepCodeStartedAtMs: number;
}

/**
 * Validate that every required boundary is a finite epoch-ms value and that
 * the whole sequence is non-decreasing. Returns undefined otherwise, which
 * suppresses the metric entirely rather than reporting a phase that never
 * happened or a negative duration.
 */
function validateBoundaries(
  b: ResumeBoundaries
): readonly number[] | undefined {
  const ordered = [
    b.resumeRequestedAtMs,
    b.queuePublishRequestedAtMs,
    b.consumerStartedAtMs,
    b.replayStartedAtMs,
    b.nextStepEncounteredAtMs,
    b.stepClaimStartedAtMs,
    ...(b.stepClaimCompletedAtMs !== undefined
      ? [b.stepClaimCompletedAtMs]
      : []),
    b.stepCodeStartedAtMs,
  ];
  for (const value of ordered) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  }
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i] < ordered[i - 1]) return undefined;
  }
  return ordered;
}

/**
 * Compute the TTR span attributes for a step that is the first durable step
 * following a hook resume. Returns undefined (emitting nothing at all) when
 * any of these hold:
 *
 * - the invocation carries no resume tracking (not a hook resume, or an older
 *   queue message with no timing);
 * - this is a retry (`attempt !== 1`), which measures a re-execution rather
 *   than the resumption;
 * - a required boundary is missing, non-finite, or out of order.
 *
 * `step_claim_ms` is the one phase that may be individually omitted. Under
 * optimistic inline start the `step_started` claim is deliberately NOT awaited
 * before the body runs, so its completion instant does not exist yet at T7;
 * rather than invent one, the claim phase is dropped and `step_prepare_ms`
 * spans T5→T7. The sum-equals-total property holds either way.
 */
export function computeResumeTtrAttributes(params: {
  tracking: ResumeTtrTracking | undefined;
  /** The attempt number of the execution about to run. */
  attempt: number;
  /** T5: `Date.now()` immediately before the `step_started` request. */
  stepClaimStartedAtMs: number | undefined;
  /** T6: `Date.now()` once the `step_started` response returned. */
  stepClaimCompletedAtMs: number | undefined;
  /** T7: `Date.now()` immediately before `stepFn.apply()`. */
  stepCodeStartedAtMs: number;
}): Record<string, string | number> | undefined {
  const { tracking } = params;
  if (!tracking || params.attempt !== 1) return undefined;
  if (
    tracking.replayStartedAtMs === undefined ||
    tracking.nextStepEncounteredAtMs === undefined ||
    params.stepClaimStartedAtMs === undefined
  ) {
    return undefined;
  }

  const boundaries: ResumeBoundaries = {
    resumeRequestedAtMs: tracking.resumeRequestedAtMs,
    queuePublishRequestedAtMs: tracking.queuePublishRequestedAtMs,
    consumerStartedAtMs: tracking.consumerStartedAtMs,
    replayStartedAtMs: tracking.replayStartedAtMs,
    nextStepEncounteredAtMs: tracking.nextStepEncounteredAtMs,
    stepClaimStartedAtMs: params.stepClaimStartedAtMs,
    stepClaimCompletedAtMs: params.stepClaimCompletedAtMs,
    stepCodeStartedAtMs: params.stepCodeStartedAtMs,
  };
  if (!validateBoundaries(boundaries)) return undefined;

  const {
    resumeRequestedAtMs: t0,
    queuePublishRequestedAtMs: t1,
    consumerStartedAtMs: t2,
    replayStartedAtMs: t3,
    nextStepEncounteredAtMs: t4,
    stepClaimStartedAtMs: t5,
    stepClaimCompletedAtMs: t6,
    stepCodeStartedAtMs: t7,
  } = boundaries;

  return {
    ...Attribute.ResumeTotalMs(t7 - t0),
    ...Attribute.ResumeProducerPrepMs(t1 - t0),
    ...Attribute.ResumeQueueDeliveryMs(t2 - t1),
    ...Attribute.ResumeSetupMs(t3 - t2),
    ...Attribute.ResumeReplayMs(t4 - t3),
    ...Attribute.ResumeStepDispatchMs(t5 - t4),
    ...(t6 !== undefined ? Attribute.ResumeStepClaimMs(t6 - t5) : {}),
    ...Attribute.ResumeStepPrepareMs(t7 - (t6 ?? t5)),
    ...Attribute.ResumeTrigger(tracking.trigger),
    ...(tracking.strategy !== undefined
      ? Attribute.ResumeStrategy(tracking.strategy)
      : {}),
    ...(tracking.setupSource !== undefined
      ? Attribute.ResumeSetupSource(tracking.setupSource)
      : {}),
    ...Attribute.ResumeStepExecution(tracking.stepExecution),
  };
}
