import {
  RuntimeDecryptionError,
  SerializationError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { parse, stringify, unflatten } from 'devalue';
import { monotonicFactory } from 'ulid';
import {
  decrypt as aesGcmDecrypt,
  encrypt as aesGcmEncrypt,
  type CryptoKey,
  importKey,
} from './encryption.js';
import {
  createFlushableState,
  flushablePipe,
  pollReadableLock,
  pollWritableLock,
} from './flushable-stream.js';
import { getStepFunction } from './private.js';
// V2: use getWorldLazy in step-side code paths so Turbopack can statically
// resolve the world bridge from the step bundle without dragging the full
// world.ts module (and its dynamic-import behaviour) into the flow route.
// See `packages/core/src/runtime/get-world-lazy.ts` and the
// "Turbopack NFT Tracing Errors in V2 Combined Flow Route" section of
// `docs/content/docs/changelog/eager-processing.mdx`.
import { getWorldLazy } from './runtime/get-world-lazy.js';
import * as clientModule from './serialization/client.js';
import {
  decrypt,
  type EncryptionKeyParam,
  encrypt,
} from './serialization/encryption.js';
import {
  formatSerializationError,
  rethrowIfRuntimeError,
} from './serialization/errors.js';
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
  ABORT_HOOK_TOKEN,
  ABORT_LISTENER_ATTACHED,
  ABORT_READER_CANCEL,
  ABORT_STREAM_NAME,
  BODY_INIT_SYMBOL,
  STABLE_ULID,
  STREAM_NAME_SYMBOL,
  STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
  STREAM_SERVER_RUN_ID_SYMBOL,
  STREAM_TYPE_SYMBOL,
  WEBHOOK_RESPONSE_WRITABLE,
} from './symbols.js';
import { getAbortStreamId } from './util.js';
import { WorkflowAbortSignal } from './workflow/abort-controller.js';

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

/**
 * The mode-specific serializers (`./serialization/{client,step,workflow}.ts`)
 * already throw a `SerializationError` whose `.cause` is the underlying
 * devalue / serde failure. The outer dehydrate/hydrate wrappers want to
 * re-frame that error with a more specific context label (e.g. "workflow
 * arguments" instead of generic "workflow value"), so they unwrap the
 * inner SerializationError and reformat with the original cause. Errors
 * that aren't already SerializationError flow through unchanged.
 *
 * `RuntimeDecryptionError` is an exception: it must keep its identity (and
 * `context`) so the run-failure classifier routes it to `RUNTIME_ERROR`,
 * so this rethrows it unchanged before any unwrapping. Note this guard
 * must run before the generic `WorkflowRuntimeError` unwrap below, since
 * `RuntimeDecryptionError` extends `WorkflowRuntimeError` and carries a
 * `cause` (the underlying DOMException) that would otherwise be unwrapped
 * and reframed as a `SerializationError`.
 */
function unwrapSerializationCause(error: unknown): unknown {
  rethrowIfRuntimeError(error);
  if (error instanceof SerializationError && error.cause !== undefined) {
    return error.cause;
  }
  if (error instanceof WorkflowRuntimeError && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

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
        // Encryption failures must keep their RuntimeDecryptionError
        // identity (RUNTIME_ERROR) rather than be reframed as a
        // SerializationError (USER_ERROR).
        if (RuntimeDecryptionError.is(error)) {
          controller.error(error);
          return;
        }
        const { message, hint } = formatSerializationError(
          'stream chunk',
          error
        );
        controller.error(
          new SerializationError(message, { hint, cause: error })
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
            new RuntimeDecryptionError(
              'Encrypted stream data encountered but no encryption key is available. ' +
                'Encryption is not configured or no key was provided for this run.',
              {
                context: {
                  operation: 'decrypt',
                  byteLength: payload.byteLength,
                  formatPrefix: 'encr',
                },
              }
            )
          );
          return;
        }
        let decrypted: Uint8Array;
        try {
          decrypted = await aesGcmDecrypt(keyState.key, payload);
        } catch (error) {
          // The low-level AES layer only sees the stripped payload, so it
          // cannot record the outer envelope prefix. We peeked it here
          // (`encr`), so enrich the diagnostic context with the real format
          // prefix before propagating — mirroring serialization/encryption.ts.
          if (RuntimeDecryptionError.is(error) && error.context) {
            error.context.formatPrefix = format;
          }
          throw error;
        }
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
      throw new WorkflowRuntimeError(`"name" is required, got "${name}"`);
    }
    super({
      // @ts-expect-error Not sure why TypeScript is complaining about this
      type: 'bytes',

      pull: async (controller) => {
        let reader = this.#reader;
        if (!reader) {
          const world = await getWorldLazy();
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
      throw new WorkflowRuntimeError(
        `"runId" must be a string, got "${typeof runId}"`
      );
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new WorkflowRuntimeError(`"name" is required, got "${name}"`);
    }
    const worldPromise = getWorldLazy();

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
      // Forward the signal in two cases:
      //   1. Already aborted — preserve aborted=true/reason so the hydrated
      //      step sees the cancellation that happened before serialize.
      //   2. Already tagged with workflow infrastructure — i.e. a signal
      //      from a workflow-managed AbortController, which has stream/hook
      //      backing for cross-boundary propagation.
      // Plain non-aborted native signals are intentionally dropped (would
      // mint stream infra for every Request, including the auto-generated
      // signal on `new Request(url)`).
      if (
        value.signal &&
        (value.signal.aborted ||
          (value.signal as AbortInternals)[ABORT_STREAM_NAME])
      ) {
        data.signal = value.signal;
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

// ---------------------------------------------------------------------------
// Shared abort reducer helpers
// ---------------------------------------------------------------------------

type AbortSerializedData = {
  streamName: string;
  hookToken: string;
  aborted: boolean;
  reason: unknown;
};

/**
 * Symbol-keyed internal fields tagged onto AbortController/AbortSignal
 * instances (and `holder`s in reducer helpers). All optional — a plain
 * native instance has none of them set.
 */
type AbortInternals = {
  [ABORT_STREAM_NAME]?: string;
  [ABORT_HOOK_TOKEN]?: string;
  [ABORT_READER_CANCEL]?: AbortController;
};

type AbortSignalLike = AbortInternals & {
  aborted: boolean;
  reason?: unknown;
  addEventListener?: Function;
};

type AbortHolder = AbortInternals & { signal?: AbortInternals };

/**
 * Shared logic for AbortController/AbortSignal reducers in external and step
 * contexts. Assigns stream/hook names if not already present, optionally
 * attaches an abort listener for real-time propagation, and returns the
 * serialized representation.
 */
function reduceAbortWithListener(
  signal: AbortSignalLike,
  holder: AbortHolder,
  global: Record<string, any>,
  ops: Promise<void>[],
  runId: string,
  cryptoKey: EncryptionKeyParam
): AbortSerializedData {
  let streamName = holder[ABORT_STREAM_NAME];
  let hookToken = holder[ABORT_HOOK_TOKEN];
  if (!streamName) {
    const id = ((global as any)[STABLE_ULID] || defaultUlid)();
    streamName = getAbortStreamId(id);
    hookToken = `abrt_${id}`;
    holder[ABORT_STREAM_NAME] = streamName;
    holder[ABORT_HOOK_TOKEN] = hookToken;
    if (holder.signal) {
      holder.signal[ABORT_STREAM_NAME] = streamName;
      holder.signal[ABORT_HOOK_TOKEN] = hookToken;
    }
  }

  // Deduped via ABORT_LISTENER_ATTACHED marker — see attachAbortListenerOnce.
  attachAbortListenerOnce(
    signal as AbortSignal,
    streamName,
    runId,
    cryptoKey,
    ops
  );

  return {
    streamName,
    hookToken: hookToken!,
    aborted: signal.aborted,
    reason: signal.aborted ? signal.reason : undefined,
  };
}

/**
 * Shared logic for AbortController/AbortSignal reducers in workflow context.
 * Reads existing stream/hook names from symbols (must already be set).
 */
function reduceAbortBySymbol(
  signal: { aborted: boolean; reason?: unknown },
  holder: AbortHolder
): AbortSerializedData | false {
  const streamName =
    holder[ABORT_STREAM_NAME] ?? holder.signal?.[ABORT_STREAM_NAME];
  const hookToken =
    holder[ABORT_HOOK_TOKEN] ?? holder.signal?.[ABORT_HOOK_TOKEN];
  if (!streamName) {
    throw new Error('AbortController/AbortSignal stream name is not set');
  }
  return {
    streamName,
    hookToken: hookToken!,
    aborted: signal.aborted,
    reason: signal.aborted ? signal.reason : undefined,
  };
}

/**
 * Attach a single abort listener to a signal, deduped across calls.
 *
 * Each serialization pass goes through the reducer, but a controller passed
 * to N steps would otherwise accumulate N listeners — each writing the same
 * stream packet and double-closing the stream on abort. The marker symbol
 * ensures the stream-write side-effect runs at most once per (signal, runId).
 */
function attachAbortListenerOnce(
  signal: AbortSignal,
  streamName: string,
  runId: string,
  cryptoKey: EncryptionKeyParam,
  ops: Promise<void>[]
): void {
  if (signal.aborted) return;
  if ((signal as any)[ABORT_LISTENER_ATTACHED]) return;
  (signal as any)[ABORT_LISTENER_ATTACHED] = true;

  signal.addEventListener(
    'abort',
    () => {
      ops.push(
        (async () => {
          try {
            // Dehydrate via the same machinery the reader uses (hydrateStepArguments)
            // so the reason round-trips with full type fidelity (DOMException,
            // Errors, custom classes, etc.) and respects the run's encryption key.
            // A bare JSON.stringify here would write a packet the reader can't
            // decode and the listener-side abort would propagate with no reason.
            const key = await cryptoKey;
            const payload = await dehydrateStepArguments(
              { aborted: true, reason: signal.reason },
              runId,
              key
            );
            const writable = new WorkflowServerWritableStream(
              runId,
              streamName
            );
            const writer = writable.getWriter();
            await writer.write(payload as Uint8Array);
            await writer.close();
          } catch {
            // Best-effort stream write
          }
        })()
      );
    },
    { once: true }
  );
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
        throw new SerializationError(
          'ReadableStream is locked and cannot be passed across a workflow boundary.',
          {
            hint: 'Pass the stream before calling .getReader() / .pipeThrough() / .pipeTo(), or tee it with .tee() and pass one of the branches.',
          }
        );
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

      // Fast path: when the writable is already backed by a workflow
      // server stream (e.g. it came from a step-context `getWritable()`
      // or was hydrated from a workflow input by `getStepRevivers`),
      // forward its underlying `(runId, name)` to the receiving run.
      // The receiving run's step-side reviver opens a server writable
      // against the original `(runId, name)` and resolves that run's
      // encryption key directly, so writes land on the original stream
      // for the full lifetime of the receiving run — no in-process
      // bridge tied to the dehydrating step's lifetime.
      const existingName = (value as any)[STREAM_NAME_SYMBOL];
      const existingRunId = (value as any)[STREAM_SERVER_RUN_ID_SYMBOL];
      if (
        typeof existingName === 'string' &&
        typeof existingRunId === 'string'
      ) {
        const descriptor: SerializableSpecial['WritableStream'] = {
          name: existingName,
          runId: existingRunId,
        };
        const existingDeploymentId = (value as any)[
          STREAM_SERVER_DEPLOYMENT_ID_SYMBOL
        ];
        if (typeof existingDeploymentId === 'string') {
          descriptor.deploymentId = existingDeploymentId;
        }
        return descriptor;
      }

      const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
      const name = `strm_${streamId}`;
      const readable = new WorkflowServerReadableStream(runId, name);
      ops.push(readable.pipeTo(value));

      return { name };
    },

    AbortController: (value) => {
      if (
        !global.AbortController ||
        typeof global.AbortController !== 'function' ||
        !(value instanceof global.AbortController)
      )
        return false;
      return reduceAbortWithListener(
        value.signal,
        value,
        global,
        ops,
        runId,
        cryptoKey
      );
    },

    AbortSignal: (value) => {
      if (
        !global.AbortSignal ||
        typeof global.AbortSignal !== 'function' ||
        !(value instanceof global.AbortSignal)
      )
        return false;
      return reduceAbortWithListener(
        value,
        value,
        global,
        ops,
        runId,
        cryptoKey
      );
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
        throw new WorkflowRuntimeError('ReadableStream `name` is not set');
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
        throw new WorkflowRuntimeError('WritableStream `name` is not set');
      }
      const s: SerializableSpecial['WritableStream'] = { name };
      // When the handle was forwarded from another run (parent → child
      // via `start()`), preserve the foreign runId so the step-side
      // reviver opens the writable against the original stream.
      const foreignRunId = value[STREAM_SERVER_RUN_ID_SYMBOL];
      if (typeof foreignRunId === 'string') s.runId = foreignRunId;
      const foreignDeploymentId = value[STREAM_SERVER_DEPLOYMENT_ID_SYMBOL];
      if (typeof foreignDeploymentId === 'string') {
        s.deploymentId = foreignDeploymentId;
      }
      return s;
    },

    // AbortController/AbortSignal in workflow context — just read symbols (handles).
    // In the workflow VM, global.AbortController is a class but global.AbortSignal
    // is a plain object (not a class), so instanceof checks won't work for signals.
    // Detect instances by the presence of the ABORT_STREAM_NAME symbol instead.
    AbortController: (value) => {
      if (!value || !value.signal) return false;
      const holder = value as AbortController & AbortHolder;
      const hasAbortSymbol =
        holder[ABORT_STREAM_NAME] ?? holder.signal?.[ABORT_STREAM_NAME];
      const isNativeAbortController =
        global.AbortController &&
        typeof global.AbortController === 'function' &&
        value instanceof global.AbortController;
      if (!hasAbortSymbol && !isNativeAbortController) return false;
      return reduceAbortBySymbol(value.signal, holder);
    },
    AbortSignal: (value) => {
      const signal = value as (AbortSignal & AbortInternals) | undefined;
      const hasAbortSymbol = signal?.[ABORT_STREAM_NAME];
      const isNativeAbortSignal =
        global.AbortSignal &&
        typeof global.AbortSignal === 'function' &&
        value instanceof global.AbortSignal;
      if (!hasAbortSymbol && !isNativeAbortSignal) return false;
      return reduceAbortBySymbol(value, value as AbortHolder);
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
        throw new SerializationError(
          'ReadableStream is locked and cannot be passed across a workflow boundary.',
          {
            hint: 'Pass the stream before calling .getReader() / .pipeThrough() / .pipeTo(), or tee it with .tee() and pass one of the branches.',
          }
        );
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
      const foreignRunId = (value as any)[STREAM_SERVER_RUN_ID_SYMBOL];
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

      const s: SerializableSpecial['WritableStream'] = { name };
      if (typeof foreignRunId === 'string') s.runId = foreignRunId;
      const foreignDeploymentId = (value as any)[
        STREAM_SERVER_DEPLOYMENT_ID_SYMBOL
      ];
      if (typeof foreignDeploymentId === 'string') {
        s.deploymentId = foreignDeploymentId;
      }
      return s;
    },

    AbortController: (value) => {
      if (
        !global.AbortController ||
        typeof global.AbortController !== 'function' ||
        !(value instanceof global.AbortController)
      )
        return false;
      return reduceAbortWithListener(
        value.signal,
        value,
        global,
        ops,
        runId,
        cryptoKey
      );
    },

    AbortSignal: (value) => {
      if (
        !global.AbortSignal ||
        typeof global.AbortSignal !== 'function' ||
        !(value instanceof global.AbortSignal)
      )
        return false;
      return reduceAbortWithListener(
        value,
        value,
        global,
        ops,
        runId,
        cryptoKey
      );
    },
  };
}

/**
 * Cancel dangling abort-stream readers on any AbortController instances found
 * in the hydrated step arguments. Called after the step function returns
 * (success or failure) to prevent reader promises from keeping the serverless
 * function alive indefinitely.
 */
export function cancelAbortReaders(...values: unknown[]): void {
  const visited = new WeakSet();
  function cancelIfPresent(val: AbortInternals): void {
    const cancel = val[ABORT_READER_CANCEL];
    if (cancel && !cancel.signal.aborted) {
      cancel.abort();
    }
  }
  function walk(val: unknown): void {
    if (val == null || typeof val !== 'object') return;
    if (visited.has(val as object)) return;
    visited.add(val as object);
    if (val instanceof AbortController) {
      cancelIfPresent(val as AbortController & AbortInternals);
      cancelIfPresent(val.signal as AbortSignal & AbortInternals);
      return;
    }
    if (val instanceof AbortSignal) {
      cancelIfPresent(val as AbortSignal & AbortInternals);
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) walk(item);
      return;
    }
    if (val instanceof Map) {
      for (const v of val.values()) walk(v);
      return;
    }
    if (val instanceof Set) {
      for (const v of val) walk(v);
      return;
    }
    // Request/Response expose `signal`/`body` as prototype getters, so
    // Object.values() won't find them. Descend explicitly.
    if (typeof Request !== 'undefined' && val instanceof Request) {
      walk(val.signal);
      return;
    }
    for (const v of Object.values(val as Record<string, unknown>)) walk(v);
  }
  for (const v of values) walk(v);
}

/**
 * Sets up a stream reader on the controller that listens for an abort packet.
 * Returns the readerCancel controller so it can be stored on both the
 * controller and signal for cleanup by cancelAbortReaders.
 */
function setupAbortStreamReader(
  controller: AbortController,
  runId: string,
  streamName: string,
  ops: Promise<void>[]
): AbortController {
  const readerCancel = new AbortController();

  ops.push(
    (async () => {
      try {
        const readable = new WorkflowServerReadableStream(runId, streamName);
        const reader = readable.getReader();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) => {
            if (readerCancel.signal.aborted) {
              resolve({ value: undefined, done: true });
              return;
            }
            readerCancel.signal.addEventListener(
              'abort',
              () => resolve({ value: undefined, done: true }),
              { once: true }
            );
          }),
        ]);
        reader.releaseLock();
        if (result.value && !result.done) {
          try {
            // Hydrate via the same machinery the writer used so the reason
            // round-trips with full type fidelity. Encryption key (if any)
            // comes from the step context — set up by the step handler before
            // this reader runs. Fallback to undefined for external-context
            // revives (the hydrate path is encryption-key-tolerant).
            const ctxForKey = contextStorage.getStore();
            const data = (await hydrateStepArguments(
              result.value,
              runId,
              ctxForKey?.encryptionKey
            )) as { reason?: unknown } | undefined;
            controller.abort(data?.reason);
          } catch {
            controller.abort();
          }
        }
      } catch {
        // Stream read failed — signal won't propagate in real-time,
        // but hook-based propagation on next replay provides fallback
      }
    })()
  );

  return readerCancel;
}

/**
 * Stores abort serialization symbols and the readerCancel controller
 * on both the controller and its signal.
 */
function tagAbortPair(
  controller: AbortController,
  value: { streamName: string; hookToken: string },
  readerCancel?: AbortController
): void {
  const taggedController = controller as AbortController & AbortInternals;
  const taggedSignal = controller.signal as AbortSignal & AbortInternals;
  taggedController[ABORT_STREAM_NAME] = value.streamName;
  taggedController[ABORT_HOOK_TOKEN] = value.hookToken;
  taggedSignal[ABORT_STREAM_NAME] = value.streamName;
  taggedSignal[ABORT_HOOK_TOKEN] = value.hookToken;
  if (readerCancel) {
    taggedController[ABORT_READER_CANCEL] = readerCancel;
    taggedSignal[ABORT_READER_CANCEL] = readerCancel;
  }
}

/**
 * Propagate abort-internal symbols from one signal to another. Used by the
 * Request reviver because `new Request(url, { signal })` copies the signal
 * internally — the constructed `request.signal` is a fresh AbortSignal that
 * doesn't carry symbols from the source.
 */
function copyAbortInternals(src: AbortSignal, dest: AbortSignal): void {
  const s = src as AbortSignal & AbortInternals;
  const d = dest as AbortSignal & AbortInternals;
  if (s[ABORT_STREAM_NAME] !== undefined) {
    d[ABORT_STREAM_NAME] = s[ABORT_STREAM_NAME];
  }
  if (s[ABORT_HOOK_TOKEN] !== undefined) {
    d[ABORT_HOOK_TOKEN] = s[ABORT_HOOK_TOKEN];
  }
  if (s[ABORT_READER_CANCEL] !== undefined) {
    d[ABORT_READER_CANCEL] = s[ABORT_READER_CANCEL];
  }
}

/**
 * Creates an AbortController with stream-backed abort propagation.
 * Used by step and external revivers where real abort signal behavior is needed.
 *
 * @param value - The serialized abort controller/signal data
 * @param ops - The ops array for tracking async work
 * @param runId - The workflow run ID (for stream reads)
 * @returns A real AbortController with patched abort() method
 */
function reviveAbortController(
  value: SerializableSpecial['AbortController'],
  ops: Promise<void>[],
  runId: string
): AbortController {
  const controller = new AbortController();

  if (value.aborted) {
    tagAbortPair(controller, value);
    controller.abort(value.reason);
  } else if (value.streamName) {
    const readerCancel = setupAbortStreamReader(
      controller,
      runId,
      value.streamName,
      ops
    );
    tagAbortPair(controller, value, readerCancel);
  } else {
    tagAbortPair(controller, value);
  }

  // Override abort() to also write stream + resume hook (for step-initiated abort)
  const originalAbort = controller.abort.bind(controller);
  controller.abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    originalAbort(reason);

    const ctx = contextStorage.getStore();
    if (ctx) {
      ctx.ops.push(
        (async () => {
          try {
            // Dehydrate the abort payload through the same machinery the hook
            // event uses so the `reason` round-trips with full type fidelity
            // (DOMException, custom errors, etc.) and respects the run's
            // encryption key — symmetric with what the suspension handler
            // writes for workflow-initiated aborts.
            const payload = await dehydrateStepArguments(
              { aborted: true, reason },
              ctx.workflowMetadata.workflowRunId,
              ctx.encryptionKey
            );
            const writable = new WorkflowServerWritableStream(
              ctx.workflowMetadata.workflowRunId,
              value.streamName
            );
            const writer = writable.getWriter();
            await writer.write(payload as Uint8Array);
            await writer.close();
          } catch {
            // Best-effort stream write
          }
        })()
      );

      if (value.hookToken) {
        ctx.ops.push(
          (async () => {
            try {
              const { resumeHook: resumeHookFn } = await import(
                './runtime/resume-hook.js'
              );
              await resumeHookFn(value.hookToken, {
                aborted: true,
                reason,
              });
            } catch {
              // Best-effort hook resume — retry on next replay
            }
          })()
        );
      }
    }
  };

  return controller;
}

/**
 * Revives just an AbortSignal without the patched abort() overhead.
 * Used when only a signal (not a controller) was serialized.
 */
function reviveAbortSignal(
  value: SerializableSpecial['AbortSignal'],
  ops: Promise<void>[],
  runId: string
): AbortSignal {
  const controller = new AbortController();

  if (value.aborted) {
    tagAbortPair(controller, value);
    controller.abort(value.reason);
  } else if (value.streamName) {
    const readerCancel = setupAbortStreamReader(
      controller,
      runId,
      value.streamName,
      ops
    );
    tagAbortPair(controller, value, readerCancel);
  } else {
    tagAbortPair(controller, value);
  }

  return controller.signal;
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
 * Resolve the encrypt-only key needed when a child writes into another run's
 * stream. New descriptors include the owner's deployment ID; descriptors
 * created by older SDK versions fall back to loading the owning run.
 */
async function getForwardedWritableEncryptionKey(
  runId: string,
  deploymentId: string | undefined
): Promise<CryptoKey | undefined> {
  const world = await getWorldLazy();
  if (!world.getEncryptionKeyForRun) return undefined;

  const rawKey = deploymentId
    ? await world.getEncryptionKeyForRun(runId, { deploymentId })
    : await world.getEncryptionKeyForRun(await world.runs.get(runId));
  return rawKey ? await importKey(rawKey, ['encrypt']) : undefined;
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
      throw new SerializationError(
        'Step functions cannot be deserialized in client context. Step functions should not be returned from workflows.',
        {
          hint: 'A step function reference reached the client. Return a serializable value (e.g. the step result) instead of the step itself.',
        }
      );
    },

    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new SerializationError(
            'Workflow functions cannot be called directly. Use start() to invoke them.',
            {
              hint: 'Wrap the workflow with `start(workflowFn, { ... })` from `workflow` to begin a run instead of invoking it like a normal function.',
            }
          );
        },
        { workflowId: value.workflowId }
      ),

    Request: (value) => {
      const init: RequestInit & { duplex?: string } = {
        method: value.method,
        headers: new global.Headers(value.headers),
        body: value.body,
        duplex: value.duplex,
      };
      if (value.signal) init.signal = value.signal;
      const request = new global.Request(value.url, init);
      // The Request constructor creates an internal signal copy, so the
      // abort-internal symbols set by reviveAbortSignal don't propagate.
      // Re-tag the request's own signal so cancelAbortReaders can find it.
      if (value.signal) copyAbortInternals(value.signal, request.signal);
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
      // Same handling as `getStepRevivers.WritableStream` — see comments
      // there for the cross-run case (writable carries `runId` from
      // parent → child forwarding via `start()`).
      const targetRunId = typeof value.runId === 'string' ? value.runId : runId;
      const targetKey: EncryptionKeyParam =
        targetRunId === runId
          ? cryptoKey
          : getForwardedWritableEncryptionKey(targetRunId, value.deploymentId);

      const serialize = getSerializeStream(
        getExternalReducers(global, ops, targetRunId, targetKey),
        targetKey
      );
      const serverWritable = new WorkflowServerWritableStream(
        targetRunId,
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

      Object.defineProperty(serialize.writable, STREAM_NAME_SYMBOL, {
        value: value.name,
        writable: false,
      });
      Object.defineProperty(serialize.writable, STREAM_SERVER_RUN_ID_SYMBOL, {
        value: targetRunId,
        writable: false,
      });
      if (typeof value.deploymentId === 'string') {
        Object.defineProperty(
          serialize.writable,
          STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
          {
            value: value.deploymentId,
            writable: false,
          }
        );
      }

      return serialize.writable;
    },

    AbortController: (value) => reviveAbortController(value, ops, runId),
    AbortSignal: (value) => reviveAbortSignal(value, ops, runId),
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
          throw new SerializationError(
            '`respondWith()` must be called from within a step function.',
            {
              hint: 'Move the `respondWith(...)` call inside a `"use step"` function — it cannot be invoked from a workflow context.',
            }
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
          throw new SerializationError(
            'Workflow functions cannot be called directly. Use start() to invoke them.',
            {
              hint: 'Wrap the workflow with `start(workflowFn, { ... })` from `workflow` to begin a run instead of invoking it like a normal function.',
            }
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
      const descriptor: PropertyDescriptorMap = {
        [STREAM_NAME_SYMBOL]: {
          value: value.name,
          writable: false,
        },
      };
      // Preserve the foreign runId, if present, so that when the
      // handle is later passed to a step the workflow reducer can
      // forward it through to the step reviver.
      if (typeof value.runId === 'string') {
        descriptor[STREAM_SERVER_RUN_ID_SYMBOL] = {
          value: value.runId,
          writable: false,
        };
      }
      if (typeof value.deploymentId === 'string') {
        descriptor[STREAM_SERVER_DEPLOYMENT_ID_SYMBOL] = {
          value: value.deploymentId,
          writable: false,
        };
      }
      return Object.create(global.WritableStream.prototype, descriptor);
    },

    // AbortController/AbortSignal revived inside the workflow VM. Use the
    // real WorkflowAbortSignal class so addEventListener('abort', fn) actually
    // fires when the signal aborts (the previous no-op stub silently dropped
    // listener registrations — silent correctness bug for natural patterns
    // like `signal.addEventListener('abort', fn)` after receiving a deserialized
    // signal). The signal does not own a hook subscription here — abort state
    // is delivered via the existing replay machinery on the source side.
    AbortController: (value) => {
      const signal = new WorkflowAbortSignal(value.streamName, value.hookToken);
      if (value.aborted) signal._setAborted(value.reason);
      return {
        [ABORT_STREAM_NAME]: value.streamName,
        [ABORT_HOOK_TOKEN]: value.hookToken,
        signal,
        abort: () => {},
      };
    },
    AbortSignal: (value) => {
      const signal = new WorkflowAbortSignal(value.streamName, value.hookToken);
      if (value.aborted) signal._setAborted(value.reason);
      return signal;
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
  cryptoKey: EncryptionKeyParam,
  deploymentId?: string
): Partial<Revivers> {
  return {
    ...getCommonRevivers(global),

    // StepFunction reviver for step context - returns raw step function
    // with closure variable support via AsyncLocalStorage.
    //
    // Handles four independent flags from the serialized payload:
    //   - `closureVars`: invoke the body inside an AsyncLocalStorage frame
    //     so the SWC-emitted `WORKFLOW_STEP_CONTEXT_STORAGE` IIFE in the
    //     hoisted body can pull the closure variables back out.
    //   - `boundThis`:   a `this` value captured by
    //     `useStep(...).bind(this)` in the workflow bundle (lexical-`this`
    //     arrow steps). The wrapper invokes the body via
    //     `stepFn.apply(boundThis, args)` so the body sees the same
    //     `this` it would have had in the workflow bundle. Property
    //     presence — not truthiness — is significant because
    //     `bind(null)` and `bind(undefined)` are both legal and should
    //     round-trip faithfully.
    //   - `boundArgs`:   prefilled args from
    //     `useStep(...).bind(thisArg, x, y)`. Prepended to the call args
    //     so partial application survives serialization.
    StepFunction: (value) => {
      const stepId = value.stepId;
      const closureVars = value.closureVars;
      const hasBoundThis = 'boundThis' in value;
      const boundThis = hasBoundThis ? value.boundThis : undefined;
      const boundArgs = Array.isArray(value.boundArgs) ? value.boundArgs : [];

      const stepFn = getStepFunction(stepId);
      if (!stepFn) {
        throw new SerializationError(
          `Step function "${stepId}" not found. Make sure the step function is registered.`,
          {
            hint: 'Make sure the step file is included in your build (i.e. it is listed in the workflow manifest), and that the SWC plugin is configured for the file.',
          }
        );
      }

      // Fast path: nothing to wrap.
      if (!closureVars && !hasBoundThis && boundArgs.length === 0) {
        return stepFn;
      }

      const wrappedStepFn = function (this: unknown, ...args: any[]) {
        const callThis = hasBoundThis ? boundThis : this;
        const callArgs = boundArgs.length > 0 ? [...boundArgs, ...args] : args;
        if (closureVars) {
          const currentContext = contextStorage.getStore();
          if (!currentContext) {
            throw new WorkflowRuntimeError(
              'Cannot call step function with closure variables outside step context'
            );
          }
          const newContext = {
            ...currentContext,
            closureVars,
          };
          return contextStorage.run(newContext, () =>
            stepFn.apply(callThis, callArgs)
          );
        }
        return stepFn.apply(callThis, callArgs);
      } as any;

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
    },

    WorkflowFunction: (value) =>
      Object.assign(
        () => {
          throw new SerializationError(
            'Workflow functions cannot be called directly. Use start() to invoke them.',
            {
              hint: 'Wrap the workflow with `start(workflowFn, { ... })` from `workflow` to begin a run instead of invoking it like a normal function.',
            }
          );
        },
        { workflowId: value.workflowId }
      ),

    Request: (value) => {
      const responseWritable = value.responseWritable;
      const init: RequestInit & { duplex?: string } = {
        method: value.method,
        headers: new global.Headers(value.headers),
        body: value.body,
        duplex: value.duplex,
      };
      if (value.signal) init.signal = value.signal;
      const request = new global.Request(value.url, init);
      // The Request constructor creates an internal signal copy, so the
      // abort-internal symbols set by reviveAbortSignal don't propagate.
      // Re-tag the request's own signal so cancelAbortReaders can find it.
      if (value.signal) copyAbortInternals(value.signal, request.signal);
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
          getStepRevivers(global, ops, runId, cryptoKey, deploymentId),
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
      // Same-run case: the writable belongs to the current run. Use the
      // local cryptoKey and write to the local runId's server stream.
      //
      // Cross-run case (parent → child via `start()`): the descriptor
      // carries the original `runId` and `name`. Open a server writable
      // against the original `(runId, name)` and resolve THAT run's key
      // for encryption. The resolution is async but doesn't need to
      // block reviver return — `getSerializeStream` accepts the
      // `Promise<CryptoKey | undefined>` directly and awaits it lazily
      // on the first chunk written. The key is imported encrypt-only
      // so the receiving run can never decrypt anything else on the
      // owning run's stream — it can only contribute new writes.
      const targetRunId = typeof value.runId === 'string' ? value.runId : runId;
      const targetDeploymentId =
        typeof value.deploymentId === 'string'
          ? value.deploymentId
          : targetRunId === runId
            ? deploymentId
            : undefined;
      const targetKey: EncryptionKeyParam =
        targetRunId === runId
          ? cryptoKey
          : getForwardedWritableEncryptionKey(targetRunId, targetDeploymentId);

      const serialize = getSerializeStream(
        getStepReducers(global, ops, targetRunId, targetKey),
        targetKey
      );
      const serverWritable = new WorkflowServerWritableStream(
        targetRunId,
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

      // Record the underlying `(runId, name)` so downstream reducers can
      // recognize that this writable is already backed by a workflow
      // server stream. When forwarded across `start()` again — e.g.
      // the child passes this writable on to a grandchild — the
      // external reducer needs both to emit the original `runId` in
      // the descriptor.
      Object.defineProperty(serialize.writable, STREAM_NAME_SYMBOL, {
        value: value.name,
        writable: false,
      });
      Object.defineProperty(serialize.writable, STREAM_SERVER_RUN_ID_SYMBOL, {
        value: targetRunId,
        writable: false,
      });
      if (targetDeploymentId) {
        Object.defineProperty(
          serialize.writable,
          STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
          {
            value: targetDeploymentId,
            writable: false,
          }
        );
      }

      return serialize.writable;
    },

    AbortController: (value) => reviveAbortController(value, ops, runId),
    AbortSignal: (value) => reviveAbortSignal(value, ops, runId),
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
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError(
      'workflow arguments',
      cause
    );
    throw new SerializationError(message, { hint, cause });
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
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError(
      'workflow return value',
      cause
    );
    throw new SerializationError(message, { hint, cause });
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
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError('step arguments', cause);
    throw new SerializationError(message, { hint, cause });
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
  extraRevivers: Record<string, (value: any) => any> = {},
  deploymentId?: string
): Promise<any> {
  return stepModule.deserialize(value, key, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(
        getStepRevivers(global, ops, runId, key, deploymentId)
      ),
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
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError(
      'step return value',
      cause
    );
    throw new SerializationError(message, { hint, cause });
  }
}

/**
 * Called from the step handler when a step throws. Dehydrates the thrown
 * value from within the step execution environment into a format that can
 * be saved to the database in a `step_failed` or `step_retrying` event.
 *
 * Any JavaScript value can be thrown (strings, numbers, objects, Errors,
 * Error subclasses), so the same serialization pipeline used for step
 * arguments and return values is applied here.
 *
 * @param value - The thrown value to serialize (can be any type)
 * @param runId - Run ID for encryption context
 * @param key - Encryption key (undefined to skip encryption)
 * @param ops - Promise array for stream operations
 * @param global - Global object for serialization context
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateStepError(
  value: unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis
): Promise<Uint8Array> {
  try {
    const str = stringify(value, getStepReducers(global, ops, runId, key));
    const payload = new TextEncoder().encode(str);
    const serialized = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    return (await maybeEncrypt(serialized, key)) as Uint8Array;
  } catch (error) {
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError('step error', cause);
    throw new SerializationError(message, { hint, cause });
  }
}

/**
 * Called from the workflow handler when replaying the event log of a
 * `step_failed` or `step_retrying` event. Hydrates the thrown value from
 * the database so the workflow can see the original thrown value.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - Run ID for decryption context
 * @param key - Encryption key (undefined to skip decryption)
 * @param global - Global object for deserialization context
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated thrown value, ready to reject the step promise
 */
export async function hydrateStepError(
  value: Uint8Array | unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<unknown> {
  const decrypted = await maybeDecrypt(value, key);

  if (!(decrypted instanceof Uint8Array)) {
    // Treated as a devalue "flattened" array. In production this branch is
    // exercised by legacy code paths that bypassed `dehydrateStepError`; the
    // SDK version is pinned per workflow run via skew protection, so a
    // current-version producer always emits a Uint8Array here. If a
    // misshapen value reaches us, `unflatten` throws — that's intentional:
    // the higher-level hydration helpers (`hydrateStepIO`,
    // `hydrateResourceIO`) already wrap us in a try/catch that leaves the
    // field un-hydrated for o11y display, and surfacing the throw to logs
    // is more debuggable than silently masking the unsupported shape.
    return unflatten(decrypted as any[], {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(decrypted);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    return parse(str, {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Called from the workflow handler when the workflow itself throws.
 * Dehydrates the thrown value from within the workflow execution environment
 * into a format that can be saved to the database in a `run_failed` event.
 *
 * @param value - The thrown value to serialize (can be any type)
 * @param runId - Run ID for encryption context
 * @param key - Encryption key (undefined to skip encryption)
 * @param global - Global object for serialization context
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateRunError(
  value: unknown,
  _runId: string,
  key: CryptoKey | undefined,
  global: Record<string, any> = globalThis
): Promise<Uint8Array> {
  try {
    const str = stringify(value, getWorkflowReducers(global));
    const payload = new TextEncoder().encode(str);
    const serialized = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    return (await maybeEncrypt(serialized, key)) as Uint8Array;
  } catch (error) {
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError('run error', cause);
    throw new SerializationError(message, { hint, cause });
  }
}

/**
 * Called from the client side (or observability tools) to hydrate the run
 * error value of a failed workflow run.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - Run ID for decryption context
 * @param key - Encryption key (undefined to skip decryption)
 * @param ops - Promise array for stream operations
 * @param global - Global object for deserialization context
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated thrown value, ready to be consumed by the client
 */
export async function hydrateRunError(
  value: Uint8Array | unknown,
  runId: string,
  key: CryptoKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<unknown> {
  const decrypted = await maybeDecrypt(value, key);

  if (!(decrypted instanceof Uint8Array)) {
    // See the matching note in `hydrateStepError`: this branch is for
    // devalue flattened arrays from legacy callers; current SDK versions
    // always emit a Uint8Array, and a misshapen value here intentionally
    // throws via `unflatten` so the surrounding try/catch in o11y helpers
    // surfaces the issue rather than masking it.
    return unflatten(decrypted as any[], {
      ...getExternalRevivers(global, ops, runId, key),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(decrypted);

  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    return parse(str, {
      ...getExternalRevivers(global, ops, runId, key),
      ...extraRevivers,
    });
  }

  throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Called from the workflow handler when replaying the event log of a `step_completed` event.
 * Hydrates the return value of a step from the database.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - Run ID for decryption context
 * @param key - Encryption key (undefined to skip decryption)
 * @param global - Global object for deserialization context
 * @param extraRevivers - Additional revivers for custom types
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
  // Wire AbortController/AbortSignal through the client serialization path so
  // signals reachable via Request.signal (or as direct arguments) get their
  // dedicated reducer. Without this, devalue falls back to its arbitrary-POJO
  // path and fails for any signal the Request reducer forwards.
  'AbortController',
  'AbortSignal',
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
