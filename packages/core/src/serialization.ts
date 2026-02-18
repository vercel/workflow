import { WorkflowRuntimeError } from '@workflow/errors';
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde';

import { DevalueError, parse, stringify, unflatten } from 'devalue';
import { monotonicFactory } from 'ulid';
import { getSerializationClass } from './class-serialization.js';
import {
  createFlushableState,
  flushablePipe,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';
import { runtimeLogger } from './logger.js';
import { getStepFunction } from './private.js';
import { getWorld } from './runtime/world.js';
import { contextStorage } from './step/context-storage.js';
import {
  BODY_INIT_SYMBOL,
  STABLE_ULID,
  STREAM_NAME_SYMBOL,
  STREAM_TYPE_SYMBOL,
  WEBHOOK_RESPONSE_WRITABLE,
} from './symbols.js';

// ============================================================================
// Serialization Format Prefix System
// ============================================================================
//
// All serialized payloads are prefixed with a 4-byte format identifier that
// allows the client to determine how to decode the payload. This enables:
//
// 1. Self-describing payloads - The World layer is agnostic to serialization format
// 2. Gradual migration - Old runs keep working, new runs can use new formats
// 3. Composability - Encryption can wrap any format (e.g., "encr" wrapping "devl")
// 4. Debugging - Raw data inspection immediately reveals the format
//
// Format: [4 bytes: format identifier][payload]
//
// The 4-character prefix convention matches other workflow IDs (wrun, step, wait, etc.)
//
// Current formats:
// - "devl" - devalue stringify/parse with TextEncoder/TextDecoder (current default)
//
// Future formats (reserved):
// - "cbor" - CBOR binary serialization
// - "encr" - Encrypted payload (inner payload has its own format prefix)

/**
 * Known serialization format identifiers.
 * Each format ID is exactly 4 ASCII characters, matching the convention
 * used for other workflow IDs (wrun, step, wait, etc.)
 */
export const SerializationFormat = {
  /** devalue stringify/parse with TextEncoder/TextDecoder */
  DEVALUE_V1: 'devl',
} as const;

export type SerializationFormatType =
  (typeof SerializationFormat)[keyof typeof SerializationFormat];

/** Length of the format prefix in bytes */
const FORMAT_PREFIX_LENGTH = 4;

/** TextEncoder instance for format prefix encoding */
const formatEncoder = new TextEncoder();

/** TextDecoder instance for format prefix decoding */
const formatDecoder = new TextDecoder();

/**
 * Encode a payload with a format prefix.
 *
 * @param format - The format identifier (must be exactly 4 ASCII characters)
 * @param payload - The serialized payload bytes
 * @returns A new Uint8Array with format prefix prepended
 */
export function encodeWithFormatPrefix(
  format: SerializationFormatType,
  payload: Uint8Array | unknown
): Uint8Array | unknown {
  if (!(payload instanceof Uint8Array)) {
    return payload;
  }

  const prefixBytes = formatEncoder.encode(format);
  if (prefixBytes.length !== FORMAT_PREFIX_LENGTH) {
    throw new Error(
      `Format identifier must be exactly ${FORMAT_PREFIX_LENGTH} ASCII characters, got "${format}" (${prefixBytes.length} bytes)`
    );
  }

  const result = new Uint8Array(FORMAT_PREFIX_LENGTH + payload.length);
  result.set(prefixBytes, 0);
  result.set(payload, FORMAT_PREFIX_LENGTH);
  return result;
}

/**
 * Decode a format-prefixed payload.
 *
 * @param data - The format-prefixed data
 * @returns An object with the format identifier and payload
 * @throws Error if the data is too short or has an unknown format
 */
export function decodeFormatPrefix(data: Uint8Array | unknown): {
  format: SerializationFormatType;
  payload: Uint8Array;
} {
  // Compat for legacy specVersion 1 runs that don't have a format prefix,
  // and don't have a binary payload
  if (!(data instanceof Uint8Array)) {
    return {
      format: SerializationFormat.DEVALUE_V1,
      payload: new TextEncoder().encode(JSON.stringify(data)),
    };
  }

  if (data.length < FORMAT_PREFIX_LENGTH) {
    throw new Error(
      `Data too short to contain format prefix: expected at least ${FORMAT_PREFIX_LENGTH} bytes, got ${data.length}`
    );
  }

  const prefixBytes = data.subarray(0, FORMAT_PREFIX_LENGTH);
  const format = formatDecoder.decode(prefixBytes);

  // Validate the format is known
  const knownFormats = Object.values(SerializationFormat) as string[];
  if (!knownFormats.includes(format)) {
    throw new Error(
      `Unknown serialization format: "${format}". Known formats: ${knownFormats.join(', ')}`
    );
  }

  const payload = data.subarray(FORMAT_PREFIX_LENGTH);
  return { format: format as SerializationFormatType, payload };
}

/**
 * Default ULID generator for contexts where VM's seeded `stableUlid` isn't available.
 * Used as a fallback when serializing streams outside the workflow VM context
 * (e.g., when starting a workflow or handling step return values).
 */
const defaultUlid = monotonicFactory();

/**
 * Format a serialization error with context about what failed.
 * Extracts path, value, and reason from devalue's DevalueError when available.
 * Logs the problematic value to the console for better debugging.
 */
function formatSerializationError(context: string, error: unknown): string {
  // Use "returning" for return values, "passing" for arguments/inputs
  const verb = context.includes('return value') ? 'returning' : 'passing';

  // Build the error message with path info if available from DevalueError
  let message = `Failed to serialize ${context}`;
  if (error instanceof DevalueError && error.path) {
    message += ` at path "${error.path}"`;
  }
  message += `. Ensure you're ${verb} serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`;

  // Log the problematic value for debugging
  if (error instanceof DevalueError && error.value !== undefined) {
    runtimeLogger.error('Serialization failed', {
      context,
      problematicValue: error.value,
    });
  }

  return message;
}

/**
 * Detect if a readable stream is a byte stream.
 *
 * @param stream
 * @returns `"bytes"` if the stream is a byte stream, `undefined` otherwise
 */
export function getStreamType(stream: ReadableStream): 'bytes' | undefined {
  try {
    const reader = stream.getReader({ mode: 'byob' });
    reader.releaseLock();
    return 'bytes';
  } catch {}
}

/**
 * Frame format for stream chunks:
 *   [4-byte big-endian length][format-prefixed payload]
 *
 * Each chunk is independently framed so the deserializer can find
 * chunk boundaries even when multiple chunks are concatenated or
 * split across transport reads.
 */
const FRAME_HEADER_SIZE = 4;

export function getSerializeStream(
  reducers: Reducers
): TransformStream<any, Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new TransformStream<any, Uint8Array>({
    transform(chunk, controller) {
      try {
        const serialized = stringify(chunk, reducers);
        const payload = encoder.encode(serialized);
        const prefixed = encodeWithFormatPrefix(
          SerializationFormat.DEVALUE_V1,
          payload
        ) as Uint8Array;

        // Write length-prefixed frame: [4-byte length][prefixed data]
        const frame = new Uint8Array(FRAME_HEADER_SIZE + prefixed.length);
        new DataView(frame.buffer).setUint32(0, prefixed.length, false);
        frame.set(prefixed, FRAME_HEADER_SIZE);
        controller.enqueue(frame);
      } catch (error) {
        controller.error(
          new WorkflowRuntimeError(
            formatSerializationError('stream chunk', error),
            { slug: 'serialization-failed', cause: error }
          )
        );
      }
    },
  });
  return stream;
}

export function getDeserializeStream(
  revivers: Revivers
): TransformStream<Uint8Array, any> {
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);

  function appendToBuffer(data: Uint8Array) {
    const newBuffer = new Uint8Array(buffer.length + data.length);
    newBuffer.set(buffer, 0);
    newBuffer.set(data, buffer.length);
    buffer = newBuffer;
  }

  function processFrames(controller: TransformStreamDefaultController<any>) {
    // Try to extract complete length-prefixed frames
    while (buffer.length >= FRAME_HEADER_SIZE) {
      const frameLength = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
      ).getUint32(0, false);

      if (buffer.length < FRAME_HEADER_SIZE + frameLength) {
        break; // Incomplete frame, wait for more data
      }

      const frameData = buffer.slice(
        FRAME_HEADER_SIZE,
        FRAME_HEADER_SIZE + frameLength
      );
      buffer = buffer.slice(FRAME_HEADER_SIZE + frameLength);

      const { format, payload } = decodeFormatPrefix(frameData);
      if (format === SerializationFormat.DEVALUE_V1) {
        const text = decoder.decode(payload);
        controller.enqueue(parse(text, revivers));
      }
    }
  }

  const stream = new TransformStream<Uint8Array, any>({
    transform(chunk, controller) {
      // First, try to detect if this is length-prefixed framed data
      // by checking if the first 4 bytes form a plausible length.
      if (buffer.length === 0 && chunk.length >= FRAME_HEADER_SIZE) {
        const possibleLength = new DataView(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength
        ).getUint32(0, false);
        if (
          possibleLength > 0 &&
          possibleLength < 100_000_000 // sanity check: < 100MB
        ) {
          // Looks like framed data
          appendToBuffer(chunk);
          processFrames(controller);
          return;
        }
      } else if (buffer.length > 0) {
        // Already in framed mode (have buffered data)
        appendToBuffer(chunk);
        processFrames(controller);
        return;
      }

      // Legacy format: newline-delimited devalue text (no framing)
      const text = decoder.decode(chunk);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          controller.enqueue(parse(line, revivers));
        }
      }
    },
    flush(controller) {
      // Process any remaining framed data
      if (buffer.length > 0) {
        processFrames(controller);
      }
    },
  });
  return stream;
}

export class WorkflowServerReadableStream extends ReadableStream<Uint8Array> {
  #reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(name: string, startIndex?: number) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`"name" is required, got "${name}"`);
    }
    super({
      // @ts-expect-error Not sure why TypeScript is complaining about this
      type: 'bytes',

      pull: async (controller) => {
        let reader = this.#reader;
        if (!reader) {
          const world = getWorld();
          const stream = await world.readFromStream(name, startIndex);
          reader = this.#reader = stream.getReader();
        }
        if (!reader) {
          controller.error(new Error('Failed to get reader'));
          return;
        }

        const result = await reader.read();
        if (result.done) {
          this.#reader = undefined;
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      },
    });
  }
}

/**
 * Default flush interval in milliseconds for buffered stream writes.
 * Chunks are accumulated and flushed together to reduce network overhead.
 */
const STREAM_FLUSH_INTERVAL_MS = 10;

export class WorkflowServerWritableStream extends WritableStream<Uint8Array> {
  constructor(name: string, runId: string) {
    if (typeof runId !== 'string') {
      throw new Error(`"runId" must be a string, got "${typeof runId}"`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`"name" is required, got "${name}"`);
    }
    const world = getWorld();

    // Buffering state for batched writes
    let buffer: Uint8Array[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushPromise: Promise<void> | null = null;

    const flush = async (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      if (buffer.length === 0) return;

      // Copy chunks to flush, but don't clear buffer until write succeeds
      // This prevents data loss if the write operation fails
      const chunksToFlush = buffer.slice();

      // Use writeToStreamMulti if available for batch writes
      if (
        typeof world.writeToStreamMulti === 'function' &&
        chunksToFlush.length > 1
      ) {
        await world.writeToStreamMulti(name, runId, chunksToFlush);
      } else {
        // Fall back to sequential writes
        for (const chunk of chunksToFlush) {
          await world.writeToStream(name, runId, chunk);
        }
      }

      // Only clear buffer after successful write to prevent data loss
      buffer = [];
    };

    const scheduleFlush = (): void => {
      if (flushTimer) return; // Already scheduled

      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPromise = flush();
      }, STREAM_FLUSH_INTERVAL_MS);
    };

    super({
      async write(chunk) {
        // Wait for any in-progress flush to complete before adding to buffer
        if (flushPromise) {
          await flushPromise;
          flushPromise = null;
        }

        buffer.push(chunk);
        scheduleFlush();
      },
      async close() {
        // Wait for any in-progress flush to complete
        if (flushPromise) {
          await flushPromise;
          flushPromise = null;
        }

        // Flush any remaining buffered chunks
        await flush();

        await world.closeStream(name, runId);
      },
      abort() {
        // Clean up timer to prevent leaks
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        // Discard buffered chunks - they won't be written
        buffer = [];
      },
    });
  }
}

// Types that need specialized handling when serialized/deserialized
// ! If a type is added here, it MUST also be added to the `Serializable` type in `schemas.ts`
export interface SerializableSpecial {
  ArrayBuffer: string; // base64 string
  BigInt: string; // string representation of bigint
  BigInt64Array: string; // base64 string
  BigUint64Array: string; // base64 string
  Date: string; // ISO string
  Float32Array: string; // base64 string
  Float64Array: string; // base64 string
  Error: Record<string, any>;
  Headers: [string, string][];
  Int8Array: string; // base64 string
  Int16Array: string; // base64 string
  Int32Array: string; // base64 string
  Map: [any, any][];
  ReadableStream:
    | { name: string; type?: 'bytes'; startIndex?: number }
    | { bodyInit: any };
  RegExp: { source: string; flags: string };
  Request: {
    method: string;
    url: string;
    headers: Headers;
    body: Request['body'];
    duplex: Request['duplex'];

    // This is specifically for the `RequestWithResponse` type which is used for webhooks
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
  /**
   * Custom serialized class instance.
   * The class must have a `classId` property and be registered for deserialization.
   */
  Instance: {
    classId: string; // Unique identifier for the class (used for lookup during deserialization)
    data: unknown; // The serialized instance data
  };
  Set: any[];
  StepFunction: {
    stepId: string;
    closureVars?: Record<string, any>;
  };
  URL: string;
  URLSearchParams: string;
  Uint8Array: string; // base64 string
  Uint8ClampedArray: string; // base64 string
  Uint16Array: string; // base64 string
  Uint32Array: string; // base64 string
  WritableStream: { name: string };
}

type Reducers = {
  [K in keyof SerializableSpecial]: (
    value: any
  ) => SerializableSpecial[K] | false;
};

type Revivers = {
  [K in keyof SerializableSpecial]: (value: SerializableSpecial[K]) => any;
};

function revive(str: string) {
  // biome-ignore lint/security/noGlobalEval: Eval is safe here - we are only passing value from `devalue.stringify()`
  // biome-ignore lint/complexity/noCommaOperator: This is how you do global scope eval
  return (0, eval)(`(${str})`);
}

function getCommonReducers(global: Record<string, any> = globalThis) {
  const abToBase64 = (
    value: ArrayBufferLike,
    offset: number,
    length: number
  ) => {
    // Avoid returning falsy value for zero-length buffers
    if (length === 0) return '.';
    // Create a proper copy to avoid ArrayBuffer detachment issues
    // Buffer.from(ArrayBuffer, offset, length) creates a view, not a copy
    const uint8 = new Uint8Array(value, offset, length);
    return Buffer.from(uint8).toString('base64');
  };
  const viewToBase64 = (value: ArrayBufferView) =>
    abToBase64(value.buffer, value.byteOffset, value.byteLength);

  return {
    ArrayBuffer: (value) =>
      value instanceof global.ArrayBuffer &&
      abToBase64(value, 0, value.byteLength),
    BigInt: (value) => typeof value === 'bigint' && value.toString(),
    BigInt64Array: (value) =>
      value instanceof global.BigInt64Array && viewToBase64(value),
    BigUint64Array: (value) =>
      value instanceof global.BigUint64Array && viewToBase64(value),
    Date: (value) => {
      if (!(value instanceof global.Date)) return false;
      const valid = !Number.isNaN(value.getDate());
      // Note: "." is to avoid returning a falsy value when the date is invalid
      return valid ? value.toISOString() : '.';
    },
    Error: (value) => {
      if (!(value instanceof global.Error)) return false;
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    },
    Float32Array: (value) =>
      value instanceof global.Float32Array && viewToBase64(value),
    Float64Array: (value) =>
      value instanceof global.Float64Array && viewToBase64(value),
    Headers: (value) => value instanceof global.Headers && Array.from(value),
    Int8Array: (value) =>
      value instanceof global.Int8Array && viewToBase64(value),
    Int16Array: (value) =>
      value instanceof global.Int16Array && viewToBase64(value),
    Int32Array: (value) =>
      value instanceof global.Int32Array && viewToBase64(value),
    Map: (value) => value instanceof global.Map && Array.from(value),
    RegExp: (value) =>
      value instanceof global.RegExp && {
        source: value.source,
        flags: value.flags,
      },
    Request: (value) => {
      if (!(value instanceof global.Request)) return false;
      const data: SerializableSpecial['Request'] = {
        method: value.method,
        url: value.url,
        headers: value.headers,
        body: value.body,
        duplex: value.duplex,
      };
      const responseWritable = value[WEBHOOK_RESPONSE_WRITABLE];
      if (responseWritable) {
        data.responseWritable = responseWritable;
      }
      return data;
    },
    Response: (value) => {
      if (!(value instanceof global.Response)) return false;
      return {
        type: value.type,
        url: value.url,
        status: value.status,
        statusText: value.statusText,
        headers: value.headers,
        body: value.body,
        redirected: value.redirected,
      };
    },
    Class: (value) => {
      // Check if this is a class constructor with a classId property
      // (set by the SWC plugin for classes with static step/workflow methods)
      if (typeof value !== 'function') return false;
      const classId = (value as any).classId;
      if (typeof classId !== 'string') return false;
      return { classId };
    },
    Instance: (value) => {
      // Check if this is an instance of a class with custom serialization
      if (value === null || typeof value !== 'object') return false;
      const cls = value.constructor;
      if (!cls || typeof cls !== 'function') return false;

      // Check if the class has a static WORKFLOW_SERIALIZE method
      const serialize = cls[WORKFLOW_SERIALIZE];
      if (typeof serialize !== 'function') {
        return false;
      }

      // Get the classId from the static class property (set by SWC plugin)
      const classId = cls.classId;
      if (typeof classId !== 'string') {
        throw new Error(
          `Class "${cls.name}" with ${String(WORKFLOW_SERIALIZE)} must have a static "classId" property.`
        );
      }

      // Serialize the instance using the custom serializer
      const data = serialize.call(cls, value);
      return { classId, data };
    },
    Set: (value) => value instanceof global.Set && Array.from(value),
    StepFunction: (value) => {
      if (typeof value !== 'function') return false;
      const stepId = (value as any).stepId;
      if (typeof stepId !== 'string') return false;

      // Check if the step function has closure variables
      const closureVarsFn = (value as any).__closureVarsFn;
      if (closureVarsFn && typeof closureVarsFn === 'function') {
        // Invoke the closure variables function and serialize along with stepId
        const closureVars = closureVarsFn();
        return { stepId, closureVars };
      }

      // No closure variables - return object with just stepId
      return { stepId };
    },
    URL: (value) => value instanceof global.URL && value.href,
    URLSearchParams: (value) => {
      if (!(value instanceof global.URLSearchParams)) return false;

      // Avoid returning a falsy value when the URLSearchParams is empty
      if (value.size === 0) return '.';

      return String(value);
    },
    Uint8Array: (value) =>
      value instanceof global.Uint8Array && viewToBase64(value),
    Uint8ClampedArray: (value) =>
      value instanceof global.Uint8ClampedArray && viewToBase64(value),
    Uint16Array: (value) =>
      value instanceof global.Uint16Array && viewToBase64(value),
    Uint32Array: (value) =>
      value instanceof global.Uint32Array && viewToBase64(value),
  } as const satisfies Partial<Reducers>;
}

/**
 * Reducers for serialization boundary from the client side, passing arguments
 * to the workflow handler.
 *
 * @param global
 * @param ops
 * @returns
 */
export function getExternalReducers(
  global: Record<string, any> = globalThis,
  ops: Promise<void>[],
  runId: string
): Reducers {
  return {
    ...getCommonReducers(global),

    ReadableStream: (value) => {
      if (!(value instanceof global.ReadableStream)) return false;

      // Stream must not be locked when passing across execution boundary
      if (value.locked) {
        throw new Error('ReadableStream is locked');
      }

      const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
      const name = `strm_${streamId}`;
      const type = getStreamType(value);

      const writable = new WorkflowServerWritableStream(name, runId);
      if (type === 'bytes') {
        ops.push(value.pipeTo(writable));
      } else {
        ops.push(
          value
            .pipeThrough(
              getSerializeStream(getExternalReducers(global, ops, runId))
            )
            .pipeTo(writable)
        );
      }

      const s: SerializableSpecial['ReadableStream'] = { name };
      if (type) s.type = type;
      return s;
    },

    WritableStream: (value) => {
      if (!(value instanceof global.WritableStream)) return false;

      const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
      const name = `strm_${streamId}`;

      const readable = new WorkflowServerReadableStream(name);
      ops.push(readable.pipeTo(value));

      return { name };
    },
  };
}

/**
 * Reducers for serialization boundary from within the workflow execution
 * environment, passing return value to the client side and into step arguments.
 *
 * @param global
 * @returns
 */
export function getWorkflowReducers(
  global: Record<string, any> = globalThis
): Reducers {
  return {
    ...getCommonReducers(global),

    // Readable/Writable streams from within the workflow execution environment
    // are simply "handles" that can be passed around to other steps.
    ReadableStream: (value) => {
      if (!(value instanceof global.ReadableStream)) return false;

      // Check if this is a fake stream storing BodyInit from Request/Response constructor
      const bodyInit = value[BODY_INIT_SYMBOL];
      if (bodyInit !== undefined) {
        // This is a fake stream - serialize the BodyInit directly
        // devalue will handle serializing strings, Uint8Array, etc.
        return { bodyInit };
      }

      const name = value[STREAM_NAME_SYMBOL];
      if (!name) {
        throw new Error('ReadableStream `name` is not set');
      }
      const s: SerializableSpecial['ReadableStream'] = { name };
      const type = value[STREAM_TYPE_SYMBOL];
      if (type) s.type = type;
      return s;
    },
    WritableStream: (value) => {
      if (!(value instanceof global.WritableStream)) return false;
      const name = value[STREAM_NAME_SYMBOL];
      if (!name) {
        throw new Error('WritableStream `name` is not set');
      }
      return { name };
    },
  };
}

/**
 * Reducers for serialization boundary from within the step execution
 * environment, passing return value to the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 * @returns
 */
function getStepReducers(
  global: Record<string, any> = globalThis,
  ops: Promise<void>[],
  runId: string
): Reducers {
  return {
    ...getCommonReducers(global),

    ReadableStream: (value) => {
      if (!(value instanceof global.ReadableStream)) return false;

      // Stream must not be locked when passing across execution boundary
      if (value.locked) {
        throw new Error('ReadableStream is locked');
      }

      // Check if the stream already has the name symbol set, in which case
      // it's already being sunk to the server and we can just return the
      // name and type.
      let name = value[STREAM_NAME_SYMBOL];
      let type = value[STREAM_TYPE_SYMBOL];

      if (!name) {
        if (!runId) {
          throw new Error(
            'ReadableStream cannot be serialized without a valid runId'
          );
        }

        const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
        name = `strm_${streamId}`;
        type = getStreamType(value);

        const writable = new WorkflowServerWritableStream(name, runId);
        if (type === 'bytes') {
          ops.push(value.pipeTo(writable));
        } else {
          ops.push(
            value
              .pipeThrough(
                getSerializeStream(getStepReducers(global, ops, runId))
              )
              .pipeTo(writable)
          );
        }
      }

      const s: SerializableSpecial['ReadableStream'] = { name };
      if (type) s.type = type;
      return s;
    },

    WritableStream: (value) => {
      if (!(value instanceof global.WritableStream)) return false;

      let name = value[STREAM_NAME_SYMBOL];
      if (!name) {
        if (!runId) {
          throw new Error(
            'WritableStream cannot be serialized without a valid runId'
          );
        }

        const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
        name = `strm_${streamId}`;
        ops.push(
          new WorkflowServerReadableStream(name)
            .pipeThrough(
              getDeserializeStream(getStepRevivers(global, ops, runId))
            )
            .pipeTo(value)
        );
      }

      return { name };
    },
  };
}

export function getCommonRevivers(global: Record<string, any> = globalThis) {
  function reviveArrayBuffer(value: string) {
    // Handle sentinel value for zero-length buffers
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
    Class: (value) => {
      const classId = value.classId;
      // Pass the global object to support VM contexts where classes are registered
      // on the VM's global rather than the host's globalThis
      const cls = getSerializationClass(classId, global);
      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }
      return cls;
    },
    Instance: (value) => {
      const classId = value.classId;
      const data = value.data;

      // Look up the class by classId from the registry
      // Pass the global object to support VM contexts where classes are registered
      // on the VM's global rather than the host's globalThis
      const cls = getSerializationClass(classId, global);

      if (!cls) {
        throw new Error(
          `Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`
        );
      }

      // Get the deserializer from the class
      const deserialize = (cls as any)[WORKFLOW_DESERIALIZE];
      if (typeof deserialize !== 'function') {
        throw new Error(
          `Class "${classId}" does not have a static ${String(WORKFLOW_DESERIALIZE)} method.`
        );
      }

      // Deserialize the instance using the custom deserializer
      return deserialize.call(cls, data);
    },
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
  } as const satisfies Partial<Revivers>;
}

/**
 * Revivers for deserialization boundary from the client side,
 * receiving the return value from the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 */
export function getExternalRevivers(
  global: Record<string, any> = globalThis,
  ops: Promise<void>[],
  runId: string
): Revivers {
  return {
    ...getCommonRevivers(global),

    // StepFunction should not be returned from workflows to clients
    StepFunction: () => {
      throw new Error(
        'Step functions cannot be deserialized in client context. Step functions should not be returned from workflows.'
      );
    },

    Request: (value) => {
      return new global.Request(value.url, {
        method: value.method,
        headers: new global.Headers(value.headers),
        body: value.body,
        duplex: value.duplex,
      });
    },
    Response: (value) => {
      // Note: Response constructor only accepts status, statusText, and headers
      // The type, url, and redirected properties are read-only and set by the constructor
      return new global.Response(value.body, {
        status: value.status,
        statusText: value.statusText,
        headers: new global.Headers(value.headers),
      });
    },
    ReadableStream: (value) => {
      // If this has bodyInit, it came from a Response constructor
      // Convert it to a REAL stream now that we're outside the workflow
      if ('bodyInit' in value) {
        const bodyInit = value.bodyInit;
        // Use the native Response constructor to properly convert BodyInit to ReadableStream
        const response = new global.Response(bodyInit);
        return response.body;
      }

      const readable = new WorkflowServerReadableStream(
        value.name,
        value.startIndex
      );
      if (value.type === 'bytes') {
        // For byte streams, use flushable pipe with lock polling
        const state = createFlushableState();
        ops.push(state.promise);

        // Create an identity transform to give the user a readable
        const { readable: userReadable, writable } =
          new global.TransformStream();

        // Start the flushable pipe in the background
        flushablePipe(readable, writable, state).catch(() => {
          // Errors are handled via state.reject
        });

        // Start polling to detect when user releases lock
        pollReadableLock(userReadable, state);

        return userReadable;
      } else {
        const transform = getDeserializeStream(
          getExternalRevivers(global, ops, runId)
        );
        const state = createFlushableState();
        ops.push(state.promise);

        // Start the flushable pipe in the background
        flushablePipe(readable, transform.writable, state).catch(() => {
          // Errors are handled via state.reject
        });

        // Start polling to detect when user releases lock
        pollReadableLock(transform.readable, state);

        return transform.readable;
      }
    },
    WritableStream: (value) => {
      const serialize = getSerializeStream(
        getExternalReducers(global, ops, runId)
      );
      const serverWritable = new WorkflowServerWritableStream(
        value.name,
        runId
      );

      // Create flushable state for this stream
      const state = createFlushableState();
      ops.push(state.promise);

      // Start the flushable pipe in the background
      flushablePipe(serialize.readable, serverWritable, state).catch(() => {
        // Errors are handled via state.reject
      });

      // Start polling to detect when user releases lock
      pollWritableLock(serialize.writable, state);

      return serialize.writable;
    },
  };
}

/**
 * Revivers for deserialization boundary from within the workflow execution
 * environment, receiving arguments from the client side, and return values
 * from the steps.
 *
 * @param global
 * @returns
 */
export function getWorkflowRevivers(
  global: Record<string, any> = globalThis
): Revivers {
  // Get the useStep function from the VM's globalThis
  // This is set up by the workflow runner in workflow.ts
  // Use Symbol.for directly to access the symbol on the global object
  const useStep = (global as any)[Symbol.for('WORKFLOW_USE_STEP')] as
    | ((
        stepId: string,
        closureVarsFn?: () => Record<string, unknown>
      ) => (...args: unknown[]) => Promise<unknown>)
    | undefined;

  return {
    ...getCommonRevivers(global),
    // StepFunction reviver for workflow context - returns useStep wrapper
    // This allows step functions passed as arguments to start() to be called directly
    // from workflow code, just like step functions defined in the same file
    StepFunction: (value) => {
      const stepId = value.stepId;
      const closureVars = value.closureVars;

      if (!useStep) {
        throw new Error(
          'WORKFLOW_USE_STEP not found on global object. Step functions cannot be deserialized outside workflow context.'
        );
      }

      if (closureVars) {
        // For step functions with closure variables, create a wrapper that provides them
        return useStep(stepId, () => closureVars);
      }
      return useStep(stepId);
    },
    Request: (value) => {
      Object.setPrototypeOf(value, global.Request.prototype);
      const responseWritable = value.responseWritable;
      if (responseWritable) {
        (value as any)[WEBHOOK_RESPONSE_WRITABLE] = responseWritable;
        delete value.responseWritable;
        (value as any).respondWith = () => {
          throw new Error(
            '`respondWith()` must be called from within a step function'
          );
        };
      }
      return value;
    },
    Response: (value) => {
      Object.setPrototypeOf(value, global.Response.prototype);
      return value;
    },
    ReadableStream: (value) => {
      // Check if this is a BodyInit that should be wrapped in a fake stream
      if ('bodyInit' in value) {
        // Recreate the fake stream with the BodyInit
        return Object.create(global.ReadableStream.prototype, {
          [BODY_INIT_SYMBOL]: {
            value: value.bodyInit,
            writable: false,
          },
        });
      }

      // Regular stream handling
      return Object.create(global.ReadableStream.prototype, {
        [STREAM_NAME_SYMBOL]: {
          value: value.name,
          writable: false,
        },
        [STREAM_TYPE_SYMBOL]: {
          value: value.type,
          writable: false,
        },
      });
    },
    WritableStream: (value) => {
      return Object.create(global.WritableStream.prototype, {
        [STREAM_NAME_SYMBOL]: {
          value: value.name,
          writable: false,
        },
      });
    },
  };
}

/**
 * Revivers for deserialization boundary from within the step execution
 * environment, receiving arguments from the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 * @returns
 */
function getStepRevivers(
  global: Record<string, any> = globalThis,
  ops: Promise<void>[],
  runId: string
): Revivers {
  return {
    ...getCommonRevivers(global),

    // StepFunction reviver for step context - returns raw step function
    // with closure variable support via AsyncLocalStorage
    StepFunction: (value) => {
      const stepId = value.stepId;
      const closureVars = value.closureVars;

      const stepFn = getStepFunction(stepId);
      if (!stepFn) {
        throw new Error(
          `Step function "${stepId}" not found. Make sure the step function is registered.`
        );
      }

      // If closure variables were serialized, return a wrapper function
      // that sets up AsyncLocalStorage context when invoked
      if (closureVars) {
        const wrappedStepFn = ((...args: any[]) => {
          // Get the current context from AsyncLocalStorage
          const currentContext = contextStorage.getStore();

          if (!currentContext) {
            throw new Error(
              'Cannot call step function with closure variables outside step context'
            );
          }

          // Create a new context with the closure variables merged in
          const newContext = {
            ...currentContext,
            closureVars,
          };

          // Run the step function with the new context that includes closure vars
          return contextStorage.run(newContext, () => stepFn(...args));
        }) as any;

        // Copy properties from original step function
        Object.defineProperty(wrappedStepFn, 'name', {
          value: stepFn.name,
        });
        Object.defineProperty(wrappedStepFn, 'stepId', {
          value: stepId,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        if (stepFn.maxRetries !== undefined) {
          wrappedStepFn.maxRetries = stepFn.maxRetries;
        }

        return wrappedStepFn;
      }

      return stepFn;
    },

    Request: (value) => {
      const responseWritable = value.responseWritable;
      const request = new global.Request(value.url, {
        method: value.method,
        headers: new global.Headers(value.headers),
        body: value.body,
        duplex: value.duplex,
      });
      if (responseWritable) {
        request.respondWith = async (response: Response) => {
          const writer = responseWritable.getWriter();
          await writer.write(response);
          await writer.close();
        };
      }
      return request;
    },
    Response: (value) => {
      // Note: Response constructor only accepts status, statusText, and headers
      // The type, url, and redirected properties are read-only and set by the constructor
      return new global.Response(value.body, {
        status: value.status,
        statusText: value.statusText,
        headers: new global.Headers(value.headers),
      });
    },
    ReadableStream: (value) => {
      // If this has bodyInit, it came from a Response constructor
      // Convert it to a REAL stream now that we're in the step environment
      if ('bodyInit' in value) {
        const bodyInit = value.bodyInit;
        // Use the native Response constructor to properly convert BodyInit to ReadableStream
        const response = new global.Response(bodyInit);
        return response.body;
      }

      const readable = new WorkflowServerReadableStream(value.name);
      if (value.type === 'bytes') {
        // For byte streams, use flushable pipe with lock polling
        const state = createFlushableState();
        ops.push(state.promise);

        // Create an identity transform to give the user a readable
        const { readable: userReadable, writable } =
          new global.TransformStream();

        // Start the flushable pipe in the background
        flushablePipe(readable, writable, state).catch(() => {
          // Errors are handled via state.reject
        });

        // Start polling to detect when user releases lock
        pollReadableLock(userReadable, state);

        return userReadable;
      } else {
        const transform = getDeserializeStream(
          getStepRevivers(global, ops, runId)
        );
        const state = createFlushableState();
        ops.push(state.promise);

        // Start the flushable pipe in the background
        flushablePipe(readable, transform.writable, state).catch(() => {
          // Errors are handled via state.reject
        });

        // Start polling to detect when user releases lock
        pollReadableLock(transform.readable, state);

        return transform.readable;
      }
    },
    WritableStream: (value) => {
      if (!runId) {
        throw new Error(
          'WritableStream cannot be revived without a valid runId'
        );
      }

      const serialize = getSerializeStream(getStepReducers(global, ops, runId));
      const serverWritable = new WorkflowServerWritableStream(
        value.name,
        runId
      );

      // Create flushable state for this stream
      const state = createFlushableState();
      ops.push(state.promise);

      // Start the flushable pipe in the background
      flushablePipe(serialize.readable, serverWritable, state).catch(() => {
        // Errors are handled via state.reject
      });

      // Start polling to detect when user releases lock
      pollWritableLock(serialize.writable, state);

      return serialize.writable;
    },
  };
}

/**
 * Called from the `start()` function to serialize the workflow arguments
 * into a format that can be saved to the database and then hydrated from
 * within the workflow execution environment.
 *
 * @param value - The workflow arguments to serialize
 * @param runId - The workflow run ID (used for stream serialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param ops - Array to collect pending async operations (e.g., stream uploads)
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateWorkflowArguments(
  value: unknown,
  runId: string,
  _key: Uint8Array | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  try {
    const str = stringify(value, getExternalReducers(global, ops, runId));
    if (v1Compat) {
      return revive(str);
    }
    const payload = new TextEncoder().encode(str);
    return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError('workflow arguments', error),
      { slug: 'serialization-failed', cause: error }
    );
  }
}

/**
 * Called from workflow execution environment to hydrate the workflow
 * arguments from the database at the start of workflow execution.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated value
 */
export async function hydrateWorkflowArguments(
  value: Uint8Array | unknown,
  _runId: string,
  _key: Uint8Array | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
) {
  if (!(value instanceof Uint8Array)) {
    return unflatten(value as any[], {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(value);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    const obj = parse(str, {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
    return obj;
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Called at the end of a completed workflow execution to serialize the
 * return value into a format that can be saved to the database.
 *
 * @param value - The workflow return value to serialize
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateWorkflowReturnValue(
  value: unknown,
  _runId: string,
  _key: Uint8Array | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  try {
    const str = stringify(value, getWorkflowReducers(global));
    if (v1Compat) {
      return revive(str);
    }
    const payload = new TextEncoder().encode(str);
    return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError('workflow return value', error),
      { slug: 'serialization-failed', cause: error }
    );
  }
}

/**
 * Called from the client side (i.e. the execution environment where
 * the workflow run was initiated from) to hydrate the workflow
 * return value of a completed workflow run.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - The workflow run ID (used for stream deserialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param ops - Array to collect pending async operations (e.g., stream downloads)
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated return value, ready to be consumed by the client
 */
export async function hydrateWorkflowReturnValue(
  value: Uint8Array | unknown,
  runId: string,
  _key: Uint8Array | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
) {
  if (!(value instanceof Uint8Array)) {
    return unflatten(value as any[], {
      ...getExternalRevivers(global, ops, runId),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(value);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    const obj = parse(str, {
      ...getExternalRevivers(global, ops, runId),
      ...extraRevivers,
    });
    return obj;
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Called from the workflow handler when a step is being created.
 * Dehydrates values from within the workflow execution environment
 * into a format that can be saved to the database.
 *
 * @param value - The step arguments to serialize
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateStepArguments(
  value: unknown,
  _runId: string,
  _key: Uint8Array | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  try {
    const str = stringify(value, getWorkflowReducers(global));
    if (v1Compat) {
      return revive(str);
    }
    const payload = new TextEncoder().encode(str);
    return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError('step arguments', error),
      { slug: 'serialization-failed', cause: error }
    );
  }
}

/**
 * Called from the step handler to hydrate the arguments of a step
 * from the database at the start of the step execution.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - The workflow run ID (used for stream deserialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param ops - Array to collect pending async operations (e.g., stream downloads)
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated value, ready to be consumed by the step user-code function
 */
export async function hydrateStepArguments(
  value: Uint8Array | unknown,
  runId: string,
  _key: Uint8Array | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
) {
  if (!(value instanceof Uint8Array)) {
    return unflatten(value as any[], {
      ...getStepRevivers(global, ops, runId),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(value);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    const obj = parse(str, {
      ...getStepRevivers(global, ops, runId),
      ...extraRevivers,
    });
    return obj;
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Called from the step handler when a step has completed.
 * Dehydrates values from within the step execution environment
 * into a format that can be saved to the database.
 *
 * @param value - The step return value to serialize
 * @param runId - The workflow run ID (used for stream serialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param ops - Array to collect pending async operations (e.g., stream uploads)
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateStepReturnValue(
  value: unknown,
  runId: string,
  _key: Uint8Array | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  try {
    const str = stringify(value, getStepReducers(global, ops, runId));
    if (v1Compat) {
      return revive(str);
    }
    const payload = new TextEncoder().encode(str);
    return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError('step return value', error),
      { slug: 'serialization-failed', cause: error }
    );
  }
}

/**
 * Called from the workflow handler when replaying the event log of a `step_completed` event.
 * Hydrates the return value of a step from the database.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated return value of a step, ready to be consumed by the workflow handler
 */
export async function hydrateStepReturnValue(
  value: Uint8Array | unknown,
  _runId: string,
  _key: Uint8Array | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
) {
  if (!(value instanceof Uint8Array)) {
    return unflatten(value as any[], {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(value);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    const obj = parse(str, {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
    return obj;
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}
