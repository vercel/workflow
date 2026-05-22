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
