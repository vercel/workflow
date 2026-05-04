import { WorkflowRuntimeError } from '@workflow/errors';
import { parse, stringify } from 'devalue';
import { monotonicFactory } from 'ulid';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
} from './encryption.js';
import {
  createFlushableState,
  flushablePipe,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';
import { getStepFunction } from './private.js';
import { getWorld } from './runtime/world.js';
import * as clientModule from './serialization/client.js';
import {
  decrypt,
  type EncryptionKeyParam,
  encrypt,
} from './serialization/encryption.js';
import { formatSerializationError } from './serialization/errors.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  isEncrypted,
  peekFormatPrefix,
} from './serialization/format.js';
import {
  getClassReducers,
  getClassRevivers,
} from './serialization/reducers/class.js';
import {
  getCommonReducers,
  getCommonRevivers as getCommonReviversFromModule,
  revive,
} from './serialization/reducers/common.js';
import {
  getStepFunctionReducer,
  getStepFunctionReviver,
} from './serialization/reducers/step-function.js';
import * as stepModule from './serialization/step.js';
import {
  type FormatPrefix,
  isFormatPrefix,
  SerializationFormat,
} from './serialization/types.js';
import * as workflowModule from './serialization/workflow.js';
import { contextStorage } from './step/context-storage.js';
import {
  BODY_INIT_SYMBOL,
  STABLE_ULID,
  STREAM_NAME_SYMBOL,
  STREAM_TYPE_SYMBOL,
  WEBHOOK_RESPONSE_WRITABLE,
} from './symbols.js';

// Re-export types and utilities from the modular serialization modules
// so existing consumers of `@workflow/core/serialization` keep working.
export {
  SerializationFormat,
  type FormatPrefix,
  isFormatPrefix,
  encodeWithFormatPrefix,
  decodeFormatPrefix,
  peekFormatPrefix,
  isEncrypted,
  encrypt,
  decrypt,
  type EncryptionKeyParam,
};

// Re-export the legacy SerializationFormatType for backwards compatibility.
// New code should use FormatPrefix from './serialization/types.js'.
export type SerializationFormatType =
  (typeof SerializationFormat)[keyof typeof SerializationFormat];

/**
 * Default ULID generator for contexts where VM's seeded `stableUlid` isn't available.
 * Used as a fallback when serializing streams outside the workflow VM context
 * (e.g., when starting a workflow or handling step return values).
 */
const defaultUlid = monotonicFactory();

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
  reducers: Partial<Reducers>,
  cryptoKey: EncryptionKeyParam
): TransformStream<any, Uint8Array> {
  const encoder = new TextEncoder();
  // Resolve the key promise once on first use and cache the result.
  // Note: if the cryptoKey promise rejects (e.g., network error fetching
  // the derived key), the rejection won't surface until the first chunk
  // is processed — not at stream construction time.
  const keyState = { resolved: false, key: undefined as CryptoKey | undefined };
  const stream = new TransformStream<any, Uint8Array>({
    async transform(chunk, controller) {
      try {
        if (!keyState.resolved) {
          keyState.key = await cryptoKey;
          keyState.resolved = true;
        }
        const serialized = stringify(chunk, reducers);
        const payload = encoder.encode(serialized);
        let prefixed = encodeWithFormatPrefix(
          SerializationFormat.DEVALUE_V1,
          payload
        ) as Uint8Array;

        // Encrypt the frame payload if a key is provided.
        // The length header remains in the clear so the deserializer can
        // find frame boundaries regardless of transport chunking.
        if (keyState.key) {
          const encrypted = await aesGcmEncrypt(keyState.key, prefixed);
          prefixed = encodeWithFormatPrefix(
            SerializationFormat.ENCRYPTED,
            encrypted
          ) as Uint8Array;
        }

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
  revivers: Partial<Revivers>,
  cryptoKey: EncryptionKeyParam
): TransformStream<Uint8Array, any> {
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  // Resolve the key promise once on first use and cache the result.
  const keyState = { resolved: false, key: undefined as CryptoKey | undefined };

  function appendToBuffer(data: Uint8Array) {
    const newBuffer = new Uint8Array(buffer.length + data.length);
    newBuffer.set(buffer, 0);
    newBuffer.set(data, buffer.length);
    buffer = newBuffer;
  }

  async function processFrames(
    controller: TransformStreamDefaultController<any>
  ) {
    // Resolve the key promise once on first use and cache the result
    if (!keyState.resolved) {
      keyState.key = await cryptoKey;
      keyState.resolved = true;
    }

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

      let { format, payload } = decodeFormatPrefix(frameData);

      // If the frame payload is encrypted, decrypt it first to reveal
      // the inner format-prefixed data (e.g., 'devl' + serialized text),
      // then fall through to the normal deserialization path.
      if (format === SerializationFormat.ENCRYPTED) {
        if (!keyState.key) {
          controller.error(
            new WorkflowRuntimeError(
              'Encrypted stream data encountered but no encryption key is available. ' +
                'Encryption is not configured or no key was provided for this run.'
            )
          );
          return;
        }
        const decrypted = await aesGcmDecrypt(keyState.key, payload);
        ({ format, payload } = decodeFormatPrefix(decrypted));
      }

      if (format === SerializationFormat.DEVALUE_V1) {
        const text = decoder.decode(payload);
        controller.enqueue(parse(text, revivers));
      }
    }
  }

  const stream = new TransformStream<Uint8Array, any>({
    async transform(chunk, controller) {
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
          await processFrames(controller);
          return;
        }
      } else if (buffer.length > 0) {
        // Already in framed mode (have buffered data)
        appendToBuffer(chunk);
        await processFrames(controller);
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
    async flush(controller) {
      // Process any remaining framed data
      if (buffer.length > 0) {
        await processFrames(controller);
      }
    },
  });
  return stream;
}

export class WorkflowServerReadableStream extends ReadableStream<Uint8Array> {
  #reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(runId: string, name: string, startIndex?: number) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`"name" is required, got "${name}"`);
    }
    super({
      // @ts-expect-error Not sure why TypeScript is complaining about this
      type: 'bytes',

      pull: async (controller) => {
        let reader = this.#reader;
        if (!reader) {
          const world = await getWorld();
          const stream = await world.streams.get(runId, name, startIndex);
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
          // Forward raw bytes; encryption/decryption is handled at the
          // framing level by getSerializeStream/getDeserializeStream.
          controller.enqueue(result.value);
        }
      },
      cancel: async (reason) => {
        if (this.#reader) {
          await this.#reader.cancel(reason).catch(() => {});
          this.#reader = undefined;
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
  constructor(runId: string, name: string) {
    if (typeof runId !== 'string') {
      throw new Error(`"runId" must be a string, got "${typeof runId}"`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`"name" is required, got "${name}"`);
    }
    const worldPromise = getWorld();

    // Buffering state for batched writes
    // Encryption/decryption is handled at the framing level by
    // getSerializeStream/getDeserializeStream, not here.
    let buffer: Uint8Array[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushPromise: Promise<void> | null = null;
    let resolvedFlushIntervalMs: number | undefined;

    const flush = async (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      if (buffer.length === 0) return;

      // Copy chunks to flush, but don't clear buffer until write succeeds
      // This prevents data loss if the write operation fails
      const chunksToFlush = buffer.slice();

      const world = await worldPromise;
      // Cache the flush interval from the world on first use
      if (resolvedFlushIntervalMs === undefined) {
        resolvedFlushIntervalMs =
          world.streamFlushIntervalMs ?? STREAM_FLUSH_INTERVAL_MS;
      }
      // Use writeMulti if available for batch writes
      if (
        typeof world.streams.writeMulti === 'function' &&
        chunksToFlush.length > 1
      ) {
        await world.streams.writeMulti(runId, name, chunksToFlush);
      } else {
        // Fall back to sequential writes
        for (const chunk of chunksToFlush) {
          await world.streams.write(runId, name, chunk);
        }
      }

      // Only clear buffer after successful write to prevent data loss
      buffer = [];
    };

    /** Resolvers/rejectors waiting for the current scheduled flush */
    let flushWaiters: Array<{
      resolve: () => void;
      reject: (err: unknown) => void;
    }> = [];

    const scheduleFlush = (): void => {
      if (flushTimer) return; // Already scheduled

      flushTimer = setTimeout(() => {
        flushTimer = null;
        const currentWaiters = flushWaiters;
        flushWaiters = [];
        flushPromise = flush().then(
          () => {
            for (const w of currentWaiters) w.resolve();
          },
          (err) => {
            for (const w of currentWaiters) w.reject(err);
          }
        );
      }, resolvedFlushIntervalMs ?? STREAM_FLUSH_INTERVAL_MS);
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

        // Wait for the scheduled flush to complete so that callers
        // (like flushablePipe) know data has reached the server
        // before decrementing pendingOps. Without this, pendingOps
        // reaches 0 when the buffered write returns (instant), but
        // the 10ms flush timer hasn't fired yet.
        await new Promise<void>((resolve, reject) => {
          flushWaiters.push({ resolve, reject });
        });
      },
      async close() {
        // Wait for any in-progress flush to complete
        if (flushPromise) {
          await flushPromise;
          flushPromise = null;
        }

        // Flush any remaining buffered chunks
        await flush();

        const world = await worldPromise;
        await world.streams.close(runId, name);
      },
      abort(reason) {
        // Clean up timer to prevent leaks
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        // Discard buffered chunks - they won't be written
        buffer = [];
        // Reject any pending flushWaiters so the write() promises settle
        // and don't leak. Without this, write() hangs forever on an
        // unsettled promise because the cleared timer will never fire.
        const waiters = flushWaiters;
        flushWaiters = [];
        const abortError = reason ?? new Error('Stream aborted');
        for (const w of waiters) w.reject(abortError);
      },
    });
  }
}

// Re-export types from the modular serialization modules.
export type {
  Reducers,
  Revivers,
  SerializableSpecial,
} from './serialization/types.js';

// Import types locally for use within this file.
import type {
  Reducers,
  Revivers,
  SerializableSpecial,
} from './serialization/types.js';

// ---- Composed reducers ----
// Composes modular reducers (common, class, step-function) with
// mode-specific Request/Response/Stream reducers below.

/**
 * Base reducers shared across all serialization boundaries.
 * Composes: class + step-function + common reducers from the modular modules.
 */
function getAllBaseReducers(
  global: Record<string, any> = globalThis
): Partial<Reducers> {
  // Class/Instance MUST come before Error so that custom Error subclasses
  // with WORKFLOW_SERIALIZE take precedence (devalue uses first-match-wins).
  return {
    ...getClassReducers(),
    ...getStepFunctionReducer(),
    ...getCommonReducers(global),
    // Request and Response reducers are mode-specific and added by
    // getExternalReducers / getWorkflowReducers / getStepReducers below.
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
  };
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
  runId: string,
  cryptoKey: EncryptionKeyParam
): Partial<Reducers> {
  return {
    ...getAllBaseReducers(global),

    ReadableStream: (value) => {
      if (!(value instanceof global.ReadableStream)) return false;

      // Stream must not be locked when passing across execution boundary
      if (value.locked) {
        throw new Error('ReadableStream is locked');
      }

      const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
      const name = `strm_${streamId}`;
      const type = getStreamType(value);

      const writable = new WorkflowServerWritableStream(runId, name);
      if (type === 'bytes') {
        ops.push(value.pipeTo(writable));
      } else {
        ops.push(
          value
            .pipeThrough(
              getSerializeStream(
                getExternalReducers(global, ops, runId, cryptoKey),
                cryptoKey
              )
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

      const readable = new WorkflowServerReadableStream(runId, name);
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
): Partial<Reducers> {
  return {
    ...getAllBaseReducers(global),

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
  runId: string,
  cryptoKey: EncryptionKeyParam
): Partial<Reducers> {
  return {
    ...getAllBaseReducers(global),

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
        const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
        name = `strm_${streamId}`;
        type = getStreamType(value);

        const writable = new WorkflowServerWritableStream(runId, name);
        if (type === 'bytes') {
          ops.push(value.pipeTo(writable));
        } else {
          ops.push(
            value
              .pipeThrough(
                getSerializeStream(
                  getStepReducers(global, ops, runId, cryptoKey),
                  cryptoKey
                )
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
        const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
        name = `strm_${streamId}`;
        ops.push(
          new WorkflowServerReadableStream(runId, name)
            .pipeThrough(
              getDeserializeStream(
                getStepRevivers(global, ops, runId, cryptoKey),
                cryptoKey
              )
            )
            .pipeTo(value)
        );
      }

      return { name };
    },
  };
}

/**
 * Base revivers shared across all serialization boundaries.
 * Composes: class + common revivers from the modular modules.
 *
 * This is exported because serialization-format.ts and other files reference it.
 */
export function getCommonRevivers(global: Record<string, any> = globalThis) {
  return {
    ...getClassRevivers(global),
    ...getCommonReviversFromModule(global),
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
  runId: string,
  cryptoKey: EncryptionKeyParam
): Partial<Revivers> {
  return {
    ...getCommonRevivers(global),

    // StepFunction should not be returned from workflows to clients
    StepFunction: () => {
      throw new Error(
        'Step functions cannot be deserialized in client context. Step functions should not be returned from workflows.'
      );
    },

    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new Error(
            'Workflow functions cannot be called directly. Use start() to invoke them.'
          );
        },
        { workflowId: value.workflowId }
      ),

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
        runId,
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
          getExternalRevivers(global, ops, runId, cryptoKey),
          cryptoKey
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
        getExternalReducers(global, ops, runId, cryptoKey),
        cryptoKey
      );
      const serverWritable = new WorkflowServerWritableStream(
        runId,
        value.name
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
): Partial<Revivers> {
  return {
    ...getCommonRevivers(global),
    // StepFunction reviver for workflow context - uses the modular reviver
    // which calls WORKFLOW_USE_STEP from global to reconstruct step proxies
    ...getStepFunctionReviver(global),
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
    // Workflow function reviver for workflow context — returns a function-like
    // object with .workflowId that mimics what the SWC compiler produces,
    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new Error(
            'Workflow functions cannot be called directly. Use start() to invoke them.'
          );
        },
        { workflowId: value.workflowId }
      ),
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
  runId: string,
  cryptoKey: EncryptionKeyParam
): Partial<Revivers> {
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

    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new Error(
            'Workflow functions cannot be called directly. Use start() to invoke them.'
          );
        },
        { workflowId: value.workflowId }
      ),

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

      const readable = new WorkflowServerReadableStream(runId, value.name);
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
          getStepRevivers(global, ops, runId, cryptoKey),
          cryptoKey
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
        getStepReducers(global, ops, runId, cryptoKey),
        cryptoKey
      );
      const serverWritable = new WorkflowServerWritableStream(
        runId,
        value.name
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

// ============================================================================
// Encryption Helpers
// ============================================================================
// These delegate to the modular `encrypt`/`decrypt` from `./serialization/encryption.js`
// but are kept as named exports for backwards compatibility with existing consumers.

/**
 * Encrypt data if the world supports encryption.
 * Returns original data if encryption is not available.
 *
 * @deprecated Use `encrypt` from `./serialization/encryption.js` instead.
 */
export async function maybeEncrypt(
  data: Uint8Array,
  key: CryptoKey | undefined
): Promise<Uint8Array> {
  return (await encrypt(data, key)) as Uint8Array;
}

/**
 * Decrypt data if it has the 'encr' prefix.
 *
 * @deprecated Use `decrypt` from `./serialization/encryption.js` instead.
 */
export async function maybeDecrypt(
  data: Uint8Array | unknown,
  key: CryptoKey | undefined
): Promise<Uint8Array | unknown> {
  return decrypt(data, key);
}

// ============================================================================
// Dehydrate / Hydrate Functions
// ============================================================================
// These delegate to the modular mode modules (workflow, step, client) passing
// mode-specific stream and Request/Response reducers/revivers as extra options.
// The v1Compat path is handled inline before delegating to the modules.

/**
 * Called from the `start()` function to serialize the workflow arguments
 * into a format that can be saved to the database and then hydrated from
 * within the workflow execution environment.
 */
export async function dehydrateWorkflowArguments(
  value: unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getExternalReducers(global, ops, runId, key));
    return revive(str);
  }
  try {
    return await clientModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(
        getExternalReducers(global, ops, runId, key)
      ),
    });
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError(
        'workflow arguments',
        error instanceof WorkflowRuntimeError ? error.cause : error
      ),
      {
        slug: 'serialization-failed',
        cause: error instanceof WorkflowRuntimeError ? error.cause : error,
      }
    );
  }
}

/**
 * Called from workflow execution environment to hydrate the workflow
 * arguments from the database at the start of workflow execution.
 */
export async function hydrateWorkflowArguments(
  value: Uint8Array | unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<any> {
  return workflowModule.deserialize(await maybeDecrypt(value, key), {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(getWorkflowRevivers(global)),
      ...extraRevivers,
    },
  });
}

/**
 * Dehydrate workflow return value for storage.
 */
export async function dehydrateWorkflowReturnValue(
  value: unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getWorkflowReducers(global));
    return revive(str);
  }
  try {
    return await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(getWorkflowReducers(global)),
    });
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError(
        'workflow return value',
        error instanceof WorkflowRuntimeError ? error.cause : error
      ),
      {
        slug: 'serialization-failed',
        cause: error instanceof WorkflowRuntimeError ? error.cause : error,
      }
    );
  }
}

/**
 * Called from the client side to hydrate the workflow return value
 * of a completed workflow run.
 */
export async function hydrateWorkflowReturnValue(
  value: Uint8Array | unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<any> {
  return clientModule.deserialize(value, key, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(
        getExternalRevivers(global, ops, runId, key)
      ),
      ...extraRevivers,
    },
  });
}

/**
 * Called from the workflow handler when a step is being created.
 * Dehydrates values from within the workflow execution environment.
 */
export async function dehydrateStepArguments(
  value: unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getWorkflowReducers(global));
    return revive(str);
  }
  try {
    return await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(getWorkflowReducers(global)),
    });
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError(
        'step arguments',
        error instanceof WorkflowRuntimeError ? error.cause : error
      ),
      {
        slug: 'serialization-failed',
        cause: error instanceof WorkflowRuntimeError ? error.cause : error,
      }
    );
  }
}

/**
 * Called from the step handler to hydrate the arguments of a step
 * from the database at the start of the step execution.
 */
export async function hydrateStepArguments(
  value: Uint8Array | unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<any> {
  return stepModule.deserialize(value, key, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(getStepRevivers(global, ops, runId, key)),
      ...extraRevivers,
    },
  });
}

/**
 * Called from the step handler when a step has completed.
 * Dehydrates values from within the step execution environment.
 */
export async function dehydrateStepReturnValue(
  value: unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getStepReducers(global, ops, runId, key));
    return revive(str);
  }
  try {
    return await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(
        getStepReducers(global, ops, runId, key)
      ),
    });
  } catch (error) {
    throw new WorkflowRuntimeError(
      formatSerializationError(
        'step return value',
        error instanceof WorkflowRuntimeError ? error.cause : error
      ),
      {
        slug: 'serialization-failed',
        cause: error instanceof WorkflowRuntimeError ? error.cause : error,
      }
    );
  }
}

/**
 * Called from the workflow handler when replaying the event log
 * of a `step_completed` event.
 */
export async function hydrateStepReturnValue(
  value: Uint8Array | unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<any> {
  return workflowModule.deserialize(await maybeDecrypt(value, key), {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(getWorkflowRevivers(global)),
      ...extraRevivers,
    },
  });
}

// ---- Helpers to extract stream/Request/Response reducers and revivers ----
// The mode-specific get*Reducers/get*Revivers functions return objects that
// include both "common" entries (Date, Error, Map, etc.) and mode-specific
// entries (ReadableStream, WritableStream, Request, Response, StepFunction).
// The common entries are already composed by the codec. We only need to
// pass through the mode-specific entries as extraReducers/extraRevivers.

const STREAM_AND_REQUEST_KEYS = [
  'ReadableStream',
  'WritableStream',
  'Request',
  'Response',
  'StepFunction',
] as const;

function getStreamAndRequestReducers(
  allReducers: Record<string, any>
): Record<string, (value: any) => any> {
  const extra: Record<string, (value: any) => any> = {};
  for (const key of STREAM_AND_REQUEST_KEYS) {
    if (key in allReducers) {
      extra[key] = allReducers[key];
    }
  }
  return extra;
}

function getStreamAndRequestRevivers(
  allRevivers: Record<string, any>
): Record<string, (value: any) => any> {
  const extra: Record<string, (value: any) => any> = {};
  for (const key of STREAM_AND_REQUEST_KEYS) {
    if (key in allRevivers) {
      extra[key] = allRevivers[key];
    }
  }
  return extra;
}
