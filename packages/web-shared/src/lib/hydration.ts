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
 * These use `atob()` for base64 decoding and produce `ClassInstanceRef`
 * objects for custom class instances (rendered as UI components rather
 * than using `util.inspect.custom`).
 */
export function getWebRevivers(
  global: Record<string, any> = globalThis
): Revivers {
  function reviveArrayBuffer(value: string): ArrayBuffer {
    return base64ToArrayBuffer(value);
  }

  return {
    // Common type revivers (browser-safe base64)
    ArrayBuffer: reviveArrayBuffer,
    BigInt: (value: string) => global.BigInt(value),
    BigInt64Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.BigInt64Array(ab);
    },
    BigUint64Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.BigUint64Array(ab);
    },
    Date: (value) => new global.Date(value),
    Error: (value) => {
      const error = new global.Error(value.message);
      error.name = value.name;
      error.stack = value.stack;
      return error;
    },
    Float32Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Float32Array(ab);
    },
    Float64Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Float64Array(ab);
    },
    Headers: (value) => new global.Headers(value),
    Int8Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Int8Array(ab);
    },
    Int16Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Int16Array(ab);
    },
    Int32Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Int32Array(ab);
    },
    Map: (value) => new global.Map(value),
    RegExp: (value) => new global.RegExp(value.source, value.flags),
    Set: (value) => new global.Set(value),
    URL: (value) => new global.URL(value),
    URLSearchParams: (value) =>
      new global.URLSearchParams(value === '.' ? '' : value),
    Uint8Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Uint8Array(ab);
    },
    Uint8ClampedArray: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Uint8ClampedArray(ab);
    },
    Uint16Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Uint16Array(ab);
    },
    Uint32Array: (value: string) => {
      const ab = reviveArrayBuffer(value);
      return new global.Uint32Array(ab);
    },
    // Class/Instance: use display-friendly ClassInstanceRef
    Class: (value) => `<class:${extractClassName(value.classId)}>`,
    Instance: (value) =>
      new ClassInstanceRef(
        extractClassName(value.classId),
        value.classId,
        value.data
      ),
    // O11y-specific revivers (streams, step functions → display objects)
    ...observabilityRevivers,
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
