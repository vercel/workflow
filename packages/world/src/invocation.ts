/** An executor error encoded for transport. Fields can contain Uint8Array and Date values. */
export interface SerializedWorkflowError {
  name: string;
  message: string;
  stack?: string;
  fields: Record<string, unknown>;
  cause?: SerializedWorkflowError;
  /** Preserves a cause value that is not an Error instance. */
  causeValue?: unknown;
}

/** A transported handler result. invoke() returns the value or throws the restored error. */
export type InvocationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedWorkflowError };
