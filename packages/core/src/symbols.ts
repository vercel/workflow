export const WORKFLOW_USE_STEP = Symbol.for('WORKFLOW_USE_STEP');
export const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
export const WORKFLOW_SLEEP = Symbol.for('WORKFLOW_SLEEP');
export const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');
export const WORKFLOW_GET_STREAM_ID = Symbol.for('WORKFLOW_GET_STREAM_ID');
export const STABLE_ULID = Symbol.for('WORKFLOW_STABLE_ULID');
export const STREAM_NAME_SYMBOL = Symbol.for('WORKFLOW_STREAM_NAME');
export const STREAM_TYPE_SYMBOL = Symbol.for('WORKFLOW_STREAM_TYPE');
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
