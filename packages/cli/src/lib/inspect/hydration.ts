/**
 * CLI-specific hydration for o11y display.
 *
 * Node.js revivers that use `Buffer.from()` for base64 decoding and add
 * `util.inspect.custom` to ClassInstanceRef for pretty CLI output.
 */

import { inspect } from 'node:util';
import { decrypt, getCommonRevivers } from '@workflow/core/serialization';
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
import { getEventDataRefFields } from '@workflow/world';
import chalk from 'chalk';

async function decryptPayload(
  value: unknown,
  key: Parameters<typeof decrypt>[1]
): Promise<unknown> {
  return value instanceof Uint8Array ? decrypt(value, key) : value;
}

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

/**
 * The set of reducer keys whose `getCommonRevivers()` output produces a
 * native `Error` instance. We wrap each of these with an additional
 * `toJSON` attachment in CLI mode (see `wrapErrorReviverWithToJSON`).
 */
const ERROR_REVIVER_KEYS = [
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'FatalError',
  'HookConflictError',
  'RangeError',
  'ReferenceError',
  'RetryableError',
  'RuntimeDecryptionError',
  'SyntaxError',
  'TypeError',
  'URIError',
] as const;

/**
 * Wraps a runtime Error reviver so that the produced instance carries a
 * non-enumerable `toJSON` method. The runtime revivers return real `Error`
 * instances (good for `util.inspect`, `instanceof`, `toString`, etc.), but
 * `Error.prototype`'s `name` / `message` / `stack` / `cause` are
 * non-enumerable and would be dropped by `JSON.stringify` — which is how
 * the CLI emits its `--json` output. Adding `toJSON` (which `JSON.stringify`
 * calls but `util.inspect` ignores) gives us the best of both worlds:
 * round-tripped errors render cleanly in both modes without the
 * data-versus-display tradeoff that plain-object revivers would force.
 *
 * Subclass-specific enumerable fields (e.g. `RetryableError.retryAfter`,
 * `AggregateError.errors`, `FatalError.fatal`) are picked up automatically
 * via `Object.assign` after the base fields, so we don't have to enumerate
 * them per-subclass.
 */
function wrapErrorReviverWithToJSON(
  reviver: (value: any) => unknown
): (value: any) => unknown {
  return (value) => {
    const result = reviver(value);
    if (!(result instanceof Error)) return result;
    Object.defineProperty(result, 'toJSON', {
      value: function (this: Error) {
        const json: Record<string, unknown> = {
          name: this.name,
          message: this.message,
          stack: this.stack,
        };
        if ('cause' in this) {
          json.cause = (this as { cause: unknown }).cause;
        }
        // Pick up subclass-specific enumerable fields (e.g. FatalError.fatal,
        // RetryableError.retryAfter, AggregateError.errors).
        Object.assign(json, this);
        return json;
      },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return result;
  };
}

/**
 * The set of revivers used by CLI inspect output.
 *
 * Built on top of `getCommonRevivers()` from `@workflow/core` so that the
 * CLI stays in sync with the runtime's reviver set automatically. Without
 * this, every new reviver added to core (e.g. `FatalError`,
 * `RetryableError`, the built-in `Error` subclasses) would silently
 * disappear from CLI output: devalue throws "Unknown type X" for
 * unrecognized reduced types, and `hydrateResourceIO` swallows that error
 * and surfaces the raw `Uint8Array` payload to consumers — which then
 * shows up as `step.error` / `run.error` byte dumps instead of usable
 * `{ message, stack, … }` objects.
 *
 * On top of the common set we layer:
 *   - A `toJSON` shim on each Error reviver so non-enumerable
 *     `Error.prototype` fields survive `JSON.stringify` for `--json` output
 *     while leaving `util.inspect` rendering untouched
 *   - `observabilityRevivers` for streams / step+workflow function refs
 *   - CLI-specific overrides that produce display-friendly placeholders
 *     for `Class` / `Instance` (the runtime versions need full class
 *     identity which the CLI doesn't have access to)
 */
export function getCLIRevivers(): Revivers {
  const baseRevivers = getCommonRevivers(globalThis);
  const errorRevivers = Object.fromEntries(
    ERROR_REVIVER_KEYS.flatMap((key) => {
      const reviver = (baseRevivers as Revivers)[key];
      return reviver ? [[key, wrapErrorReviverWithToJSON(reviver)]] : [];
    })
  );
  return {
    ...baseRevivers,
    ...errorRevivers,
    // O11y-specific revivers (streams, step functions → display objects).
    ...observabilityRevivers,
    // Node `Request` / `Response` revivers that don't rely on running an
    // actual fetch handler — used to render request/response IO inline.
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
 * Binary envelopes go through the core decryptor; legacy values remain
 * unchanged for the generic hydrator.
 *
 * Without a resolver (no --decrypt flag), encrypted fields pass
 * through as Uint8Array and are replaced with EncryptedDataRef in post-processing.
 */
async function maybeDecryptFields<T>(
  resource: T,
  resolveKey?: (runId: string) => Promise<Uint8Array | undefined>
): Promise<T> {
  if (!resolveKey || !resource || typeof resource !== 'object') return resource;

  const source = resource as Record<string, unknown>;
  if (typeof source.runId !== 'string') return resource;

  const result = { ...source };

  try {
    const rawKey = await resolveKey(source.runId);
    // Resolve the full key capability so `--decrypt` can open sealed
    // ('encp') payloads that other runs wrote to this one, not just the
    // run's own symmetric ('encr') payloads.
    const { deriveRunPayloadKeys } = await import(
      '@workflow/core/serialization'
    );
    const k = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;

    // Decrypt input/output/error fields (WorkflowRun, Step)
    result.input = await decryptPayload(result.input, k);
    result.output = await decryptPayload(result.output, k);
    result.error = await decryptPayload(result.error, k);

    // Decrypt metadata field (Hook)
    result.metadata = await decryptPayload(result.metadata, k);

    // Decrypt eventData fields (Event)
    if (result.eventData && typeof result.eventData === 'object') {
      const eventData = {
        ...(result.eventData as Record<string, unknown>),
      };
      const eventType =
        typeof result.eventType === 'string' ? result.eventType : '';
      for (const field of getEventDataRefFields(eventType)) {
        eventData[field] = await decryptPayload(eventData[field], k);
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
    logger.warn(`Decryption failed for resource ${source.runId}: ${message}`);
  }

  return result as T;
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
    const eventType =
      typeof result.eventType === 'string' ? result.eventType : '';
    for (const key of getEventDataRefFields(eventType)) {
      ed[key] = toDisplayRef(ed[key]);
    }
    result.eventData = ed;
  }

  return result as T;
}

/**
 * Hydrate the serialized data fields of a resource for CLI display.
 *
 * Without `resolveKey` (the default / no --decrypt flag), encrypted
 * fields are shown as styled "🔒 Encrypted" placeholders via EncryptedDataRef.
 *
 * When `resolveKey` is provided (--decrypt flag), encrypted fields
 * are decrypted before hydration so the actual user data is displayed.
 */
export async function hydrateResourceIO<
  T extends {
    stepId?: string;
    hookId?: string;
    eventId?: string;
    eventType?: string;
    input?: unknown;
    output?: unknown;
    metadata?: unknown;
    eventData?: unknown;
    executionContext?: unknown;
  },
>(
  resource: T,
  resolveKey?: (runId: string) => Promise<Uint8Array | undefined>
): Promise<T> {
  // Pre-process: decrypt any encrypted fields when a resolver is provided
  const preprocessed = await maybeDecryptFields(resource, resolveKey);
  const hydrated = hydrateResourceIOGeneric(preprocessed, getRevivers()) as T;
  // Post-process: swap encrypted Uint8Arrays and expired stubs for CLI-styled objects
  return replaceEncryptedAndExpiredWithRef(hydrated);
}
