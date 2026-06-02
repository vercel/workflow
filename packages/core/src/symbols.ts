export const WORKFLOW_USE_STEP = Symbol.for('WORKFLOW_USE_STEP');
export const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
export const WORKFLOW_SLEEP = Symbol.for('WORKFLOW_SLEEP');
export const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
export const WORKFLOW_GET_STREAM_ID = Symbol.for('WORKFLOW_GET_STREAM_ID');
export const STABLE_ULID = Symbol.for('WORKFLOW_STABLE_ULID');
export const STREAM_NAME_SYMBOL = Symbol.for('WORKFLOW_STREAM_NAME');
export const STREAM_TYPE_SYMBOL = Symbol.for('WORKFLOW_STREAM_TYPE');
/**
 * Stamped on a real `WritableStream` (the user-visible `serialize.writable`
 * returned from a step-side reviver or step-context `getWritable()`) to
 * record the `runId` of the workflow run that owns the underlying server
 * stream. Used together with `STREAM_NAME_SYMBOL`.
 *
 * When `getExternalReducers.WritableStream` (the dehydration path used by
 * `start()`) sees both symbols on a writable, it includes the `runId` in
 * the descriptor it emits. The child run's step-side reviver then opens
 * a server writable against the original `(runId, name)` and resolves
 * that run's encryption key directly — so the child's writes land on
 * the parent's stream as-is, with no client process in the loop. That
 * keeps the forwarding alive for the full lifetime of the child run,
 * not just for the parent step that initiated `start()`.
 */
export const STREAM_SERVER_RUN_ID_SYMBOL = Symbol.for(
  'WORKFLOW_STREAM_SERVER_RUN_ID'
);
/**
 * Stamped alongside `STREAM_SERVER_RUN_ID_SYMBOL` when the deployment that
 * owns a forwarded writable stream is known. Cross-deployment consumers use
 * it to resolve the owning run's encryption key without loading the run first.
 */
export const STREAM_SERVER_DEPLOYMENT_ID_SYMBOL = Symbol.for(
  'WORKFLOW_STREAM_SERVER_DEPLOYMENT_ID'
);
export const BODY_INIT_SYMBOL = Symbol.for('BODY_INIT');
export const WEBHOOK_RESPONSE_WRITABLE = Symbol.for(
  'WEBHOOK_RESPONSE_WRITABLE'
);

/**
 * Symbol used to store the class registry on globalThis in workflow mode.
 * This allows the deserializer to find classes by classId in the VM context.
 */
export const WORKFLOW_CLASS_REGISTRY = Symbol.for('workflow-class-registry');

export const ABORT_STREAM_NAME = Symbol.for('WORKFLOW_ABORT_STREAM_NAME');
export const ABORT_HOOK_TOKEN = Symbol.for('WORKFLOW_ABORT_HOOK_TOKEN');
export const ABORT_LISTENER_ATTACHED = Symbol.for(
  'WORKFLOW_ABORT_LISTENER_ATTACHED'
);
export const ABORT_READER_CANCEL = Symbol.for('WORKFLOW_ABORT_READER_CANCEL');
