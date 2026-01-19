/**
 * Symbol used to define custom serialization for user-defined class instances.
 * The static method should accept an instance and return serializable data.
 *
 * @example
 * ```ts
 * import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
 *
 * class MyClass {
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
