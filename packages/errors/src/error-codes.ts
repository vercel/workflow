/**
 * Error codes for classifying run failures.
 * These are populated in the `errorCode` field of `run_failed` events
 * and flow through to `StructuredError.code` on the run entity.
 */
export const RUN_ERROR_CODES = {
  /** Error thrown in user workflow or step code */
  USER_ERROR: 'USER_ERROR',
  /** Internal runtime error (corrupted event log, missing timestamps) */
  RUNTIME_ERROR: 'RUNTIME_ERROR',
} as const;

export type RunErrorCode =
  (typeof RUN_ERROR_CODES)[keyof typeof RUN_ERROR_CODES];
