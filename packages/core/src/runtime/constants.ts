import { globalSingleton } from '@workflow/utils';
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
// applies its own exponential growth, every hop hard-capped at the SQS limit
// of 900s. With the backoff ramping toward that 900s ceiling (reached by
// ~delivery 11), 48 attempts span roughly 9–10 hours of wall-clock (~35,000s),
// comfortably under the 24-hour message-visibility limit so the failure path
// runs before the message expires. (A flatter, low-capped backoff exhausts the
// budget in only a few hours, failing otherwise-healthy runs during a transient
// backend outage; conversely, spanning the full 24h window would require a
// substantially higher cap here, not a higher per-hop ceiling, since VQS
// clamps every hop at 900s.)
//
// world-postgres sizes its Graphile job attempt cap from this value
// (`CORE_MAX_DELIVERIES_EXCEEDED_ATTEMPT` = this + 1, plus headroom for
// post-ceiling redeliveries of the terminal write). Update it there too if
// this changes.
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
 * and workflow-VM execution between step boundaries. Inline step bodies
 * (`"use step"` functions invoked via `executeStep`) do NOT count against
 * it. Step bodies are bounded separately by the platform's function
 * `maxDuration` (e.g. 800s on Vercel Pro Fluid) and `NO_INLINE_REPLAY_AFTER_MS`.
 *
 * If the non-step ("replay") time within a single invocation exceeds this
 * budget, the handler rejects so the queue can retry. After
 * `REPLAY_TIMEOUT_MAX_RETRIES` exhausted attempts the run is failed with
 * `RUN_ERROR_CODES.REPLAY_TIMEOUT`.
 *
 * Note that on Vercel Hobby (standard functions), the platform `maxDuration`
 * is 60s, well below this budget, so the platform SIGTERM will fire first
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
//
// On `globalThis` rather than at module scope so "once per process" survives
// bundling: this package is compiled into the host application's server build
// once per bundler layer, and per-copy sets warn once per layer instead.
const warned = globalSingleton('@workflow/core//envWarnings', 1, () => ({
  replayTimeoutValues: new Set<string>(),
  maxInlineStepsValues: new Set<string>(),
  maxEventsValues: new Set<string>(),
}));

function warnOnce(
  raw: string,
  message: string,
  data: Record<string, unknown>
): void {
  if (warned.replayTimeoutValues.has(raw)) return;
  warned.replayTimeoutValues.add(raw);
  runtimeLogger.warn(message, data);
}

/**
 * Resolve the effective replay-timeout budget for the current process.
 *
 * Reads `process.env.WORKFLOW_REPLAY_TIMEOUT_MS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values
 * fall back to a safe value (no throw: the env var is an escape hatch,
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
 * Reset the warn-once cache. Test-only: exported so unit tests can
 * exercise the warn path repeatedly without sharing state.
 *
 * @internal
 */
export function _resetReplayTimeoutWarnCacheForTests(): void {
  warned.replayTimeoutValues.clear();
}

// Number of queue delivery attempts to allow before permanently failing a run
// due to a replay timeout. On attempts 1 through this value, the timeout
// handler rejects without writing run_failed so the queue retries the message.
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
 * inline step is created lazily (its `step_created` is folded into the
 * `step_started` that `executeStep` sends), so inlining N steps saves N queue
 * round-trips for a `Promise.all`-style fan-out. `1` reproduces the
 * single-inline-step behavior exactly (useful kill-switch).
 *
 * Override via `WORKFLOW_MAX_INLINE_STEPS` (clamped to
 * `MIN_MAX_INLINE_STEPS`..`MAX_MAX_INLINE_STEPS`).
 */
export const MAX_INLINE_STEPS = 3;

/** Lower bound for the inline-steps env override (0 = every step is enqueued). */
export const MIN_MAX_INLINE_STEPS = 0;

/**
 * Upper bound for the inline-steps env override. Inline bodies run in parallel
 * within one function invocation, so this caps memory/CPU fan-out per handler.
 */
export const MAX_MAX_INLINE_STEPS = 16;

/**
 * Resolve the effective max number of inline steps for the current process.
 *
 * Reads `process.env.WORKFLOW_MAX_INLINE_STEPS` lazily so tests and
 * deployments can override per invocation. Invalid / out-of-range values fall
 * back to a safe value (no throw: the env var is an escape hatch) and emit a
 * one-time warning so misconfiguration is observable.
 */
export function getMaxInlineSteps(): number {
  const raw = process.env.WORKFLOW_MAX_INLINE_STEPS;
  if (!raw) return MAX_INLINE_STEPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (!warned.maxInlineStepsValues.has(raw)) {
      warned.maxInlineStepsValues.add(raw);
      runtimeLogger.warn(
        'Ignoring WORKFLOW_MAX_INLINE_STEPS: not a nonnegative integer; using default',
        { raw, defaultValue: MAX_INLINE_STEPS }
      );
    }
    return MAX_INLINE_STEPS;
  }
  if (parsed < MIN_MAX_INLINE_STEPS) return MIN_MAX_INLINE_STEPS;
  if (parsed > MAX_MAX_INLINE_STEPS) {
    if (!warned.maxInlineStepsValues.has(raw)) {
      warned.maxInlineStepsValues.add(raw);
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
 * Optional client-side override for the server-supplied per-run event ceiling.
 * When set to a positive integer, the runtime clamps the server's limit *down*
 * to this value (never raises it) so enforcement can be exercised without a
 * server-side change. `undefined` (unset) ⇒ use the server value as-is.
 *
 * Reads `process.env.WORKFLOW_MAX_EVENTS_OVERRIDE` lazily so tests and
 * deployments can override per invocation. Invalid values fall back to unset
 * (no throw: the env var is an escape hatch) and emit a one-time warning.
 */
export function getMaxEventsOverride(): number | undefined {
  const raw = process.env.WORKFLOW_MAX_EVENTS_OVERRIDE;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warned.maxEventsValues.has(raw)) {
      warned.maxEventsValues.add(raw);
      runtimeLogger.warn(
        'Ignoring WORKFLOW_MAX_EVENTS_OVERRIDE: not a positive integer; using server limit',
        { raw }
      );
    }
    return undefined;
  }
  return parsed;
}

/**
 * Whether the QuickJS engine's baseline-snapshot startup optimization is
 * enabled (default ON). When on, the engine hydrates a VM with the
 * workflow bundle once per function instance, snapshots it, and starts
 * every invocation by restoring the snapshot instead of re-evaluating
 * the bundle, skipping the dominant share of VM startup (measured
 * ~77ms → ~3ms to first suspension for a 1.3MB bundle). Bundles whose
 * module scope consumes randomness, reads the clock, or replaces a
 * serialization intrinsic are detected at hydrate time and
 * automatically fall back to per-invocation fresh evaluation (see
 * prepareBaselineSnapshot). Set WORKFLOW_QUICKJS_BASELINE_SNAPSHOT=0 to
 * disable.
 */
export function isQuickJSBaselineSnapshotEnabled(): boolean {
  const raw = process.env.WORKFLOW_QUICKJS_BASELINE_SNAPSHOT;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/**
 * Whether the Node.js inline loop retains a suspended workflow VM within one
 * invocation (default ON). When on, a step- or attribute-driven suspension can
 * keep the live VM, event consumer, and hydrated state even with open hooks or
 * waits. The next loop iteration appends newly durable events instead of
 * rebuilding the `vm.Context` and replaying the whole event log. Hook- or
 * wait-only suspensions park the invocation, while replay divergence falls back
 * to the ordinary durable replay path. QuickJS manages its own retained loop.
 *
 * `WORKFLOW_RETAINED_VM=0` (or `false`) is the kill switch: every iteration
 * replays the Node.js engine from scratch in a fresh VM, matching the
 * pre-retention behavior.
 */
export function isVmRetentionEnabled(): boolean {
  const raw = process.env.WORKFLOW_RETAINED_VM;
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw.toLowerCase() === 'false');
}

/** Environment variable that opts a deployment into dynamic workflows. */
export const DYNAMIC_WORKFLOWS_ENV = 'WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS';

/**
 * Whether this deployment executes dynamic workflows (default OFF).
 *
 * Dynamic source runs with the full privileges of the deployment's functions,
 * so a deployment must opt in before it starts a dynamic run, advertises
 * dynamic support in its health check, or executes stored dynamic code on a
 * delivery. Only `1` or `true` (case-insensitive) enables it; any other value
 * leaves it off.
 *
 * Reads `process.env.WORKFLOW_EXPERIMENTAL_DYNAMIC_WORKFLOWS` on every call so
 * the deployment's runtime environment decides, not the build.
 */
export function isDynamicWorkflowsEnabled(): boolean {
  const raw = process.env[DYNAMIC_WORKFLOWS_ENV];
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
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
// A delivery reaching a deployment the run is not pinned to is not treated as
// permanent. Re-route the message at the run's own deployment a bounded number
// of times before failing the run with DEPLOYMENT_MISMATCH.
export const DEPLOYMENT_MISMATCH_MAX_RETRIES = 3;

/**
 * Effective deployment-mismatch re-route budget. Override via
 * `WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES`; `0` fails the run on the first
 * misrouted delivery instead of attempting recovery.
 */
export function getDeploymentMismatchMaxRetries(): number {
  return envNumber(
    'WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES',
    DEPLOYMENT_MISMATCH_MAX_RETRIES,
    { integer: true, min: 0 }
  );
}
