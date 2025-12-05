/**
 * A serializable value:
 * Any valid JSON object is serializable
 *
 * @example
 *
 * ```ts
 * // any valid JSON object is serializable
 * const anyJson: Serializable = { foo: "bar" };
 * ```
 */
export type Serializable =
  // Standard JSON types
  | string
  | number
  | boolean
  | null
  | undefined
  | Serializable[]
  | { [key: string]: Serializable }
  // Special types that need special handling when
  // serialized/deserialized (see `serialization.ts`)
  | ArrayBuffer
  | bigint
  | BigInt64Array
  | BigUint64Array
  | Date
  | Float32Array
  | Float64Array
  | Headers
  | Int8Array
  | Int16Array
  | Int32Array
  | Map<Serializable, Serializable>
  | ReadableStream<Uint8Array>
  | RegExp
  | Response
  | Set<Serializable>
  | URL
  | URLSearchParams
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | WritableStream<Uint8Array>
  | ((...args: Serializable[]) => Promise<Serializable>); // Step function
