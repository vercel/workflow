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

// Maximum time allowed for a single workflow replay execution (in ms).
// If a replay exceeds this duration, the process exits so the queue can retry.
// This must be lower than the function's maxDuration to ensure the
// timeout handler has time to post the run_failed event before the platform
// kills the function.
// Note that on hobby plan, the maxDuration is 60s, so this barrier will not be hit,
// and the queue will re-try until the visibility window expires.
export const REPLAY_TIMEOUT_MS = 240_000;

// Number of queue delivery attempts to allow before permanently failing a run
// due to a replay timeout. On attempts 1 through this value, the timeout
// handler exits without writing run_failed so the queue retries the message.
// On the next attempt the run is marked as failed.
export const REPLAY_TIMEOUT_MAX_RETRIES = 3;

const warnedMaxEventsValues = new Set<string>();

/**
 * Optional client-side override for the server-supplied per-run event ceiling.
 * When set to a positive integer, the runtime clamps the server's limit *down*
 * to this value (never raises it) so enforcement can be exercised without a
 * server-side change. `undefined` (unset) ⇒ use the server value as-is.
 *
 * Reads `process.env.WORKFLOW_MAX_EVENTS_OVERRIDE` lazily so tests and
 * deployments can override per invocation. Invalid values fall back to unset
 * (no throw — the env var is an escape hatch) and emit a one-time warning.
 */
export function getMaxEventsOverride(): number | undefined {
  const raw = process.env.WORKFLOW_MAX_EVENTS_OVERRIDE;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedMaxEventsValues.has(raw)) {
      warnedMaxEventsValues.add(raw);
      runtimeLogger.warn(
        'Ignoring WORKFLOW_MAX_EVENTS_OVERRIDE: not a positive integer; using server limit',
        { raw }
      );
    }
    return undefined;
  }
  return parsed;
}

// A replay-consumer mismatch can be caused by a transient divergent replay
// rather than an invalid persisted history. Queue bounded recovery replays
// before recording terminal corruption for a run that cannot replay.
export const REPLAY_DIVERGENCE_MAX_RETRIES = 3;
