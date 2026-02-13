/**
 * CLI-specific hydration for o11y display.
 *
 * Node.js revivers that use `Buffer.from()` for base64 decoding and add
 * `util.inspect.custom` to ClassInstanceRef for pretty CLI output.
 */

import { inspect } from 'node:util';
import {
  ClassInstanceRef,
  ENCRYPTED_PLACEHOLDER,
  extractClassName,
  hydrateResourceIO as hydrateResourceIOGeneric,
  isEncryptedData,
  observabilityRevivers,
  type Revivers,
} from '@workflow/core/serialization-format';
import { parseClassName } from '@workflow/utils/parse-name';
import type { Encryptor } from '@workflow/world';
import chalk from 'chalk';

/** A function that resolves an Encryptor for a given runId, or null to skip decryption. */
export type EncryptorResolver = ((runId: string) => Promise<Encryptor>) | null;

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

/** Check if a value is an EncryptedDataRef (for custom table formatting) */
export function isEncryptedRef(value: unknown): value is EncryptedDataRef {
  return value instanceof EncryptedDataRef;
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
    Instance: (value) =>
      new CLIClassInstanceRef(
        extractClassName(value.classId),
        value.classId,
        value.data
      ),
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

/** Format prefix length in bytes (must match serialization-format.ts) */
const FORMAT_PREFIX_LENGTH = 4;

/**
 * Decrypt a single encrypted data field, stripping the 'encr' prefix first.
 * Returns the decrypted Uint8Array (which will have its own format prefix, e.g. 'devl').
 */
async function decryptField(
  data: Uint8Array,
  encryptor: Encryptor,
  runId: string
): Promise<Uint8Array> {
  if (!encryptor.decrypt) {
    throw new Error(
      'Encrypted data encountered but Encryptor does not support decryption.'
    );
  }
  // Strip the 'encr' format prefix — the Encryptor only sees [nonce][ciphertext]
  const payload = data.subarray(FORMAT_PREFIX_LENGTH);
  return encryptor.decrypt(payload, { runId });
}

/**
 * Pre-process a resource's data fields: if the resolver is provided and
 * the field is encrypted, decrypt it before generic hydration.
 *
 * When the resolver is null (no --decrypt flag), encrypted fields flow
 * through to the generic hydrateData which returns ENCRYPTED_PLACEHOLDER.
 */
async function maybeDecryptFields<
  T extends {
    runId?: string;
    input?: any;
    output?: any;
    metadata?: any;
    eventData?: any;
  },
>(resource: T, resolver: EncryptorResolver): Promise<T> {
  if (!resolver) return resource;

  const runId = (resource as any).runId as string | undefined;
  if (!runId) return resource;

  let encryptor: Encryptor | null = null;
  const getEncryptor = async () => {
    if (!encryptor) encryptor = await resolver(runId);
    return encryptor;
  };

  const result = { ...resource };

  // Decrypt input/output fields (WorkflowRun, Step)
  if (isEncryptedData(result.input)) {
    result.input = await decryptField(
      result.input,
      await getEncryptor(),
      runId
    );
  }
  if (isEncryptedData(result.output)) {
    result.output = await decryptField(
      result.output,
      await getEncryptor(),
      runId
    );
  }

  // Decrypt metadata field (Hook)
  if (isEncryptedData(result.metadata)) {
    result.metadata = await decryptField(
      result.metadata,
      await getEncryptor(),
      runId
    );
  }

  // Decrypt eventData fields (Event)
  if (result.eventData && typeof result.eventData === 'object') {
    const eventData = { ...result.eventData };
    if (isEncryptedData(eventData.result)) {
      eventData.result = await decryptField(
        eventData.result,
        await getEncryptor(),
        runId
      );
    }
    if (isEncryptedData(eventData.input)) {
      eventData.input = await decryptField(
        eventData.input,
        await getEncryptor(),
        runId
      );
    }
    result.eventData = eventData;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replace ENCRYPTED_PLACEHOLDER strings with EncryptedDataRef objects
 * in known data fields so they render with custom inspect styling.
 */
function replaceEncryptedPlaceholders<T>(resource: T): T {
  if (!resource || typeof resource !== 'object') return resource;
  const r = resource as Record<string, unknown>;
  const result = { ...r };

  for (const key of ['input', 'output', 'metadata']) {
    if (result[key] === ENCRYPTED_PLACEHOLDER) {
      result[key] = ENCRYPTED_REF;
    }
  }

  if (result.eventData && typeof result.eventData === 'object') {
    const ed = { ...(result.eventData as Record<string, unknown>) };
    for (const key of ['result', 'input']) {
      if (ed[key] === ENCRYPTED_PLACEHOLDER) {
        ed[key] = ENCRYPTED_REF;
      }
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
  encryptorResolver?: EncryptorResolver
): Promise<T> {
  // Pre-process: decrypt any encrypted fields when a resolver is provided
  const preprocessed = await maybeDecryptFields(
    resource as any,
    encryptorResolver ?? null
  );
  const hydrated = hydrateResourceIOGeneric(preprocessed, getRevivers()) as T;
  // Post-process: swap string placeholders for CLI-styled objects
  return replaceEncryptedPlaceholders(hydrated);
}
