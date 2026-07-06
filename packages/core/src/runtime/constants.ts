import { envNumber } from '@workflow/world';

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
