import { envNumber } from '@workflow/world';
import { runtimeLogger } from '../logger.js';

// Maximum number of queue delivery attempts before the handler gives up and
// gracefully fails the run/step. This must be bounded under the VQS message
// max visibility window (24 hours) so that our handler-side failure path
// reliably executes before VQS expires the message.
//
// The effective wall-clock survival depends on the per-redelivery backoff: the
// `retry-after` the handler returns (see world-vercel
// `getHandlerErrorRetryAfterSeconds`) fed through VQS `calculateBackoffDelay`.
// VQS uses our value for the first 32 attempts (clamped to [5s, 900s]) then
// applies its own exponential growth — every hop hard-capped at the SQS limit
// of 900s. With the backoff ramping toward that 900s ceiling (reached by
// ~delivery 11), 48 attempts span roughly 9–10 hours of wall-clock (~35,000s),
// comfortably under the 24-hour message-visibility limit so the failure path
// runs before the message expires. (A flatter, low-capped backoff exhausts the
// budget in only a few hours, failing otherwise-healthy runs during a transient
// backend outage; conversely, spanning the full 24h window would require a
// substantially higher cap here, not a higher per-hop ceiling — VQS clamps
// every hop at 900s.)
export const MAX_QUEUE_DELIVERIES = 48;

/**
 * Effective max queue deliveries. Override via `WORKFLOW_MAX_QUEUE_DELIVERIES`.
 */
export function getMaxQueueDeliveries(): number {
  // Only ever lower the delivery budget. The default is calibrated so the
  // handler-side failure path runs before VQS message-retention expiry (see
  // MAX_QUEUE_DELIVERIES above); a higher value would bypass that invariant and
  // let a bad deployment redeliver until queue expiry instead of recording
  // run_fail. `max` clamps a too-high override back down to the safe default.
  return envNumber('WORKFLOW_MAX_QUEUE_DELIVERIES', MAX_QUEUE_DELIVERIES, {
    integer: true,
    min: 1,
    max: MAX_QUEUE_DELIVERIES,
  });
}

/**
 * Default maximum time allowed for the *replay* portion of a single workflow
 * handler invocation (in ms). This budget only covers deterministic-replay
 * and workflow-VM execution between step boundaries — inline step bodies
 * (`"use step"` functions invoked via `executeStep`) do NOT count against
 * it. Step bodies are bounded separately by the platform's function
 * `maxDuration` (e.g. 800s on Vercel Pro Fluid) and `NO_INLINE_REPLAY_AFTER_MS`.
 *
 * If the non-step ("replay") time within a single invocation exceeds this
 * budget, the handler exits so the queue can retry. After
 * `REPLAY_TIMEOUT_MAX_RETRIES` exhausted attempts the run is failed with
 * `RUN_ERROR_CODES.REPLAY_TIMEOUT`.
 *
 * Note that on Vercel Hobby (standard functions), the platform `maxDuration`
 * is 60s — well below this budget, so the platform SIGTERM will fire first
 * and the queue will re-deliver until the visibility window expires. With
 * Fluid Compute on Hobby the per-function ceiling rises to 300s, still
 * under the default budget.
 *
 * Override via the `WORKFLOW_REPLAY_TIMEOUT_MS` env var (clamped to
 * `MIN_REPLAY_TIMEOUT_MS`..`MAX_REPLAY_TIMEOUT_MS`).
 */
export const REPLAY_TIMEOUT_MS = 240_000;

/** Lower bound for the replay-timeout env var override. */
export const MIN_REPLAY_TIMEOUT_MS = 30_000;

/**
 * Upper bound for the replay-timeout env var override. 780s leaves ≥20s of
 * headroom under Vercel Pro Fluid's 800s function ceiling so the handler
 * can write `run_failed` before SIGTERM.
 */
export const MAX_REPLAY_TIMEOUT_MS = 780_000;

// Track which raw env var values we've already warned about so the warning
// log only fires once per process (the function may be called many times).
const warnedReplayTimeoutValues = new Set<string>();

function warnOnce(
  raw: string,
  message: string,
  data: Record<string, unknown>
): void {
  if (warnedReplayTimeoutValues.has(raw)) return;
  warnedReplayTimeoutValues.add(raw);
  runtimeLogger.warn(message, data);
}

/**
 * Resolve the effective replay-timeout budget for the current process.
 *
 * Reads `process.env.WORKFLOW_REPLAY_TIMEOUT_MS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values
 * fall back to a safe value (no throw — the env var is an escape hatch,
 * not a hard requirement) and emit a one-time warning so misconfiguration
 * is observable.
 */
export function getReplayTimeoutMs(): number {
  const raw = process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
  if (!raw) return REPLAY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnOnce(
      raw,
      'Ignoring WORKFLOW_REPLAY_TIMEOUT_MS: not a positive finite number; using default',
      { raw, defaultMs: REPLAY_TIMEOUT_MS }
    );
    return REPLAY_TIMEOUT_MS;
  }
  if (parsed < MIN_REPLAY_TIMEOUT_MS) {
    warnOnce(raw, 'WORKFLOW_REPLAY_TIMEOUT_MS below minimum; clamped', {
      raw,
      clampedMs: MIN_REPLAY_TIMEOUT_MS,
      minMs: MIN_REPLAY_TIMEOUT_MS,
    });
    return MIN_REPLAY_TIMEOUT_MS;
  }
  if (parsed > MAX_REPLAY_TIMEOUT_MS) {
    warnOnce(raw, 'WORKFLOW_REPLAY_TIMEOUT_MS above maximum; clamped', {
      raw,
      clampedMs: MAX_REPLAY_TIMEOUT_MS,
      maxMs: MAX_REPLAY_TIMEOUT_MS,
    });
    return MAX_REPLAY_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Reset the warn-once cache. Test-only — exported so unit tests can
 * exercise the warn path repeatedly without sharing state.
 *
 * @internal
 */
export function _resetReplayTimeoutWarnCacheForTests(): void {
  warnedReplayTimeoutValues.clear();
}

// Number of queue delivery attempts to allow before permanently failing a run
// due to a replay timeout. On attempts 1 through this value, the timeout
// handler exits without writing run_failed so the queue retries the message.
// On the next attempt the run is marked as failed.
export const REPLAY_TIMEOUT_MAX_RETRIES = 3;

/**
 * Effective replay-timeout retry budget. Override via
 * `WORKFLOW_REPLAY_TIMEOUT_MAX_RETRIES`.
 */
export function getReplayTimeoutMaxRetries(): number {
  return envNumber(
    'WORKFLOW_REPLAY_TIMEOUT_MAX_RETRIES',
    REPLAY_TIMEOUT_MAX_RETRIES,
    { integer: true }
  );
}

/**
 * Default maximum number of steps the owned-inline path runs inline (in
 * parallel) per suspension. The rest are queued to background handlers. Each
 * inline step is created lazily — its `step_created` is folded into the
 * `step_started` that `executeStep` sends — so inlining N steps saves N queue
 * round-trips for a `Promise.all`-style fan-out. `1` reproduces the
 * single-inline-step behavior exactly (useful kill-switch).
 *
 * Override via `WORKFLOW_MAX_INLINE_STEPS` (clamped to
 * `MIN_MAX_INLINE_STEPS`..`MAX_MAX_INLINE_STEPS`).
 */
export const MAX_INLINE_STEPS = 3;

/** Lower bound for the inline-steps env override (1 = single inline step). */
export const MIN_MAX_INLINE_STEPS = 1;

/**
 * Upper bound for the inline-steps env override. Inline bodies run in parallel
 * within one function invocation, so this caps memory/CPU fan-out per handler.
 */
export const MAX_MAX_INLINE_STEPS = 16;

// Warn-once cache for WORKFLOW_MAX_INLINE_STEPS, keyed by raw env value.
const warnedMaxInlineStepsValues = new Set<string>();

/**
 * Resolve the effective max number of inline steps for the current process.
 *
 * Reads `process.env.WORKFLOW_MAX_INLINE_STEPS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values fall
 * back to a safe value (no throw — the env var is an escape hatch) and emit a
 * one-time warning so misconfiguration is observable.
 */
export function getMaxInlineSteps(): number {
  const raw = process.env.WORKFLOW_MAX_INLINE_STEPS;
  if (!raw) return MAX_INLINE_STEPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedMaxInlineStepsValues.has(raw)) {
      warnedMaxInlineStepsValues.add(raw);
      runtimeLogger.warn(
        'Ignoring WORKFLOW_MAX_INLINE_STEPS: not a positive integer; using default',
        { raw, defaultValue: MAX_INLINE_STEPS }
      );
    }
    return MAX_INLINE_STEPS;
  }
  if (parsed < MIN_MAX_INLINE_STEPS) return MIN_MAX_INLINE_STEPS;
  if (parsed > MAX_MAX_INLINE_STEPS) {
    if (!warnedMaxInlineStepsValues.has(raw)) {
      warnedMaxInlineStepsValues.add(raw);
      runtimeLogger.warn('WORKFLOW_MAX_INLINE_STEPS above maximum; clamped', {
        raw,
        clampedValue: MAX_MAX_INLINE_STEPS,
        maxValue: MAX_MAX_INLINE_STEPS,
      });
    }
    return MAX_MAX_INLINE_STEPS;
  }
  return parsed;
}

/**
 * Whether optimistic inline step start is enabled. When on, the owned-inline
 * path begins running a brand-new step's body *before* its lazy `step_started`
 * network call resolves (the input is already known locally), awaiting the
 * `step_started` only before the terminal write.
 *
 * This can run a step body more than once when handlers race for the same
 * step's create-claim — both run the body before one wins. That is unsafe for
 * steps with non-idempotent side effects; in particular, two concurrent runs
 * of a step that writes to the workflow stream (e.g. an AI agent streaming
 * tokens) can interleave and corrupt the stream data. So the optimization is
 * **off by default** and must be explicitly opted into per deployment.
 *
 * Reads `process.env.WORKFLOW_OPTIMISTIC_INLINE_START` lazily. Default OFF;
 * enabled only by an explicit `'1'` / `'true'`.
 */
export function isOptimisticInlineStartEnabled(): boolean {
  const raw = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Whether an operator has **explicitly disabled** optimistic inline start via
 * `WORKFLOW_OPTIMISTIC_INLINE_START=0` / `=false`. Distinct from "unset": unset
 * leaves the optimization off by default but lets turbo force it on; an explicit
 * `0`/`false` is an operator opt-out that turbo must honor (turbo's forced
 * optimistic start still runs a step body before `step_started`/`run_started` is
 * confirmed, the property such an operator is opting out of), so
 * `forceOptimisticStart` defers to this. Reads the env var lazily.
 */
export function isOptimisticInlineStartExplicitlyDisabled(): boolean {
  const raw = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
  if (raw === undefined || raw === '') return false;
  return raw === '0' || raw.toLowerCase() === 'false';
}

/**
 * Whether "turbo mode" is enabled. Turbo mode fast-paths the *first delivery of
 * the first invocation* of a run (detected by the entrypoint via `runInput`
 * presence + `metadata.attempt === 1`): it backgrounds the `run_started` event
 * creation, skips the initial event-log load (nothing has been written yet),
 * and forces optimistic inline step start for that invocation — independent of
 * `WORKFLOW_OPTIMISTIC_INLINE_START`.
 *
 * Forcing optimistic start is safe here because the first delivery has no
 * concurrent peer handler to race the step create-claim, so a step body runs
 * exactly once. That single-handler guarantee ends as soon as the run creates a
 * hook or wait (which introduce resume/parallel invocations), so the runtime
 * exits turbo at that point.
 *
 * Reads `process.env.WORKFLOW_TURBO` lazily. Default **ON**; disabled only by an
 * explicit `'0'` / `'false'` (case-insensitive).
 */
export function isTurboEnabled(): boolean {
  const raw = process.env.WORKFLOW_TURBO;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Whether inline step ownership is enabled (default ON). When on, the lazy
 * `step_started` that creates an inline step records the owning queue
 * message ID, and wake replays that observe an actively-owned step enqueue a
 * *delayed backstop* message instead of immediately requeueing it — fixing
 * duplicate inline step execution when a hook/wait wakes a run mid-step
 * (vercel/workflow#2780).
 *
 * `WORKFLOW_INLINE_OWNERSHIP=0` (or `false`) is the kill switch: dispatch
 * reverts to the unconditional immediate requeue. Stamping is unaffected —
 * the recorded ownerMessageId is inert data when the switch is off.
 */
export function isInlineOwnershipEnabled(): boolean {
  const raw = process.env.WORKFLOW_INLINE_OWNERSHIP;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Default inline-ownership lease, in seconds: how long after a step's latest
 * (stamped) `step_started` a non-owner invocation assumes the owning
 * invocation may still be alive. Within the lease, wake replays enqueue the
 * step's backstop message with `delaySeconds = lease remaining` instead of
 * immediately; past it, they enqueue immediately (today's behavior).
 *
 * Why a fixed 860 and not a value derived from the function's `maxDuration`:
 * neither runtime nor build time can see the resolved value — builders emit
 * `maxDuration: 'max'`, which the platform resolves per-plan at deploy, and
 * no env var or request-context deadline API exposes the result. The bound
 * comes from a platform rule instead: durations above 800s require explicit
 * per-function numeric config, so a builder-emitted `'max'` resolves to at
 * most 800s — 860s therefore dominates any workflow route's invocation
 * lifetime plus scheduling slack. Revisit when that ceiling moves (the
 * 30-minute duration beta becoming reachable via `'max'` would invalidate
 * the bound). Worlds without an invocation kill bound (world-local,
 * self-hosted) get no death proof from any constant — there the in-process
 * single-flight layer (step-single-flight.ts) is what makes a backstop
 * firing mid-step harmless.
 *
 * 860 also stays under the queue's 900s maximum delay (SQS cap), so a
 * backstop's full lease remainder always fits in a single delayed message.
 *
 * Override via `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` (clamped to
 * 1..`MAX_INLINE_OWNERSHIP_LEASE_SECONDS`).
 */
export const INLINE_OWNERSHIP_LEASE_SECONDS = 860;

/**
 * Upper bound for the lease env override. 900s is the queue's maximum
 * per-message delay (SQS cap) — a longer lease would need delay chaining
 * like long waits use; clamp instead so one delayed message always suffices.
 */
export const MAX_INLINE_OWNERSHIP_LEASE_SECONDS = 900;

/**
 * Effective inline-ownership lease. Override via
 * `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS` — e.g. raise it on self-hosted
 * multi-instance worlds with long-running steps to widen the window in which
 * a live owner is protected from a concurrent backstop execution.
 */
export function getInlineOwnershipLeaseSeconds(): number {
  return envNumber(
    'WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS',
    INLINE_OWNERSHIP_LEASE_SECONDS,
    { integer: true, min: 1, max: MAX_INLINE_OWNERSHIP_LEASE_SECONDS }
  );
}

// A replay-consumer mismatch can be caused by a transient divergent replay
// rather than an invalid persisted history. Queue bounded recovery replays
// before recording terminal corruption for a run that cannot replay.
export const REPLAY_DIVERGENCE_MAX_RETRIES = 3;

/**
 * Effective replay-divergence recovery budget. Override via
 * `WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES`.
 */
export function getReplayDivergenceMaxRetries(): number {
  return envNumber(
    'WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES',
    REPLAY_DIVERGENCE_MAX_RETRIES,
    { integer: true }
  );
}
