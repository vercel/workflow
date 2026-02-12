/**
 * Web-specific hydration for o11y display.
 *
 * Browser-safe revivers that use `atob()` for base64 decoding (no Node.js
 * `Buffer` dependency). Produces `ClassInstanceRef` objects and `StreamRef`
 * objects for UI rendering.
 */

import {
  ClassInstanceRef,
  extractClassName,
  hydrateResourceIO as hydrateResourceIOGeneric,
  observabilityRevivers,
  type Revivers,
} from '@workflow/core/serialization-format';

// Re-export types and utilities that consumers need
export {
  CLASS_INSTANCE_REF_TYPE,
  ClassInstanceRef,
  extractStreamIds,
  isClassInstanceRef,
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
 * Most types are revived as real instances (Date, Map, Set, Error, etc.)
 * since they are structurally cloneable and work with React rendering.
 *
 * Types that are NOT structurally cloneable (URLSearchParams, Headers)
 * are converted to plain object equivalents, since the trace viewer's
 * web worker uses postMessage which requires structured cloneability.
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

    Headers: (value) =>
      Object.fromEntries(
        typeof value === 'object' && value !== null ? Object.entries(value) : []
      ),
    URL: (value) => String(value),
    URLSearchParams: (value) => {
      if (value === '.' || value === '') return {};
      return Object.fromEntries(new URLSearchParams(value));
    },

    // Web-specific overrides for class instances
    Class: (value) => `<class:${extractClassName(value.classId)}>`,
    Instance: (value) =>
      new ClassInstanceRef(
        extractClassName(value.classId),
        value.classId,
        value.data
      ),
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
  return hydrateResourceIOGeneric(resource as any, getRevivers()) as T;
}
