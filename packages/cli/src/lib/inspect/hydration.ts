/**
 * CLI-specific hydration for o11y display.
 *
 * Node.js revivers that use `Buffer.from()` for base64 decoding and add
 * `util.inspect.custom` to ClassInstanceRef for pretty CLI output.
 */

import { inspect } from 'node:util';
import { maybeDecrypt } from '@workflow/core/serialization';
import {
  ClassInstanceRef,
  extractClassName,
  hydrateResourceIO as hydrateResourceIOGeneric,
  isEncryptedData,
  isExpiredStub,
  isRunRef,
  observabilityRevivers,
  type Revivers,
  serializedInstanceToRef,
} from '@workflow/core/serialization-format';
import { parseClassName } from '@workflow/utils/parse-name';
import chalk from 'chalk';

/**
 * A function that resolves an encryption key for a run, or null to skip
 * decryption. Accepts a runId — the resolver is responsible for looking
 * up the WorkflowRun internally (with caching) if the World needs it.
 */
export type EncryptionKeyResolver =
  | ((runId: string) => Promise<Uint8Array | undefined>)
  | null;

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
// CLI encrypted data placeholder with custom inspect
// ---------------------------------------------------------------------------

/**
 * Placeholder object for encrypted data fields in CLI output.
 *
 * Uses `util.inspect.custom` to render as a styled, unquoted string
 * (e.g., dim yellow "🔒 Encrypted") instead of a plain quoted string.
 * Also provides `toJSON()` for `--json` output.
 */
class EncryptedDataRef {
  [inspect.custom](): string {
    return chalk.dim.yellow('\u{1F512} Encrypted');
  }

  toJSON(): string {
    return '\u{1F512} Encrypted';
  }

  toString(): string {
    return '\u{1F512} Encrypted';
  }
}

/** Singleton encrypted data placeholder for CLI display */
const ENCRYPTED_REF = new EncryptedDataRef();

/** Check if a value is an EncryptedDataRef (for custom table formatting in CLI) */
export function isEncryptedRef(value: unknown): value is EncryptedDataRef {
  return value instanceof EncryptedDataRef;
}

// ---------------------------------------------------------------------------
// CLI expired data placeholder with custom inspect
// ---------------------------------------------------------------------------

/**
 * Placeholder object for expired data fields in CLI output.
 *
 * Uses `util.inspect.custom` to render as a styled, unquoted string
 * (e.g., dim gray "<data expired>") instead of a raw stub object.
 * Also provides `toJSON()` for `--json` output.
 */
class ExpiredDataRef {
  [inspect.custom](): string {
    return chalk.gray('<data expired>');
  }

  toJSON(): string {
    return '<data expired>';
  }

  toString(): string {
    return '<data expired>';
  }
}

/** Singleton expired data placeholder for CLI display */
const EXPIRED_REF = new ExpiredDataRef();

/** Check if a value is an ExpiredDataRef (for custom table formatting in CLI) */
export function isExpiredRef(value: unknown): value is ExpiredDataRef {
  return value instanceof ExpiredDataRef;
}

// ---------------------------------------------------------------------------
// CLI revivers (Node.js, uses Buffer)
// ---------------------------------------------------------------------------

export function getCLIRevivers(): Revivers {
  function reviveArrayBuffer(value: string): ArrayBuffer {
    const base64 = value === '.' ? '' : value;
    const buffer = Buffer.from(base64, 'base64');
    const arrayBuffer = new ArrayBuffer(buffer.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    uint8Array.set(buffer);
    return arrayBuffer;
  }

  return {
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
    Int8Array: (value: string) => new Int8Array(reviveArrayBuffer(value)),
    Int16Array: (value: string) => new Int16Array(reviveArrayBuffer(value)),
    Int32Array: (value: string) => new Int32Array(reviveArrayBuffer(value)),
    Map: (value) => new Map(value),
    RegExp: (value) => new RegExp(value.source, value.flags),
    // O11y-specific revivers (streams, step functions → display objects).
    // Spread FIRST so CLI-specific overrides below take precedence.
    ...observabilityRevivers,
    // CLI-specific overrides for class instances with inspect.custom
    Class: (value) => `<class:${extractClassName(value.classId)}>`,
    Instance: (value) => {
      // Run instances are rendered as RunRef for clickable rendering
      const runRef = serializedInstanceToRef(value);
      if (isRunRef(runRef)) {
        return runRef;
      }
      return new CLIClassInstanceRef(
        extractClassName(value.classId),
        value.classId,
        value.data
      );
    },
    Set: (value) => new Set(value),
    URL: (value) => new URL(value),
    URLSearchParams: (value) => new URLSearchParams(value === '.' ? '' : value),
    Uint8Array: (value: string) => new Uint8Array(reviveArrayBuffer(value)),
    Uint8ClampedArray: (value: string) =>
      new Uint8ClampedArray(reviveArrayBuffer(value)),
    Uint16Array: (value: string) => new Uint16Array(reviveArrayBuffer(value)),
    Uint32Array: (value: string) => new Uint32Array(reviveArrayBuffer(value)),
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
// Decryption helpers
// ---------------------------------------------------------------------------

/**
 * Pre-process a resource's data fields: if the resolver is provided and
 * the field is encrypted, decrypt it before generic hydration.
 *
 * Uses core's `maybeDecrypt()` which handles the 'encr' prefix stripping
 * and AES-GCM decryption transparently.
 *
 * When the resolver is null (no --decrypt flag), encrypted fields pass
 * through as Uint8Array and are replaced with EncryptedDataRef in post-processing.
 */
async function maybeDecryptFields<
  T extends {
    runId?: string;
    input?: any;
    output?: any;
    metadata?: any;
    eventData?: any;
  },
>(resource: T, resolver: EncryptionKeyResolver): Promise<T> {
  if (!resolver) return resource;

  const runId = (resource as any).runId as string | undefined;
  if (!runId) return resource;

  const result = { ...resource };

  try {
    const rawKey = await resolver(runId);
    const { importKey } = await import('@workflow/core/encryption');
    const k = rawKey ? await importKey(rawKey) : undefined;

    // Decrypt input/output/error fields (WorkflowRun, Step)
    result.input = await maybeDecrypt(result.input, k);
    result.output = await maybeDecrypt(result.output, k);
    (result as any).error = await maybeDecrypt((result as any).error, k);

    // Decrypt metadata field (Hook)
    result.metadata = await maybeDecrypt(result.metadata, k);

    // Decrypt eventData fields (Event)
    if (result.eventData && typeof result.eventData === 'object') {
      const eventData = { ...result.eventData };
      for (const field of [
        'result',
        'input',
        'output',
        'metadata',
        'payload',
      ]) {
        eventData[field] = await maybeDecrypt(eventData[field], k);
      }
      result.eventData = eventData;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // If the key fetch failed due to an HTTP error (e.g. 429 rate limit,
    // 500 server error), re-throw so the caller surfaces a clear failure
    // instead of silently showing encrypted placeholders.
    if (message.includes('HTTP ')) {
      throw err;
    }

    // Decryption failed (bad key, corrupted ciphertext, etc.) — fall back
    // to showing encrypted placeholders instead of crashing the CLI.
    const { logger } = await import('../config/log.js');
    logger.warn(`Decryption failed for resource ${runId}: ${message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Replace a single field value with a display ref if it's encrypted or expired. */
function toDisplayRef(value: unknown): unknown {
  if (isEncryptedData(value)) return ENCRYPTED_REF;
  if (isExpiredStub(value)) return EXPIRED_REF;
  return value;
}

/**
 * Replace encrypted Uint8Array values and expired stubs with styled
 * ref objects in known data fields for custom inspect rendering.
 */
function replaceEncryptedAndExpiredWithRef<T>(resource: T): T {
  if (!resource || typeof resource !== 'object') return resource;
  const r = resource as Record<string, unknown>;
  const result = { ...r };

  for (const key of ['input', 'output', 'metadata', 'error']) {
    result[key] = toDisplayRef(result[key]);
  }

  if (result.eventData && typeof result.eventData === 'object') {
    const ed = { ...(result.eventData as Record<string, unknown>) };
    for (const key of ['result', 'input', 'output', 'metadata', 'payload']) {
      ed[key] = toDisplayRef(ed[key]);
    }
    result.eventData = ed;
  }

  return result as T;
}

/**
 * Hydrate the serialized data fields of a resource for CLI display.
 *
 * When `encryptorResolver` is null (default / no --decrypt flag), encrypted
 * fields are shown as styled "🔒 Encrypted" placeholders via EncryptedDataRef.
 *
 * When `encryptorResolver` is provided (--decrypt flag), encrypted fields
 * are decrypted before hydration so the actual user data is displayed.
 */
export async function hydrateResourceIO<T>(
  resource: T,
  keyResolver?: EncryptionKeyResolver
): Promise<T> {
  // Pre-process: decrypt any encrypted fields when a resolver is provided
  const preprocessed = await maybeDecryptFields(
    resource as any,
    keyResolver ?? null
  );
  const hydrated = hydrateResourceIOGeneric(preprocessed, getRevivers()) as T;
  // Post-process: swap encrypted Uint8Arrays and expired stubs for CLI-styled objects
  return replaceEncryptedAndExpiredWithRef(hydrated);
}
