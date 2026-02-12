/**
 * CLI-specific hydration for o11y display.
 *
 * Node.js revivers that use `Buffer.from()` for base64 decoding and add
 * `util.inspect.custom` to ClassInstanceRef for pretty CLI output.
 */

import { inspect } from 'node:util';
import {
  ClassInstanceRef,
  extractClassName,
  hydrateResourceIO as hydrateResourceIOGeneric,
  observabilityRevivers,
  type Revivers,
} from '@workflow/core/serialization-format';
import { parseClassName } from '@workflow/utils/parse-name';

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
// CLI ClassInstanceRef with inspect.custom
// ---------------------------------------------------------------------------

/**
 * Extended ClassInstanceRef with Node.js `util.inspect.custom` for
 * pretty CLI output: `ClassName@filename { ...data }`
 */
class CLIClassInstanceRef extends ClassInstanceRef {
  [inspect.custom](
    _depth: number,
    options: import('node:util').InspectOptionsStylized
  ): string {
    const dataStr = inspect(this.data, { ...options, depth: options.depth });
    const parsed = parseClassName(this.classId);
    const moduleSpecifier = parsed?.moduleSpecifier ?? this.classId;
    const fileName = moduleSpecifier.split('/').pop() ?? moduleSpecifier;
    const styledFileName = options.stylize
      ? options.stylize(`@${fileName}`, 'undefined')
      : `@${fileName}`;
    return `${this.className}${styledFileName} ${dataStr}`;
  }
}

// ---------------------------------------------------------------------------
// CLI revivers (Node.js, uses Buffer)
// ---------------------------------------------------------------------------

export function getCLIRevivers(
  global: Record<string, any> = globalThis
): Revivers {
  function reviveArrayBuffer(value: string): ArrayBuffer {
    const base64 = value === '.' ? '' : value;
    const buffer = Buffer.from(base64, 'base64');
    const arrayBuffer = new global.ArrayBuffer(buffer.length);
    const uint8Array = new global.Uint8Array(arrayBuffer);
    uint8Array.set(buffer);
    return arrayBuffer;
  }

  return {
    ArrayBuffer: reviveArrayBuffer,
    BigInt: (value: string) => global.BigInt(value),
    BigInt64Array: (value: string) =>
      new global.BigInt64Array(reviveArrayBuffer(value)),
    BigUint64Array: (value: string) =>
      new global.BigUint64Array(reviveArrayBuffer(value)),
    Date: (value) => new global.Date(value),
    Error: (value) => {
      const error = new global.Error(value.message);
      error.name = value.name;
      error.stack = value.stack;
      return error;
    },
    Float32Array: (value: string) =>
      new global.Float32Array(reviveArrayBuffer(value)),
    Float64Array: (value: string) =>
      new global.Float64Array(reviveArrayBuffer(value)),
    Headers: (value) => new global.Headers(value),
    Int8Array: (value: string) =>
      new global.Int8Array(reviveArrayBuffer(value)),
    Int16Array: (value: string) =>
      new global.Int16Array(reviveArrayBuffer(value)),
    Int32Array: (value: string) =>
      new global.Int32Array(reviveArrayBuffer(value)),
    Map: (value) => new global.Map(value),
    RegExp: (value) => new global.RegExp(value.source, value.flags),
    // O11y-specific revivers (streams, step functions → display objects).
    // Spread FIRST so CLI-specific overrides below take precedence.
    ...observabilityRevivers,
    // CLI-specific overrides for class instances with inspect.custom
    Class: (value) => `<class:${extractClassName(value.classId)}>`,
    Instance: (value) =>
      new CLIClassInstanceRef(
        extractClassName(value.classId),
        value.classId,
        value.data
      ),
    Set: (value) => new global.Set(value),
    URL: (value) => new global.URL(value),
    URLSearchParams: (value) =>
      new global.URLSearchParams(value === '.' ? '' : value),
    Uint8Array: (value: string) =>
      new global.Uint8Array(reviveArrayBuffer(value)),
    Uint8ClampedArray: (value: string) =>
      new global.Uint8ClampedArray(reviveArrayBuffer(value)),
    Uint16Array: (value: string) =>
      new global.Uint16Array(reviveArrayBuffer(value)),
    Uint32Array: (value: string) =>
      new global.Uint32Array(reviveArrayBuffer(value)),
  };
}

// ---------------------------------------------------------------------------
// Pre-built CLI revivers (cached)
// ---------------------------------------------------------------------------

let cachedRevivers: Revivers | null = null;

function getRevivers(): Revivers {
  if (!cachedRevivers) {
    cachedRevivers = getCLIRevivers();
  }
  return cachedRevivers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hydrate the serialized data fields of a resource for CLI display.
 */
export function hydrateResourceIO<T>(resource: T): T {
  return hydrateResourceIOGeneric(resource as any, getRevivers()) as T;
}
