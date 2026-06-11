/**
 * Error codes for classifying run failures.
 * These are populated in the `errorCode` field of `run_failed` events
 * and flow through to `StructuredError.code` on the run entity.
 */
export const RUN_ERROR_CODES = {
  /** Error thrown in user workflow or step code */
  USER_ERROR: 'USER_ERROR',
  /** Internal runtime error (missing timestamps, runtime invariant failures) */
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  /** Event log contains orphaned or mismatched events and cannot be replayed */
  CORRUPTED_EVENT_LOG: 'CORRUPTED_EVENT_LOG',
  /** One replay could not consume the event log deterministically; retryable */
  REPLAY_DIVERGENCE: 'REPLAY_DIVERGENCE',
  /** Run exceeded the maximum number of queue deliveries */
  MAX_DELIVERIES_EXCEEDED: 'MAX_DELIVERIES_EXCEEDED',
  /** Workflow replay exceeded the maximum allowed duration */
  REPLAY_TIMEOUT: 'REPLAY_TIMEOUT',
  /** World response violated the SDK contract and cannot be retried safely */
  WORLD_CONTRACT_ERROR: 'WORLD_CONTRACT_ERROR',
} as const;

export type RunErrorCode =
  (typeof RUN_ERROR_CODES)[keyof typeof RUN_ERROR_CODES];
