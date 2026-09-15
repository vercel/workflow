/** Wire representation of an executor error. Fields may contain binary data/dates. */
export interface SerializedWorkflowError {
  name: string;
  message: string;
  stack?: string;
  fields: Record<string, unknown>;
  cause?: SerializedWorkflowError;
  /** Non-Error causes retain their diagnostic value instead of becoming Error. */
  causeValue?: unknown;
}

/** World transports this envelope; invoke() returns value or throws the error. */
export type InvocationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedWorkflowError };
