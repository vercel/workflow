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
 * Symbol used to define custom serialization for user-defined class instances.
 * The static method should accept an instance and return serializable data.
 *
 * @example
 * ```ts
 * import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@vercel/workflow';
 *
 * class MyClass {
 *   static classId = 'myapp/MyClass';
 *
 *   constructor(public value: string) {}
 *
 *   static [WORKFLOW_SERIALIZE](instance: MyClass) {
 *     return { value: instance.value };
 *   }
 *
 *   static [WORKFLOW_DESERIALIZE](data: { value: string }) {
 *     return new MyClass(data.value);
 *   }
 * }
 * ```
 */
export const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');

/**
 * Symbol used to define custom deserialization for user-defined class instances.
 * The static method should accept serialized data and return a class instance.
 *
 * @see WORKFLOW_SERIALIZE for usage example
 */
export const WORKFLOW_DESERIALIZE = Symbol.for('workflow-deserialize');
