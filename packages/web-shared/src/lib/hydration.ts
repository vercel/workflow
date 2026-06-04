/**
 * Web-specific hydration for o11y display.
 *
 * Browser-safe revivers that use `atob()` for base64 decoding (no Node.js
 * `Buffer` dependency). Produces `ClassInstanceRef` objects and `StreamRef`
 * objects for UI rendering.
 */

import {
  extractClassName,
  hydrateResourceIO as hydrateResourceIOGeneric,
  isEncryptedData,
  isExpiredStub,
  isRunRef,
  observabilityRevivers,
  type Revivers,
  serializedInstanceToRef,
} from '@workflow/core/serialization-format';
import { EVENT_DATA_REF_FIELDS } from '@workflow/world';

// Re-export types and utilities that consumers need
export {
  CLASS_INSTANCE_REF_TYPE,
  ClassInstanceRef,
  ENCRYPTED_PLACEHOLDER,
  extractStreamIds,
  isClassInstanceRef,
  isEncryptedData,
  isRunRef,
  isStreamId,
  isStreamRef,
  type Revivers,
  RUN_REF_TYPE,
  type RunRef,
  STREAM_REF_TYPE,
  type StreamRef,
  serializedInstanceToRef,
  truncateId,
} from '@workflow/core/serialization-format';

// ---------------------------------------------------------------------------
// Browser-safe base64 decode
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (base64 === '' || base64 === '.') {
    return new ArrayBuffer(0);
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// ---------------------------------------------------------------------------
// Web revivers (browser-safe, no Buffer dependency)
// ---------------------------------------------------------------------------

/**
 * Build a reviver for one of the built-in `Error` subclasses (e.g.
 * `TypeError`, `RangeError`). The constructor for the named subclass is
 * resolved off `globalThis` at call time so the produced instance has the
 * correct prototype chain in the consumer realm. Falls back to a generic
 * `Error` (with `name` set) if the global isn't available, which keeps the
 * o11y UI rendering even on exotic browsers.
 *
 * `cause` is passed through `ErrorOptions` to the constructor when present,
 * matching `getCommonRevivers` in `@workflow/core` so the resulting `cause`
 * property has the same semantics (non-enumerable, set by the engine) as a
 * freshly thrown Error in the consumer realm. The `'cause' in value` check
 * preserves the distinction between "no cause" and "cause is undefined".
 */
function makeWebErrorSubclassReviver(
  name:
    | 'EvalError'
    | 'RangeError'
    | 'ReferenceError'
    | 'SyntaxError'
    | 'TypeError'
    | 'URIError'
) {
  return (value: { message: string; stack?: string; cause?: unknown }) => {
    const opts = 'cause' in value ? { cause: value.cause } : undefined;
    const Ctor = (globalThis as Record<string, any>)[name] as
      | ErrorConstructor
      | undefined;
    let error: Error;
    if (typeof Ctor === 'function') {
      error = new Ctor(value.message, opts);
    } else {
      // Fallback path: no built-in subclass available (exotic env). Construct
      // a plain Error with the right `name` and copy `cause` manually since
      // the base Error constructor is what we actually called.
      error = Object.assign(new Error(value.message, opts), { name });
    }
    if (value.stack !== undefined) error.stack = value.stack;
    return error;
  };
}

/**
 * Get the web-specific revivers for hydrating serialized data.
 *
 * Uses `atob()` for base64 decoding (no Node.js Buffer dependency).
 * All types are revived as real instances (Date, Map, Set, URL,
 * URLSearchParams, Headers, Error, etc.).
 *
 * NOTE: this set must mirror the keys in `SerializableSpecial` (see
 * `@workflow/core/serialization/types`). Any reducer key added on the
 * serialization side that isn't covered here will cause `devalue.unflatten`
 * to throw `Unknown type X`, which `hydrateResourceIO` swallows and
 * surfaces as a "Failed to load resource details" banner in the o11y UI.
 */
export function getWebRevivers(): Revivers {
  function reviveArrayBuffer(value: string): ArrayBuffer {
    return base64ToArrayBuffer(value);
  }

  return {
    // O11y-specific revivers (streams, step functions → display objects).
    // Spread FIRST so web-specific overrides below take precedence.
    ...observabilityRevivers,

    // Binary types
    ArrayBuffer: reviveArrayBuffer,
    BigInt: (value: string) => BigInt(value),
    BigInt64Array: (value: string) =>
      new BigInt64Array(reviveArrayBuffer(value)),
    BigUint64Array: (value: string) =>
      new BigUint64Array(reviveArrayBuffer(value)),
    Date: (value) => new Date(value),

    // Error family. The reducer side (see
    // `packages/core/src/serialization/reducers/common.ts`) emits a tagged
    // entry for each built-in Error subclass plus the workflow-specific
    // `FatalError` / `RetryableError` / `HookConflictError` and
    // `AggregateError`. Without
    // matching revivers here, `devalue.unflatten` throws "Unknown type X"
    // — which surfaces in the web o11y UI as "Failed to load resource
    // details: Unknown type FatalError".
    Error: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new Error(value.message, opts);
      error.name = value.name;
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    EvalError: makeWebErrorSubclassReviver('EvalError'),
    RangeError: makeWebErrorSubclassReviver('RangeError'),
    ReferenceError: makeWebErrorSubclassReviver('ReferenceError'),
    SyntaxError: makeWebErrorSubclassReviver('SyntaxError'),
    TypeError: makeWebErrorSubclassReviver('TypeError'),
    URIError: makeWebErrorSubclassReviver('URIError'),
    AggregateError: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const Ctor = (
        globalThis as { AggregateError?: AggregateErrorConstructor }
      ).AggregateError;
      const error =
        typeof Ctor === 'function'
          ? new Ctor(value.errors, value.message, opts)
          : Object.assign(new Error(value.message, opts), {
              name: 'AggregateError',
              errors: value.errors,
            });
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    // `FatalError` and `RetryableError` are not built-in browser globals,
    // so we can't resolve a constructor from globalThis. The web o11y UI
    // doesn't need `instanceof FatalError` to pass (no user code runs
    // here) — it just needs `name`, `message`, `stack`, and any extra
    // enumerable fields to render. Construct a plain `Error` with `name`
    // set; ObjectInspector reads `constructor.name` for the displayed
    // class label, but we don't have the real class, so we emit a tagged
    // Error whose `name` field carries the class identity. This matches
    // how the existing base `Error` reviver presents unknown subclasses.
    FatalError: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new Error(value.message, opts);
      error.name = 'FatalError';
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    HookConflictError: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new Error(value.message, opts) as Error & {
        token?: string;
        conflictingRunId?: string;
      };
      error.name = 'HookConflictError';
      error.token = value.token;
      if (value.conflictingRunId !== undefined) {
        error.conflictingRunId = value.conflictingRunId;
      }
      if (value.stack !== undefined) error.stack = value.stack;
      return error;
    },
    RetryableError: (value) => {
      const opts = 'cause' in value ? { cause: value.cause } : undefined;
      const error = new Error(value.message, opts) as Error & {
        retryAfter?: Date;
      };
      error.name = 'RetryableError';
      if (value.stack !== undefined) error.stack = value.stack;
      // `retryAfter` is serialized as an epoch ms number (see the runtime
      // RetryableError reducer for the rationale around realm-safety).
      // Rehydrate as a Date so o11y consumers can render it directly.
      // Guard against payloads from older runtime versions that predate
      // the field — without this check, `new Date(undefined)` would
      // produce an Invalid Date rather than omitting the property.
      if (value.retryAfter != null) {
        error.retryAfter = new Date(value.retryAfter);
      }
      return error;
    },
    DOMException: (value) => {
      // Modern browsers and Node 18+ expose `DOMException` on globalThis.
      // `AbortController.abort()` with no argument synthesizes one as the
      // signal's reason, so this is a common payload for any aborted step.
      const G = globalThis as { DOMException?: typeof DOMException };
      if (typeof G.DOMException === 'function') {
        const e = new G.DOMException(value.message, value.name);
        if (value.stack !== undefined) e.stack = value.stack;
        if ('cause' in value) (e as { cause?: unknown }).cause = value.cause;
        return e;
      }
      const error = new Error(value.message);
      error.name = value.name;
      if (value.stack !== undefined) error.stack = value.stack;
      if ('cause' in value) {
        (error as Error & { cause?: unknown }).cause = value.cause;
      }
      return error;
    },
    Float32Array: (value: string) => new Float32Array(reviveArrayBuffer(value)),
    Float64Array: (value: string) => new Float64Array(reviveArrayBuffer(value)),
    Int8Array: (value: string) => new Int8Array(reviveArrayBuffer(value)),
    Int16Array: (value: string) => new Int16Array(reviveArrayBuffer(value)),
    Int32Array: (value: string) => new Int32Array(reviveArrayBuffer(value)),
    Map: (value) => new Map(value),
    RegExp: (value) => new RegExp(value.source, value.flags),
    Set: (value) => new Set(value),
    Uint8Array: (value: string) => new Uint8Array(reviveArrayBuffer(value)),
    Uint8ClampedArray: (value: string) =>
      new Uint8ClampedArray(reviveArrayBuffer(value)),
    Uint16Array: (value: string) => new Uint16Array(reviveArrayBuffer(value)),
    Uint32Array: (value: string) => new Uint32Array(reviveArrayBuffer(value)),

    Headers: (value) => new Headers(value),
    Request: (value) => {
      // biome-ignore lint/complexity/useArrowFunction: arrow functions have no .prototype
      const ctor = { Request: function () {} }.Request!;
      const obj = Object.create(ctor.prototype);
      Object.assign(obj, {
        method: value.method,
        url: value.url,
        headers: new Headers(value.headers),
        body: value.body,
        duplex: value.duplex,
        ...(value.responseWritable
          ? { responseWritable: value.responseWritable }
          : {}),
      });
      return obj;
    },
    Response: (value) => {
      // biome-ignore lint/complexity/useArrowFunction: arrow functions have no .prototype
      const ctor = { Response: function () {} }.Response!;
      const obj = Object.create(ctor.prototype);
      Object.assign(obj, {
        status: value.status,
        statusText: value.statusText,
        url: value.url,
        headers: new Headers(value.headers),
        body: value.body,
        redirected: value.redirected,
        type: value.type,
      });
      return obj;
    },
    URL: (value) => new URL(value),
    URLSearchParams: (value) => new URLSearchParams(value === '.' ? '' : value),

    // Web-specific overrides for class instances.
    // Create objects with a dynamically-named constructor so that
    // react-inspector shows the class name (it reads constructor.name).
    Class: (value) => `<class:${extractClassName(value.classId)}>`,
    Instance: (value) => {
      // Run instances are rendered as clickable RunRef badges
      const runRef = serializedInstanceToRef(value);
      if (isRunRef(runRef)) {
        return runRef;
      }
      const className = extractClassName(value.classId);
      const data = value.data;
      const props =
        data && typeof data === 'object' ? { ...data } : { value: data };
      // Create a constructor with the right name using computed property
      // so react-inspector's `object.constructor.name` shows the class name.
      // Must use `function` (not arrow) because arrow functions have no .prototype.
      // biome-ignore lint/complexity/useArrowFunction: arrow functions have no .prototype
      const ctor = { [className]: function () {} }[className]!;
      const obj = Object.create(ctor.prototype);
      Object.assign(obj, props);
      return obj;
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-built web revivers (cached for performance)
// ---------------------------------------------------------------------------

let cachedRevivers: Revivers | null = null;

function getRevivers(): Revivers {
  if (!cachedRevivers) {
    cachedRevivers = getWebRevivers();
  }
  return cachedRevivers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hydrate the serialized data fields of a resource for web display.
 *
 * Uses browser-safe revivers (atob for base64, ClassInstanceRef for
 * custom classes, StreamRef for streams). Call this on data received
 * from the server before passing it to UI components.
 */
export function hydrateResourceIO<T>(resource: T): T {
  const hydrated = hydrateResourceIOGeneric(
    resource as any,
    getRevivers()
  ) as T;
  return replaceEncryptedAndExpiredWithMarkers(hydrated);
}

// ---------------------------------------------------------------------------
// Encrypted data display markers
// ---------------------------------------------------------------------------

export const ENCRYPTED_DISPLAY_NAME = 'Encrypted';

/**
 * Create a display-friendly object for encrypted data.
 *
 * Uses the same named-constructor trick as the Instance reviver so that
 * ObjectInspector renders the constructor name ("🔒 Encrypted") with no
 * expandable children. The original encrypted bytes are stored in a
 * non-enumerable property for later decryption.
 */
function createEncryptedMarker(data: Uint8Array): object {
  // biome-ignore lint/complexity/useArrowFunction: arrow functions have no .prototype
  const ctor = { [ENCRYPTED_DISPLAY_NAME]: function () {} }[
    ENCRYPTED_DISPLAY_NAME
  ]!;
  const obj = Object.create(ctor.prototype);
  // Store original bytes for decryption, but non-enumerable so
  // ObjectInspector doesn't show them as children
  Object.defineProperty(obj, '__encryptedData', {
    value: data,
    enumerable: false,
    configurable: false,
  });
  return obj;
}

/** Check if a value is an encrypted display marker */
export function isEncryptedMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.constructor?.name === ENCRYPTED_DISPLAY_NAME
  );
}

// ---------------------------------------------------------------------------
// Expired data display markers
// ---------------------------------------------------------------------------

export const EXPIRED_DISPLAY_NAME = 'Expired Data';

/**
 * Create a display-friendly object for expired data.
 *
 * Uses the same named-constructor trick as the encrypted marker so that
 * ObjectInspector renders the constructor name ("Expired Data") with no
 * expandable children.
 */
function createExpiredMarker(): object {
  // biome-ignore lint/complexity/useArrowFunction: arrow functions have no .prototype
  const ctor = { [EXPIRED_DISPLAY_NAME]: function () {} }[
    EXPIRED_DISPLAY_NAME
  ]!;
  return Object.create(ctor.prototype);
}

/** Check if a value is an expired data display marker */
export function isExpiredMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.constructor?.name === EXPIRED_DISPLAY_NAME
  );
}

/** Replace a single field value with a display marker if it's encrypted or expired. */
function toDisplayMarker(value: unknown): unknown {
  if (isEncryptedData(value)) return createEncryptedMarker(value as Uint8Array);
  if (isExpiredStub(value)) return createExpiredMarker();
  return value;
}

/**
 * Post-process hydrated resource data: replace encrypted Uint8Array values
 * and expired stubs with display-friendly marker objects in known data fields.
 */
function replaceEncryptedAndExpiredWithMarkers<T>(resource: T): T {
  if (!resource || typeof resource !== 'object') return resource;
  const r = resource as Record<string, unknown>;
  const result = { ...r };

  for (const key of ['input', 'output', 'metadata', 'error']) {
    result[key] = toDisplayMarker(result[key]);
  }

  if (result.eventData && typeof result.eventData === 'object') {
    const eventType =
      typeof result.eventType === 'string' ? result.eventType : '';
    const refKeys = EVENT_DATA_REF_FIELDS[eventType] ?? [];
    const ed = { ...(result.eventData as Record<string, unknown>) };
    for (const key of refKeys) {
      if (key in ed) {
        ed[key] = toDisplayMarker(ed[key]);
      }
    }
    result.eventData = ed;
  }

  return result as T;
}

/**
 * Hydrate resource data with decryption support.
 *
 * When a key is provided, encrypted fields are decrypted before hydration.
 * This is the async version used when the user clicks "Decrypt" in the web UI.
 *
 * Handles both top-level fields (input, output, metadata) and nested
 * eventData subfields per `EVENT_DATA_REF_FIELDS` from `@workflow/world` for that event type.
 */
export async function hydrateResourceIOWithKey<T>(
  resource: T,
  key: Uint8Array
): Promise<T> {
  const { hydrateDataWithKey } = await import(
    '@workflow/core/serialization-format'
  );
  const { importKey } = await import('@workflow/core/encryption');
  const cryptoKey = await importKey(key);
  const revivers = getRevivers();

  /** Extract original encrypted bytes from a marker or raw Uint8Array, then decrypt + hydrate */
  async function decryptField(
    value: unknown,
    rev: Revivers,
    k: Awaited<ReturnType<typeof importKey>>
  ): Promise<unknown> {
    // Already-hydrated: encrypted marker with stored bytes
    if (isEncryptedMarker(value)) {
      const raw = (value as any).__encryptedData as Uint8Array;
      return hydrateDataWithKey(raw, rev, k);
    }
    // Raw encrypted Uint8Array (not yet hydrated)
    if (value instanceof Uint8Array) {
      return hydrateDataWithKey(value, rev, k);
    }
    // Not encrypted — return as-is
    return value;
  }

  const r = resource as Record<string, unknown>;
  const result = { ...r };

  // Decrypt + hydrate top-level serialized fields (runs, steps, hooks)
  for (const field of ['input', 'output', 'metadata', 'error']) {
    if (field in result) {
      result[field] = await decryptField(result[field], revivers, cryptoKey);
    }
  }

  // Decrypt + hydrate eventData subfields (events)
  if (result.eventData && typeof result.eventData === 'object') {
    const eventType =
      typeof result.eventType === 'string' ? result.eventType : '';
    const refKeys = EVENT_DATA_REF_FIELDS[eventType] ?? [];
    const eventData = { ...(result.eventData as Record<string, unknown>) };
    for (const field of refKeys) {
      if (field in eventData) {
        eventData[field] = await decryptField(
          eventData[field],
          revivers,
          cryptoKey
        );
      }
    }
    result.eventData = eventData;
  }

  return result as T;
}

/**
 * Check whether a hydrated resource (event, step, run, etc.) contains any
 * encrypted display markers. Inspects the standard top-level fields
 * (`input`, `output`, `error`, `metadata`) as well as the event-type-specific
 * `eventData` ref fields.
 */
export function hasEncryptedFields(resource: unknown): boolean {
  if (!resource || typeof resource !== 'object') return false;
  const r = resource as Record<string, unknown>;

  for (const key of ['input', 'output', 'metadata', 'error']) {
    if (isEncryptedMarker(r[key])) return true;
  }

  if (r.eventData && typeof r.eventData === 'object') {
    const eventType = typeof r.eventType === 'string' ? r.eventType : '';
    const refKeys = EVENT_DATA_REF_FIELDS[eventType] ?? [];
    const ed = r.eventData as Record<string, unknown>;
    for (const key of refKeys) {
      if (key in ed && isEncryptedMarker(ed[key])) return true;
    }
  }

  return false;
}
