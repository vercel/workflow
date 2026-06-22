import { runtimeLogger } from '../logger.js';

// Maximum number of queue delivery attempts before the handler gives up and
// gracefully fails the run/step. This must be bounded under the VQS message
// max visibility window (24 hours) so that our handler-side failure path
// reliably executes before VQS expires the message.
//
// VQS retry schedule (with retryAfterSeconds: 5):
//   Attempts 1–32:  linear backoff at 5s each  → 32 × 5s = 160s (~2.7 min)
//   Attempts 33+:   exponential backoff: 60s × 2^(attempt-32),
//                   capped at 7,200s (2h), floored at retryAfterSeconds
//
// At 48 attempts the total elapsed time is approximately 20 hours, which is
// safely under the 24-hour message visibility limit.
export const MAX_QUEUE_DELIVERIES = 48;

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

// A replay-consumer mismatch can be caused by a transient divergent replay
// rather than an invalid persisted history. Queue bounded recovery replays
// before recording terminal corruption for a run that cannot replay.
export const REPLAY_DIVERGENCE_MAX_RETRIES = 3;
