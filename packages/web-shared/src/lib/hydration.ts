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
  observabilityRevivers,
  type Revivers,
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
  isStreamId,
  isStreamRef,
  type Revivers,
  STREAM_REF_TYPE,
  type StreamRef,
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
 * Get the web-specific revivers for hydrating serialized data.
 *
 * Uses `atob()` for base64 decoding (no Node.js Buffer dependency).
 * All types are revived as real instances (Date, Map, Set, URL,
 * URLSearchParams, Headers, Error, etc.).
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
    Error: (value) => {
      const error = new Error(value.message);
      error.name = value.name;
      error.stack = value.stack;
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
