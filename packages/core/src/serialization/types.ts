/**
 * Shared types for the serialization system.
 */

// ---- Format Prefix ----

/**
 * A format prefix is exactly 4 lowercase alphanumeric characters [a-z0-9].
 *
 * This is a branded string type — use `isFormatPrefix()` to validate
 * at runtime. The `SerializationFormat` object provides well-known
 * constants, but codecs may define additional prefixes.
 */
export type FormatPrefix = string & { readonly __brand: 'FormatPrefix' };

/**
 * Runtime type guard for format prefix strings.
 *
 * Validates that a string is exactly 4 characters of [a-z0-9].
 */
export function isFormatPrefix(value: string): value is FormatPrefix {
  return value.length === 4 && /^[a-z0-9]{4}$/.test(value);
}

/**
 * Well-known format prefix constants. Codecs may define additional ones.
 */
export const SerializationFormat = {
  /** devalue stringify/parse with TextEncoder/TextDecoder */
  DEVALUE_V1: 'devl' as FormatPrefix,
  /** Encrypted payload (inner payload has its own format prefix) */
  ENCRYPTED: 'encr' as FormatPrefix,
} as const;

// ---- Serializable Types ----

/**
 * Types that need specialized handling when serialized/deserialized.
 * If a type is added here, it MUST also be added to the `Serializable`
 * type in `schemas.ts`.
 */
export interface SerializableSpecial {
  ArrayBuffer: string; // base64 string
  BigInt: string; // string representation of bigint
  BigInt64Array: string; // base64 string
  BigUint64Array: string; // base64 string
  Date: string; // ISO string
  DOMException: {
    message: string;
    name: string;
    stack?: string;
    cause?: unknown;
  };
  FatalError: { message: string; stack?: string; cause?: unknown };
  Float32Array: string; // base64 string
  Float64Array: string; // base64 string
  Error: { name: string; message: string; stack?: string; cause?: unknown };
  EvalError: { message: string; stack?: string; cause?: unknown };
  Headers: [string, string][];
  Int8Array: string; // base64 string
  Int16Array: string; // base64 string
  Int32Array: string; // base64 string
  Map: [any, any][];
  RangeError: { message: string; stack?: string; cause?: unknown };
  ReadableStream:
    | { name: string; type?: 'bytes'; startIndex?: number }
    | { bodyInit: any };
  ReferenceError: { message: string; stack?: string; cause?: unknown };
  RegExp: { source: string; flags: string };
  /**
   * `retryAfter` is serialized as a numeric epoch timestamp rather than a
   * `Date` to be realm-safe. The Date reducer uses `instanceof global.Date`,
   * which fails for Dates from a different VM realm.
   */
  RetryableError: {
    message: string;
    stack?: string;
    cause?: unknown;
    retryAfter: number;
  };
  Request: {
    method: string;
    url: string;
    headers: Headers;
    body: Request['body'];
    duplex: Request['duplex'];
    responseWritable?: WritableStream<Response>;
  };
  Response: {
    type: Response['type'];
    url: string;
    status: number;
    statusText: string;
    headers: Headers;
    body: Response['body'];
    redirected: boolean;
  };
  Class: {
    classId: string;
  };
  Instance: {
    classId: string;
    data: unknown;
  };
  Set: any[];
  SyntaxError: { message: string; stack?: string; cause?: unknown };
  StepFunction: {
    stepId: string;
    closureVars?: Record<string, any>;
  };
  TypeError: { message: string; stack?: string; cause?: unknown };
  URIError: { message: string; stack?: string; cause?: unknown };
  URL: string;
  WorkflowFunction: {
    workflowId: string;
  };
  URLSearchParams: string;
  Uint8Array: string; // base64 string
  Uint8ClampedArray: string; // base64 string
  Uint16Array: string; // base64 string
  Uint32Array: string; // base64 string
  AggregateError: {
    message: string;
    stack?: string;
    cause?: unknown;
    errors: unknown[];
  };
  WritableStream: { name: string };
}

export type Reducers = {
  [K in keyof SerializableSpecial]: (
    value: any
  ) => SerializableSpecial[K] | false;
};

export type Revivers = {
  [K in keyof SerializableSpecial]: (value: SerializableSpecial[K]) => any;
};
