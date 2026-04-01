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

// Maximum time allowed for a single workflow replay execution (in ms).
// If a replay exceeds this duration, the run is failed and the process exits.
// This must be lower than the function's maxDuration to ensure the
// timeout handler has time to post the run_failed event before the platform
// kills the function.
// Note that on hobby plan, the maxDuration is 60s, so this barrier will not be hit,
// and the queue will re-try until the visibility window expires.
export const REPLAY_TIMEOUT_MS = 240_000;
