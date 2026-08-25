import {
  RuntimeDecryptionError,
  SerializationError,
  StreamExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import { once } from '@workflow/utils';
import { envNumber } from '@workflow/world/env-config';
import { parse, stringify, unflatten } from 'devalue';
import { monotonicFactory } from 'ulid';
import { importKey } from './encryption.js';
import {
  createFlushableState,
  flushablePipe,
  getMaxBufferedBytes,
  getMaxBytesPerBatch,
  getMaxChunksPerBatch,
  getMaxInflightChunks,
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
import {
  bytesToBase64,
  createOpenSession,
  createSealSession,
  decodeRunPublicKey,
} from './sealed-box.js';
import * as clientModule from './serialization/client.js';
import {
  type CompressionStats,
  compress,
  decompress,
} from './serialization/compression.js';
import {
  aesKeyOf,
  decrypt,
  deriveRunPayloadKeys,
  type EncryptionKeyParam,
  encrypt,
  isRunPayloadKeys,
  isSealTarget,
  type PayloadKey,
  type RunPayloadKeys,
  resolveEncryptionKey,
  runPayloadKeys,
  type SealTarget,
  sealTo,
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
  type GuestCodeStats,
  isInstanceOfPrototype,
  readProperty,
} from './serialization/hardened.js';
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
  STREAM_DRAIN_SYMBOL,
  STREAM_FRAMING_SYMBOL,
  STREAM_NAME_SYMBOL,
  STREAM_SERVER_DEPLOYMENT_ID_SYMBOL,
  STREAM_SERVER_PUBLIC_KEY_SYMBOL,
  STREAM_SERVER_RUN_ID_SYMBOL,
  STREAM_TYPE_SYMBOL,
  WEBHOOK_RESPONSE_WRITABLE,
} from './symbols.js';
import * as Attr from './telemetry/semantic-conventions.js';
import { getActiveSpan, getSpanKind, recordElapsedSpan } from './telemetry.js';
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
  compress,
  decompress,
  type EncryptionKeyParam,
  // Sealed-box ('encp') key variants: see serialization/encryption.ts.
  type PayloadKey,
  type RunPayloadKeys,
  type SealTarget,
  sealTo,
  runPayloadKeys,
  deriveRunPayloadKeys,
  isSealTarget,
  isRunPayloadKeys,
  aesKeyOf,
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

/**
 * Emit compression telemetry onto the active span after a (de)serialize.
 *
 * The compression layer populates `stats` only when it actually ran (binary
 * data on a spec >= 5 path); legacy / v1Compat paths leave it unrecorded, so
 * this no-ops for them and avoids the `getActiveSpan` lookup. Attributes land
 * on whatever span is active, typically the dedicated `step.dehydrate` /
 * `step.hydrate` span, otherwise the enclosing run/start span.
 */
async function recordCompression(
  stats: CompressionStats,
  operation: 'serialize' | 'deserialize'
): Promise<void> {
  if (!stats.recorded) return;
  // Telemetry must never break the serialize/deserialize data path: a
  // missing/failing tracer is purely an observability loss.
  try {
    const span = await getActiveSpan();
    if (!span) return;
    const uncompressedBytes = stats.uncompressedBytes ?? 0;
    const storedBytes = stats.storedBytes ?? 0;
    span.setAttributes({
      ...Attr.SerializationOperation(operation),
      ...Attr.SerializationCompressed(stats.compressed ?? false),
      ...Attr.SerializationCodec(stats.codec ?? 'none'),
      ...Attr.SerializationUncompressedBytes(uncompressedBytes),
      ...Attr.SerializationStoredBytes(storedBytes),
      ...(stats.compressed && uncompressedBytes > 0
        ? Attr.SerializationCompressionRatio(
            1 - storedBytes / uncompressedBytes
          )
        : {}),
    });
  } catch {
    // ignore telemetry failures
  }
}

/**
 * Emits OTel span attributes for workflow (guest) code executions that the
 * hardened serializer could not avoid (getters, proxies, custom
 * serializers). No-ops when serialization was fully side-effect free,
 * the common case. Same never-break-the-data-path contract as
 * `recordCompression` above.
 */
async function recordGuestCodeExecutions(stats: GuestCodeStats): Promise<void> {
  if (stats.executions.length === 0) return;
  try {
    const span = await getActiveSpan();
    if (!span) return;
    const details = [
      ...new Set(
        stats.executions.map((e) =>
          e.detail ? `${e.kind} (${e.detail})` : e.kind
        )
      ),
    ];
    span.setAttributes({
      ...Attr.SerializationGuestCodeExecutions(stats.executions.length),
      ...Attr.SerializationGuestCodeDetails(details),
    });
  } catch {
    // ignore telemetry failures
  }
}

export function getSerializeStream(
  reducers: Partial<Reducers>,
  cryptoKey: EncryptionKeyParam
): TransformStream<any, Uint8Array> {
  const encoder = new TextEncoder();
  // Resolve the key input once on first use and cache the result.
  // Note: if resolving cryptoKey rejects (e.g., network error fetching
  // the derived key), the rejection won't surface until the first chunk
  // is processed, not at stream construction time.
  const keyState = {
    resolved: false,
    key: undefined as PayloadKey | undefined,
  };
  // Set when the resolved key is a seal target; amortizes the KEM across all
  // frames this stream instance writes.
  let sealSession: ReturnType<typeof createSealSession> | undefined;
  const stream = new TransformStream<any, Uint8Array>({
    async transform(chunk, controller) {
      try {
        if (!keyState.resolved) {
          keyState.key = await resolveEncryptionKey(cryptoKey);
          keyState.resolved = true;
          if (isSealTarget(keyState.key)) {
            sealSession = createSealSession(
              keyState.key.recipientPublicKey,
              keyState.key.aad
            );
          }
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
        //
        // Every frame gets a fresh random nonce. Never switch this to a
        // counter: a stream reconnect or a durable replay restarts the writer,
        // which would repeat `(key, nonce)` and catastrophically break
        // AES-GCM.
        //
        // On the sealed path the KEM is amortized across the stream via a
        // session (one ECDH per writer instead of one per frame). That is safe
        // precisely because the nonces stay random, and because the session is
        // scoped to this stream instance: a replayed or reconnected writer
        // builds a new one and never inherits a previous content key.
        if (sealSession) {
          prefixed = encodeWithFormatPrefix(
            SerializationFormat.SEALED,
            await sealSession.seal(prefixed)
          ) as Uint8Array;
        } else if (keyState.key) {
          prefixed = (await encrypt(prefixed, keyState.key)) as Uint8Array;
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
  // Resolve the key input once on first use and cache the result.
  const keyState = {
    resolved: false,
    key: undefined as PayloadKey | undefined,
  };
  // Mirror of the writer's seal session: every frame from one writer carries
  // the same ephemeral public key, so this turns an ECDH per frame into an
  // ECDH per writer.
  let openSession: ReturnType<typeof createOpenSession> | undefined;

  function appendToBuffer(data: Uint8Array) {
    const newBuffer = new Uint8Array(buffer.length + data.length);
    newBuffer.set(buffer, 0);
    newBuffer.set(data, buffer.length);
    buffer = newBuffer;
  }

  async function processFrames(
    controller: TransformStreamDefaultController<any>
  ) {
    // Resolve the key input once on first use and cache the result
    if (!keyState.resolved) {
      keyState.key = await resolveEncryptionKey(cryptoKey);
      keyState.resolved = true;
      if (isRunPayloadKeys(keyState.key)) {
        openSession = createOpenSession(keyState.key.keyPair, keyState.key.aad);
      }
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

      // If the frame payload is encrypted or sealed, recover it first to
      // reveal the inner format-prefixed data (e.g., 'devl' + serialized
      // text), then fall through to the normal deserialization path.
      if (
        format === SerializationFormat.ENCRYPTED ||
        format === SerializationFormat.SEALED
      ) {
        const sealed = format === SerializationFormat.SEALED;
        // A sealed frame needs the run's keypair; a symmetric frame needs an
        // AES key. Report the shortfall precisely: "no key at all" and "the
        // wrong kind of key" have distinct causes.
        const usable = sealed
          ? isRunPayloadKeys(keyState.key)
          : aesKeyOf(keyState.key) !== undefined;
        if (!usable) {
          controller.error(
            new RuntimeDecryptionError(
              sealed
                ? 'Sealed stream data encountered but no run keypair is available. ' +
                    "Opening a sealed frame requires the run's own encryption key material."
                : 'Encrypted stream data encountered but no encryption key is available. ' +
                    'Encryption is not configured or no key was provided for this run.',
              {
                context: {
                  operation: 'decrypt',
                  byteLength: payload.byteLength,
                  formatPrefix: sealed ? 'encp' : 'encr',
                },
              }
            )
          );
          return;
        }
        let decrypted: Uint8Array;
        try {
          // Sealed frames go through the session so repeated frames from one
          // writer reuse a single decapsulation. Everything else delegates to
          // the shared envelope layer, keeping the two schemes in lockstep
          // with the one-shot path.
          decrypted = sealed
            ? await openSession!.open(decodeFormatPrefix(frameData).payload)
            : ((await decrypt(frameData, keyState.key)) as Uint8Array);
        } catch (error) {
          // The low-level crypto layer only sees the stripped payload, so it
          // cannot record the outer envelope prefix. We peeked it here, so
          // enrich the diagnostic context with the real format prefix before
          // propagating, mirroring serialization/encryption.ts.
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

// ============================================================================
// Byte-stream wire framing
// ============================================================================
//
// Byte streams (`type: 'bytes'` ReadableStreams passed across boundaries)
// are written to the underlying world's stream transport one user chunk at
// a time. Without an in-band envelope, the reader sees a flat stream of
// bytes: there is no way to tell where one user chunk ends and the next
// begins, which makes mid-stream reconnect impossible (we don't know how
// many server-side chunks have been consumed).
//
// To enable transparent reconnect, this PR introduces an opt-in wire
// envelope that wraps each user chunk in a length-prefix:
//
//   [4-byte big-endian length][user payload bytes]
//
// The envelope is identical in shape to `getSerializeStream`'s framing,
// but the payload here is *raw user bytes*: there is no inner
// format-prefix, no devalue, no encryption. A framed byte stream stays
// semantically a byte stream end-to-end; the framing is purely transport.
//
// The decision to use framing for a given stream is recorded in the
// serialized stream ref (`framing: 'framed-v1'`), so both sides agree on
// the wire format without runtime negotiation. Producers that target a
// run whose deployment doesn't support framing (see `getRunCapabilities`
// in capabilities.ts) emit raw bytes and a ref without the field, which
// the reader treats as legacy raw bytes for backwards compatibility.

/**
 * Maximum allowed byte-stream frame payload size (100MB). Shared by the
 * framer (rejects oversized user chunks at write time, where the error is
 * actionable) and the unframer (rejects oversized length headers at read
 * time, which usually indicate a non-framed wire being read as framed).
 * Keeping both sides on one constant guarantees any chunk the framer
 * accepts can always be decoded by the unframer.
 */
const MAX_FRAME_SIZE = 100_000_000;

/**
 * Wraps each chunk of a byte stream in a 4-byte big-endian length
 * prefix. Used by the producer side of a framed byte-stream pipe.
 *
 * Empty chunks (length 0) are dropped: the resulting `[0x00 0x00 0x00 0x00]`
 * frame would be ambiguous with the legacy "looks framed" detection in
 * `getDeserializeStream`, and it carries no information.
 *
 * Load-bearing invariant: each user chunk becomes exactly one frame, and
 * each frame is enqueued as exactly one transport chunk (the downstream
 * writable performs one wire write per chunk, preserving boundaries). The
 * server therefore stores one frame per chunk index, which is what allows
 * a future reconnecting reader to resume a framed byte stream at
 * `startIndex + consumedFrames`, the same arithmetic
 * `createReconnectingFramedStream` relies on for object streams. Do not
 * coalesce or split frames here without revisiting that resume logic.
 */
export function getByteFramingStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length === 0) return;
      if (chunk.length > MAX_FRAME_SIZE) {
        controller.error(
          new WorkflowRuntimeError(
            `Byte-stream chunk of ${chunk.length} bytes exceeds the maximum ` +
              `framed chunk size (${MAX_FRAME_SIZE}). Split the data into ` +
              `smaller chunks before writing.`,
            { slug: 'serialization-failed' }
          )
        );
        return;
      }
      const frame = new Uint8Array(FRAME_HEADER_SIZE + chunk.length);
      new DataView(frame.buffer).setUint32(0, chunk.length, false);
      frame.set(chunk, FRAME_HEADER_SIZE);
      controller.enqueue(frame);
    },
  });
}

/**
 * Unwraps length-prefixed byte-stream frames back into the original user
 * chunks. Used by the consumer side of a framed byte-stream pipe.
 *
 * Buffers across read boundaries, since the transport may split a single
 * frame across multiple reads (header in one chunk, payload in another)
 * or coalesce multiple frames into a single read. The transform emits
 * whole user chunks regardless of transport chunking.
 *
 * Errors the stream if the length header advertises a frame larger than
 * `MAX_FRAME_SIZE` bytes, since that almost certainly indicates a
 * misframed wire (e.g. a raw byte stream being fed through this transform
 * by mistake) and we don't want to allocate an enormous buffer.
 */
export function getByteUnframingStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  let buffer = new Uint8Array(0);

  function appendToBuffer(data: Uint8Array) {
    const next = new Uint8Array(buffer.length + data.length);
    next.set(buffer, 0);
    next.set(data, buffer.length);
    buffer = next;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.length > 0) appendToBuffer(chunk);

      while (buffer.length >= FRAME_HEADER_SIZE) {
        const frameLength = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength
        ).getUint32(0, false);

        if (frameLength > MAX_FRAME_SIZE) {
          controller.error(
            new WorkflowRuntimeError(
              `Byte-stream frame length ${frameLength} exceeds maximum (${MAX_FRAME_SIZE}). ` +
                `This usually means a non-framed byte stream is being read as framed.`,
              { slug: 'serialization-failed' }
            )
          );
          return;
        }

        const total = FRAME_HEADER_SIZE + frameLength;
        if (buffer.length < total) break;

        controller.enqueue(buffer.slice(FRAME_HEADER_SIZE, total));
        buffer = buffer.slice(total);
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.error(
          new WorkflowRuntimeError(
            `Byte-stream ended with ${buffer.length} bytes of incomplete frame data. ` +
              `The stream was truncated mid-frame.`,
            { slug: 'serialization-failed' }
          )
        );
      }
    },
  });
}

/**
 * Emit the client-observed end-to-end time-to-first-chunk span for a live read:
 * read dispatch (`startEpochMs`) → the first non-empty chunk reaching the
 * reader, including the network hop. Fire-and-forget; no-op without OTEL.
 */
function recordReadTimeToFirstChunk(
  startEpochMs: number,
  runId: string,
  name: string,
  startIndex?: number,
  connectMs?: number
): void {
  void (async () => {
    await recordElapsedSpan('workflow.stream.read', startEpochMs, {
      kind: await getSpanKind('CLIENT'),
      attributes: {
        'workflow.run.id': runId,
        'workflow.stream.name': name,
        'workflow.stream.operation': 'read',
        'workflow.stream.read.ttfc_ms': Date.now() - startEpochMs,
        ...(typeof connectMs === 'number'
          ? { 'workflow.stream.read.connect_ms': connectMs }
          : {}),
        ...(typeof startIndex === 'number'
          ? { 'workflow.stream.start_index': startIndex }
          : {}),
      },
    });
  })();
}

/**
 * Emit the client-observed read-completion span when a stream read drains:
 * back-dated to the read dispatch, so its duration is the total read, with
 * chunk/byte counts for throughput. Cancelled reads emit nothing. Fire-and-
 * forget; no-op without OTEL.
 */
function recordStreamReadComplete(
  startEpochMs: number,
  runId: string,
  name: string,
  chunkCount: number,
  byteCount: number,
  reconnects?: number
): void {
  void (async () => {
    await recordElapsedSpan('workflow.stream.read.complete', startEpochMs, {
      kind: await getSpanKind('CLIENT'),
      attributes: {
        'workflow.run.id': runId,
        'workflow.stream.name': name,
        'workflow.stream.operation': 'read_complete',
        'workflow.stream.read.total_ms': Date.now() - startEpochMs,
        'workflow.stream.read.chunks': chunkCount,
        'workflow.stream.read.bytes': byteCount,
        ...(typeof reconnects === 'number'
          ? { 'workflow.stream.read.reconnects': reconnects }
          : {}),
      },
    });
  })();
}

export class WorkflowServerReadableStream extends ReadableStream<Uint8Array> {
  #reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(runId: string, name: string, startIndex?: number) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new WorkflowRuntimeError(`"name" is required, got "${name}"`);
    }
    // Client-observed time-to-first-chunk state. `readStart` is stamped when the
    // reader starts consuming (first pull → the read dispatch); the span is
    // emitted once, when the first non-empty chunk reaches the reader. So its
    // duration is the end-to-end TTFC including the network hop. No-op without
    // an OpenTelemetry SDK registered.
    let readStart: number | undefined;
    let firstChunkReported = false;
    // Client-observed connect duration: the world.streams.get await (read
    // dispatch -> stream handle / response headers). Stamped on the
    // workflow.stream.read span once the first chunk arrives.
    let connectMs: number | undefined;
    // Read-completion counters for the workflow.stream.read.complete span
    // emitted when the stream drains.
    let chunksDelivered = 0;
    let bytesDelivered = 0;
    super({
      // @ts-expect-error Not sure why TypeScript is complaining about this
      type: 'bytes',

      pull: async (controller) => {
        let reader = this.#reader;
        if (!reader) {
          if (readStart === undefined) readStart = Date.now();
          const world = await getWorldLazy();
          const connectStart = Date.now();
          const stream = await world.streams.get(runId, name, startIndex);
          connectMs = Date.now() - connectStart;
          reader = this.#reader = stream.getReader();
        }
        if (!reader) {
          controller.error(new Error('Failed to get reader'));
          return;
        }

        const result = await reader.read();
        if (result.done) {
          this.#reader = undefined;
          if (readStart !== undefined) {
            recordStreamReadComplete(
              readStart,
              runId,
              name,
              chunksDelivered,
              bytesDelivered
            );
          }
          controller.close();
        } else {
          // The server flushes a leading zero-length chunk (v3+) to commit
          // response headers before any data; skip empties so TTFC measures to
          // the first real chunk.
          if (
            !firstChunkReported &&
            result.value.byteLength > 0 &&
            readStart !== undefined
          ) {
            firstChunkReported = true;
            recordReadTimeToFirstChunk(
              readStart,
              runId,
              name,
              startIndex,
              connectMs
            );
          }
          chunksDelivered += 1;
          bytesDelivered += result.value.byteLength;
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
 * Maximum consecutive reconnect attempts for a single framed stream session.
 * The counter resets to zero whenever a reconnect makes forward progress (a
 * frame is delivered), so this bounds *consecutive* failures, not the lifetime
 * total: a long-lived serverless stream may legitimately reconnect far more
 * than this many times as long as each reconnect keeps delivering data. We only
 * give up after this many reconnects in a row produce nothing.
 */
export const FRAMED_STREAM_MAX_RECONNECTS = 50;

/** Effective consecutive-reconnect cap. Override: `WORKFLOW_FRAMED_STREAM_MAX_RECONNECTS`. */
const getFramedStreamMaxReconnects = (): number =>
  envNumber(
    'WORKFLOW_FRAMED_STREAM_MAX_RECONNECTS',
    FRAMED_STREAM_MAX_RECONNECTS,
    {
      integer: true,
      min: 1,
    }
  );

/**
 * Absolute backstop on total reconnects for a single session, independent of
 * progress. The consecutive cap above resets on forward progress, which is
 * correct for a well-behaved backend that honors `startIndex`. But if a World's
 * `streams.get` ever ignored `startIndex` and re-delivered earlier chunks,
 * "progress" would be reported every reconnect and the consecutive cap would
 * never trip, turning a bounded failure into an unbounded reconnect loop. This
 * hard ceiling guarantees the loop always terminates. It is set high enough
 * (hours of streaming at realistic per-session timeouts) to never interfere
 * with legitimate long-lived streams.
 */
export const FRAMED_STREAM_MAX_TOTAL_RECONNECTS = 1000;

/** Effective total-reconnect backstop. Override: `WORKFLOW_FRAMED_STREAM_MAX_TOTAL_RECONNECTS`. */
const getFramedStreamMaxTotalReconnects = (): number =>
  envNumber(
    'WORKFLOW_FRAMED_STREAM_MAX_TOTAL_RECONNECTS',
    FRAMED_STREAM_MAX_TOTAL_RECONNECTS,
    { integer: true, min: 1 }
  );

/**
 * Wraps the length-prefix-framed byte stream from `world.streams.get` with
 * transparent auto-reconnect.
 *
 * Every fully-decoded outer frame corresponds to exactly one server-side
 * chunk (the serialize transform enqueues one frame per workflow write, and
 * the writable buffers one frame per chunk when multi-writing). The wrapper
 * counts completed frames and, on upstream error, reopens the connection
 * with `startIndex = resolvedStartIndex + consumedFrames`. Partial-frame
 * bytes buffered before the cut are discarded; the server will resend the
 * in-flight chunk in full from the new startIndex.
 *
 * A clean upstream close (EOF with no error) is NOT trusted as completion
 * on its own: some transport paths normalize a mid-stream abort into a
 * graceful end (observed in production on Vercel response streaming, where
 * the server's max-duration abort arrives at the client as a clean EOF).
 * On EOF the wrapper verifies against the stream's authoritative metadata
 * (`streams.getInfo`) that the stream is complete AND that every chunk up to
 * `done` was delivered; otherwise it reconnects from the next chunk exactly
 * like an errored connection. If the metadata read itself fails, the EOF is
 * trusted (legacy behavior) rather than failing a read that may well be
 * complete.
 *
 * Negative `startIndex` values (last-N semantics) skip the reconnect
 * machinery because we cannot compute an absolute resume position without
 * a tail-index lookup; the returned stream behaves as a single-shot read.
 */
export function createReconnectingFramedStream(
  runId: string,
  name: string,
  startIndex?: number
): ReadableStream<Uint8Array> {
  const reconnectSupported = startIndex === undefined || startIndex >= 0;
  let currentStartIndex = startIndex ?? 0;
  let consumedFrames = 0;
  let reconnectCount = 0;
  let totalReconnectCount = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffer = new Uint8Array(0);
  // Read telemetry (same semantics as WorkflowServerReadableStream):
  // dispatch time, first-connect duration, first-frame latch, and totals.
  let readStart: number | undefined;
  let connectMs: number | undefined;
  let firstChunkReported = false;
  let chunksDelivered = 0;
  let bytesDelivered = 0;

  async function connect(): Promise<void> {
    const world = await getWorldLazy();
    const effectiveStartIndex = reconnectSupported
      ? currentStartIndex + consumedFrames
      : startIndex;
    const connectStart = Date.now();
    const stream = await world.streams.get(runId, name, effectiveStartIndex);
    if (connectMs === undefined) connectMs = Date.now() - connectStart;
    reader = stream.getReader();
  }

  /**
   * Whether an upstream EOF represents genuine completion: the stream's
   * authoritative metadata says it is done AND the frames delivered so far
   * cover every chunk up to the tail (one outer frame == one server chunk).
   * A metadata failure trusts the EOF, since turning a healthy completion
   * into an error (or a reconnect loop) on a transient metadata blip would
   * be worse than the legacy behavior this check guards against.
   */
  async function isVerifiedComplete(): Promise<boolean> {
    try {
      const world = await getWorldLazy();
      const info = await world.streams.getInfo(runId, name);
      return info.done && currentStartIndex + consumedFrames > info.tailIndex;
    } catch {
      return true;
    }
  }

  async function reconnect(): Promise<void> {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader = undefined;
    }
    // Advance the resume position past the frames already delivered, then
    // drop any partial-frame bytes: the reopened connection re-sends from a
    // frame boundary at the new index.
    currentStartIndex += consumedFrames;
    consumedFrames = 0;
    buffer = new Uint8Array(0);

    // Retry the reopen itself against the reconnect budget. A transient
    // failure of connect() (the server briefly unavailable during the
    // reconnect window) is the exact blip this wrapper exists to survive, so
    // count it against the budget and try again rather than treating it as
    // fatal. Only budget exhaustion (a server that stays down) terminates the
    // stream.
    const maxReconnects = getFramedStreamMaxReconnects();
    const maxTotalReconnects = getFramedStreamMaxTotalReconnects();
    for (;;) {
      reconnectCount++;
      totalReconnectCount++;
      if (reconnectCount > maxReconnects) {
        throw new Error(
          `Stream "${name}" exceeded maximum reconnection attempts (${maxReconnects})`
        );
      }
      if (totalReconnectCount > maxTotalReconnects) {
        throw new Error(
          `Stream "${name}" exceeded maximum total reconnection attempts (${maxTotalReconnects})`
        );
      }
      try {
        await connect();
        return;
      } catch (error) {
        // Retention expiry is terminal and retrying cannot restore the stream.
        // Preserve the typed error immediately instead of turning one 410 into
        // 50 reconnect attempts and a generic budget-exhaustion error.
        if (StreamExpiredError.is(error)) throw error;
        // Reopen failed transiently; loop to retry, counting against the
        // budget so a server that never recovers still terminates the stream.
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (readStart === undefined) readStart = Date.now();
      // Loop until we emit something, hit EOF, or fatally error. Reads that
      // only extend the in-flight-frame buffer don't enqueue anything; we
      // keep reading rather than returning empty-handed.
      for (;;) {
        if (!reader) {
          try {
            await connect();
          } catch (err) {
            controller.error(err);
            return;
          }
        }

        let result: { done: boolean; value?: Uint8Array };
        try {
          // biome-ignore lint/style/noNonNullAssertion: connect() guarantees reader
          result = await reader!.read();
        } catch (err) {
          if (!reconnectSupported) {
            controller.error(err);
            return;
          }
          try {
            await reconnect();
          } catch (reconnectErr) {
            controller.error(reconnectErr);
            return;
          }
          continue;
        }

        if (result.done || !result.value) {
          reader = undefined;
          // A clean EOF is only trustworthy if the stream is actually
          // complete and this session delivered every chunk up to `done`.
          // Infrastructure can normalize a mid-stream abort into a graceful
          // end (the server's max-duration cut is designed to arrive as an
          // errored body, but on some paths it reaches the client as a clean
          // EOF), and a completed stream can still be cut mid-body; both
          // would otherwise be silently read as a shorter, complete stream.
          if (reconnectSupported && !(await isVerifiedComplete())) {
            try {
              await reconnect();
            } catch (reconnectErr) {
              controller.error(reconnectErr);
              return;
            }
            continue;
          }
          // Genuine end-of-stream. Drop any partial-frame bytes (there
          // shouldn't be any; a well-formed stream ends on a frame boundary).
          if (readStart !== undefined) {
            recordStreamReadComplete(
              readStart,
              runId,
              name,
              chunksDelivered,
              bytesDelivered,
              totalReconnectCount
            );
          }
          controller.close();
          return;
        }

        // Append to buffer and emit all complete frames.
        const incoming = result.value;
        if (incoming.length > 0) {
          const combined = new Uint8Array(buffer.length + incoming.length);
          combined.set(buffer, 0);
          combined.set(incoming, buffer.length);
          buffer = combined;
        }

        let emitted = false;
        while (buffer.length >= FRAME_HEADER_SIZE) {
          const frameLength = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
          ).getUint32(0, false);
          const total = FRAME_HEADER_SIZE + frameLength;
          if (buffer.length < total) break;
          // Forward the entire framed chunk (header + payload) to the
          // downstream deserializer, which already expects this layout.
          controller.enqueue(buffer.slice(0, total));
          buffer = buffer.slice(total);
          consumedFrames++;
          chunksDelivered++;
          bytesDelivered += total;
          if (!firstChunkReported && readStart !== undefined) {
            firstChunkReported = true;
            recordReadTimeToFirstChunk(
              readStart,
              runId,
              name,
              startIndex,
              connectMs
            );
          }
          emitted = true;
        }

        if (emitted) {
          // Forward progress on the current connection: clear the
          // consecutive-failure budget so a long stream that reconnects
          // many times (but keeps delivering) is never falsely capped.
          reconnectCount = 0;
          return;
        }
        // Only partial bytes: read more.
      }
    },
    cancel: async () => {
      if (reader) {
        await reader.cancel().catch((err) => {
          console.warn('Error closing ReadableStream reader:', err);
        });
        reader = undefined;
      }
    },
  });
}

/**
 * Default group-commit window for the LEADING chunk of an idle stream.
 *
 * 0 = dispatch the first chunk immediately. Measured production producer
 * rates (most agents: ~1.2 chunks per flush, >70% of chunks arriving more
 * than 10ms after the previous request already finished) show a fixed
 * leading-edge window taxes isolated-chunk delivery (~+20% on a ~50ms RTT)
 * while batching almost nothing for slow producers; fast producers get
 * their batching from in-flight accumulation regardless. Setting a positive
 * interval (env or `world.streamFlushIntervalMs`) opts a deployment into
 * windowed leading-edge batching, trading first-chunk latency for larger
 * groups.
 */
const STREAM_FLUSH_INTERVAL_MS = 0;

/**
 * `WORKFLOW_STREAM_FLUSH_INTERVAL_MS`, when set, overrides
 * `world.streamFlushIntervalMs`; when unset the World option (or the
 * default) governs. Returns `undefined` for unset/invalid values so the
 * caller can fall through to the World option.
 */
const getEnvStreamFlushIntervalMs = (): number | undefined => {
  const value = envNumber('WORKFLOW_STREAM_FLUSH_INTERVAL_MS', Number.NaN, {
    integer: true,
  });
  return Number.isNaN(value) ? undefined : value;
};

/**
 * Emit the client-observed span for one flushed batch of stream writes: first
 * `write()` of the batch (`startEpochMs`) → the server write settling. The
 * span's duration is therefore the app-perceived latency of the batch
 * (buffer dwell + backpressure + RPC); `buffer_dwell_ms` isolates the
 * pre-dispatch share so client-side batching cost can be told apart from
 * network/server time. Named `workflow.stream.flush`; the per-request RPC
 * beneath it is world-vercel's `workflow.stream.write` span (chunk_rtt), and
 * the two must stay distinguishable. Fire-and-forget; no-op without OTEL.
 */
function recordStreamWriteFlush(
  startEpochMs: number,
  dispatchEpochMs: number,
  runId: string,
  name: string,
  chunkCount: number,
  byteCount: number,
  rpcMs: number
): void {
  void (async () => {
    await recordElapsedSpan('workflow.stream.flush', startEpochMs, {
      kind: await getSpanKind('CLIENT'),
      attributes: {
        'workflow.run.id': runId,
        'workflow.stream.name': name,
        'workflow.stream.operation': 'flush',
        'workflow.stream.flush.buffer_dwell_ms': dispatchEpochMs - startEpochMs,
        'workflow.stream.flush.chunks': chunkCount,
        'workflow.stream.flush.bytes': byteCount,
        // Client-observed World write RPC duration (network hop included).
        // Same key as world-vercel's per-request span attribute so queries
        // work regardless of which layer emitted it.
        'workflow.stream.write.chunk_rtt': rpcMs,
      },
    });
  })();
}

/**
 * Emit the client-observed span for the stream-close RPC: its duration is the
 * `world.streams.close` round trip (network hop included). Fire-and-forget;
 * no-op without OTEL.
 */
function recordStreamClose(
  startEpochMs: number,
  runId: string,
  name: string
): void {
  void (async () => {
    await recordElapsedSpan('workflow.stream.close', startEpochMs, {
      kind: await getSpanKind('CLIENT'),
      attributes: {
        'workflow.run.id': runId,
        'workflow.stream.name': name,
        'workflow.stream.operation': 'close',
        'workflow.stream.close.rpc_ms': Date.now() - startEpochMs,
      },
    });
  })();
}

export class WorkflowServerWritableStream extends WritableStream<Uint8Array> {
  /**
   * @param runReadyBarrier Turbo mode only: a promise that resolves once the
   * backgrounded `run_started` has landed. When the step body runs
   * optimistically (before `run_started` is durable), the first chunk write to
   * a brand-new stream would otherwise reach the World before the run exists
   * and be rejected as run-not-found. Awaiting this once before the first
   * flush/close orders the write after the run's creation. `undefined` outside
   * turbo and on the await path, where the run was already durable.
   */
  constructor(runId: string, name: string, runReadyBarrier?: Promise<unknown>) {
    if (typeof runId !== 'string') {
      throw new WorkflowRuntimeError(
        `"runId" must be a string, got "${typeof runId}"`
      );
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new WorkflowRuntimeError(`"name" is required, got "${name}"`);
    }
    const worldPromise = getWorldLazy();

    // Hold the first server write until the run exists (turbo optimistic
    // start). Awaited once, then cleared so later flushes pay nothing. The
    // rejection is swallowed for ordering only: if `run_started` truly failed
    // the run does not exist, so the write below surfaces the real error.
    let pendingRunReady: Promise<unknown> | undefined = runReadyBarrier;
    const ensureRunReady = async (): Promise<void> => {
      if (pendingRunReady) {
        try {
          await pendingRunReady;
        } catch {
          // intentional: ordering barrier only, see above.
        }
        pendingRunReady = undefined;
      }
    };

    // ------------------------------------------------------------------
    // Group-commit buffering.
    //
    // `write()` resolves as soon as the chunk enters this bounded buffer,
    // NOT when it is durable. That is the property that makes batching
    // path-independent: a native `readable.pipeTo(serverWritable)` pulls the
    // next chunk the moment `write()` resolves, so chunks accumulate here
    // during the flush-timer window and while a server request is in
    // flight, and each accumulated group goes out as one `writeMulti`.
    // (Previously `write()` resolved only after the timer AND the server
    // round trip, so native piping serialized to one request per chunk and
    // batching only worked through `flushablePipe`'s bespoke coalescing.)
    //
    // Durability has a dedicated barrier instead: `drain()` (exposed via
    // {@link STREAM_DRAIN_SYMBOL}) resolves only when the buffer is empty
    // and no request is in flight. `close()` awaits it before closing the
    // server stream, and the flushable-stream lock-release completion
    // awaits it before letting a step finish, so "step completed" still
    // implies "stream data durable", exactly as before.
    //
    // Encryption/decryption is handled at the framing level by
    // getSerializeStream/getDeserializeStream, not here.
    // ------------------------------------------------------------------
    let buffer: Uint8Array[] = [];
    let bufferBytes = 0;
    // The group currently inside a server request. Counted against the
    // buffer bound so `WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS` keeps its
    // documented meaning (an upper bound across ALL read-but-not-durable
    // chunks), not just the queued follow-up group.
    let inFlightChunks = 0;
    let inFlightBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** The in-flight dispatch chain. At most one, preserving chunk order. */
    let inFlight: Promise<void> | null = null;
    /**
     * Sticky failure: once a dispatch fails, the failed group is re-queued
     * (retained, exactly as the previous implementation retained its buffer)
     * and every subsequent `write()`, `close()` and `drain()` rejects with
     * the original error. Chunks whose `write()` already resolved surface
     * their failure at the durability barrier: that is the contract of an
     * early-ack sink.
     */
    let sinkError: unknown;
    // Group-commit window. The env var, when set, overrides the World
    // option; otherwise `world.streamFlushIntervalMs` governs (default 0),
    // including the first chunk. When it must come from the world,
    // `scheduleGroupCommit` waits for `worldPromise` before deciding, which
    // costs nothing: no request can leave before `sendGroup`'s own world
    // await either.
    let resolvedFlushIntervalMs = getEnvStreamFlushIntervalMs();
    let _flushIntervalResolution: Promise<void> | null = null;
    // Per-request wire limits (server caps) and the buffer bound. The bound
    // uses the same knobs the coalescing pipe used, so producer backpressure
    // behavior is unchanged: once a request-worth of chunks (or the byte
    // bound) is buffered, `write()` blocks until a group lands durably.
    const maxChunksPerRequest = getMaxChunksPerBatch();
    const maxBytesPerRequest = getMaxBytesPerBatch();
    const maxBufferedChunks = getMaxInflightChunks();
    const maxBufferedBytes = getMaxBufferedBytes();
    // Client-observed write-batch timing: stamped when the buffer goes
    // empty→non-empty, consumed by the group that carries that chunk out.
    let bufferT0: number | undefined;

    type Waiter = { resolve: () => void; reject: (err: unknown) => void };
    /** write() calls blocked on the buffer bound. */
    let capacityWaiters: Waiter[] = [];
    /** drain() calls waiting for full durability. */
    let drainWaiters: Waiter[] = [];

    const rejectWaiters = (err: unknown): void => {
      const all = [...capacityWaiters, ...drainWaiters];
      capacityWaiters = [];
      drainWaiters = [];
      for (const w of all) w.reject(err);
    };

    /**
     * Take the largest leading group that fits one request: at most
     * `maxChunksPerRequest` chunks and `maxBytesPerRequest` cumulative bytes
     * (a single oversized chunk still goes out alone).
     */
    const takeGroup = (): { group: Uint8Array[]; bytes: number } => {
      let count = 0;
      let bytes = 0;
      for (const chunk of buffer) {
        if (count >= maxChunksPerRequest) break;
        if (count > 0 && bytes + chunk.byteLength > maxBytesPerRequest) break;
        count++;
        bytes += chunk.byteLength;
      }
      const group = buffer.slice(0, count);
      buffer = buffer.slice(count);
      bufferBytes -= bytes;
      return { group, bytes };
    };

    /**
     * Dispatch loop: while chunks are buffered, send them group by group.
     * Exactly one loop runs at a time (`inFlight`), so groups reach the
     * server in write order. Chunks that arrive while a group's request is
     * in flight accumulate and form the next group: the group-commit
     * behavior, now independent of how the producer pipes.
     */
    /**
     * Send one group to the server: gate on run readiness, then one
     * `writeMulti` (or sequential `write`s when the world lacks it). Emits
     * the write-flush span; dwell is measured up to just before the RPC so a
     * turbo run-ready barrier wait counts as buffer dwell, matching the
     * pre-group-commit telemetry.
     */
    const sendGroup = async (
      group: Uint8Array[],
      bytes: number,
      groupT0: number | undefined
    ): Promise<void> => {
      await ensureRunReady();
      const world = await worldPromise;
      const dispatchAt = Date.now();
      if (typeof world.streams.writeMulti === 'function' && group.length > 1) {
        await world.streams.writeMulti(runId, name, group);
      } else {
        // Fall back to sequential writes
        for (const chunk of group) {
          await world.streams.write(runId, name, chunk);
        }
      }
      if (groupT0 !== undefined) {
        recordStreamWriteFlush(
          groupT0,
          dispatchAt,
          runId,
          name,
          group.length,
          bytes,
          Date.now() - dispatchAt
        );
      }
    };

    const dispatchLoop = async (): Promise<void> => {
      while (buffer.length > 0) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const groupT0 = bufferT0;
        const groupTakenAt = Date.now();
        const { group, bytes } = takeGroup();
        inFlightChunks = group.length;
        inFlightBytes = bytes;
        bufferT0 = buffer.length > 0 ? groupTakenAt : undefined;

        try {
          await sendGroup(group, bytes, groupT0);
          inFlightChunks = 0;
          inFlightBytes = 0;
        } catch (error) {
          // Retain the failed group (and its original t0) at the front of
          // the buffer, poison the sink, and surface the failure to every
          // blocked writer and drain waiter.
          buffer = group.concat(buffer);
          bufferBytes += bytes;
          inFlightChunks = 0;
          inFlightBytes = 0;
          bufferT0 =
            groupT0 !== undefined && bufferT0 !== undefined
              ? Math.min(groupT0, bufferT0)
              : (groupT0 ?? bufferT0);
          throw error;
        }

        // This group is durable: relieve writers blocked on the bound (they
        // re-check it and may block again).
        const relieved = capacityWaiters;
        capacityWaiters = [];
        for (const w of relieved) w.resolve();
      }
    };

    /** Start (or join) the dispatch chain. Never leaves an unhandled rejection. */
    const startDispatch = (): void => {
      if (inFlight || sinkError !== undefined || buffer.length === 0) return;
      inFlight = dispatchLoop().then(
        () => {
          inFlight = null;
          // A write can land in the microtask gap between the loop's
          // empty-buffer exit and this reaction. scheduleGroupCommit saw
          // inFlight still set and armed no timer, so without this check
          // the chunk would sit stranded until a later write/close/drain.
          // Treat it like an in-request arrival: dispatch immediately (the
          // new chain settles the drain waiters when it finishes).
          if (buffer.length > 0) {
            startDispatch();
            return;
          }
          // Fully idle (the loop only exits with an empty buffer): settle
          // the durability barrier.
          const settled = drainWaiters;
          drainWaiters = [];
          for (const w of settled) w.resolve();
        },
        (error) => {
          inFlight = null;
          sinkError ??= error;
          rejectWaiters(sinkError);
        }
      );
    };

    /**
     * Leading-edge dispatch policy for an idle sink:
     * - window <= 0 (the default): dispatch the leading chunk immediately.
     *   Fast producers still batch via in-flight accumulation: chunks
     *   arriving during the request form the next group. The trade for an
     *   idle burst is one extra request (a 30-chunk burst ships as 1 + 29
     *   instead of one 30-chunk group under a positive window) in exchange
     *   for zero fixed first-chunk delay, which matches measured producer
     *   behavior, where isolated chunks dominate.
     * - window > 0 (explicitly configured): arm the group-commit timer so
     *   the leading chunk waits up to the window collecting a group,
     *   the opt-in trade for slow-but-steady producers.
     * Window resolution: `WORKFLOW_STREAM_FLUSH_INTERVAL_MS`, when set,
     * overrides `world.streamFlushIntervalMs`; otherwise the World option
     * (default 0) governs, including the first chunk. Deciding may
     * have to wait for the world to resolve; that adds no latency because
     * `sendGroup` awaits the same promise before any request leaves.
     */
    const scheduleGroupCommit = (): void => {
      if (flushTimer || inFlight) return;
      if (resolvedFlushIntervalMs === undefined) {
        // Promise.resolve: everywhere else the world is only ever awaited,
        // which tolerates a synchronous value (tests stub getWorldLazy that
        // way); .then() must be given a real promise.
        _flushIntervalResolution ??= Promise.resolve(worldPromise)
          .then(
            (world) => {
              resolvedFlushIntervalMs =
                world.streamFlushIntervalMs ?? STREAM_FLUSH_INTERVAL_MS;
            },
            () => {
              // World resolution failure surfaces on dispatch; fall back to
              // the default so buffered chunks still reach the dispatch path
              // (where the error poisons the sink).
              resolvedFlushIntervalMs = STREAM_FLUSH_INTERVAL_MS;
            }
          )
          .then(() => {
            // Re-evaluate: the buffer may have been dispatched by drain()
            // or a full-request fast path while the world resolved.
            if (buffer.length > 0) scheduleGroupCommit();
          });
        return;
      }
      if (resolvedFlushIntervalMs <= 0) {
        startDispatch();
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        startDispatch();
      }, resolvedFlushIntervalMs);
    };

    /**
     * Durability barrier: resolves when every accepted chunk has reached the
     * server and nothing is buffered or in flight; rejects with the sink's
     * sticky error if any dispatch failed. Flushes a pending group-commit
     * window immediately rather than waiting out the timer.
     */
    const drain = async (): Promise<void> => {
      while (true) {
        if (sinkError !== undefined) throw sinkError;
        if (buffer.length === 0 && !inFlight) return;
        startDispatch();
        await new Promise<void>((resolve, reject) => {
          drainWaiters.push({ resolve, reject });
        });
      }
    };

    super({
      async write(chunk) {
        if (sinkError !== undefined) throw sinkError;
        if (bufferT0 === undefined) bufferT0 = Date.now();
        buffer.push(chunk);
        bufferBytes += chunk.byteLength;

        if (
          buffer.length >= maxChunksPerRequest ||
          bufferBytes >= maxBytesPerRequest
        ) {
          // The buffered group already fills a request: no point dwelling in
          // the commit window.
          startDispatch();
        } else {
          scheduleGroupCommit();
        }

        // Bounded buffer: accept the chunk (never drop), then block until
        // the read-but-not-durable population (buffered AND in the active
        // request) is back under the bound. Each durably-sent group
        // relieves this.
        while (
          sinkError === undefined &&
          (buffer.length + inFlightChunks >= maxBufferedChunks ||
            bufferBytes + inFlightBytes >= maxBufferedBytes)
        ) {
          startDispatch();
          await new Promise<void>((resolve, reject) => {
            capacityWaiters.push({ resolve, reject });
          });
        }
        if (sinkError !== undefined) throw sinkError;
      },
      async close() {
        // Everything accepted must be durable before the server stream is
        // closed: the server fences post-close writes.
        await drain();

        // A close with an empty buffer skips the dispatch path (and its
        // barrier), but can itself be the first write to a brand-new
        // stream, so gate it too.
        await ensureRunReady();

        const world = await worldPromise;
        const closeStart = Date.now();
        await world.streams.close(runId, name);
        recordStreamClose(closeStart, runId, name);
      },
      async abort(reason) {
        // Buffered chunks were already ACKED to their writers (early-ack
        // contract), and native pipeTo aborts this sink whenever its SOURCE
        // errors, e.g. an AI stream that emits ten deltas and then throws.
        // Discarding here would silently lose the accepted tail of the
        // prefix, so deliver it first; only the server stream close is
        // skipped. A dispatch failure during this drain is already sticky
        // and surfaces through the sink's error paths.
        //
        // Deliberately un-timeboxed (unlike the step-executor's 500ms
        // inline flush): giving up early would drop acked chunks, the
        // exact loss this path exists to prevent. It is still bounded in
        // practice by the World transport's own timeout/retry budget: a
        // stalled write ends in a terminal rejection after finite retries,
        // which rejects the dispatch and lands in the catch below. The
        // same catch absorbs the expected conflict when a teardown-driven
        // abort drains into an already-terminal run.
        try {
          await drain();
        } catch {
          // sinkError is set; accepted-but-undeliverable chunks surface it.
        }
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        buffer = [];
        bufferBytes = 0;
        sinkError ??= reason ?? new Error('Stream aborted');
        // Reject blocked writers and drain waiters so nothing leaks or
        // hangs on a promise whose timer was just cleared.
        rejectWaiters(sinkError);
      },
    });

    // Durability barrier for owners that complete without closing the
    // stream: `flushablePipe`'s lock-release completion awaits this so a
    // step cannot finish (and the function suspend) while accepted chunks
    // are still client-buffered or in flight.
    Object.defineProperty(this, STREAM_DRAIN_SYMBOL, {
      value: drain,
      enumerable: false,
      writable: false,
    });
  }
}

// Re-export types from the modular serialization modules.
export type {
  ByteStreamFraming,
  Reducers,
  Revivers,
  SerializableSpecial,
} from './serialization/types.js';

// Import types locally for use within this file.
import type {
  ByteStreamFraming,
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
  const requestPrototype = once(() => getHostClassPrototype(global, 'Request'));
  const responsePrototype = once(() =>
    getHostClassPrototype(global, 'Response')
  );
  // Class/Instance MUST come before Error so that custom Error subclasses
  // with WORKFLOW_SERIALIZE take precedence (devalue uses first-match-wins).
  return {
    ...getClassReducers(),
    ...getStepFunctionReducer(),
    ...getCommonReducers(global),
    // Request and Response reducers are mode-specific and added by
    // getExternalReducers / getWorkflowReducers / getStepReducers below.
    Request: (value) => {
      // Chain walk rather than `instanceof global.Request`: see the
      // ReadableStream reducer in getWorkflowReducers for why. Reads go
      // through descriptors so a getter cannot run unreported.
      if (!isInstanceOfPrototype(value, requestPrototype.value)) return false;
      const data: SerializableSpecial['Request'] = {
        method: readProperty(value, 'method') as string,
        url: readProperty(value, 'url') as string,
        headers: readProperty(value, 'headers') as Headers,
        body: readProperty(value, 'body') as ReadableStream | null,
        duplex: readProperty(value, 'duplex') as 'half',
      };
      const responseWritable = readProperty(value, WEBHOOK_RESPONSE_WRITABLE) as
        | WritableStream<Response>
        | undefined;
      if (responseWritable) {
        data.responseWritable = responseWritable;
      }
      // Forward the signal in two cases:
      //   1. Already aborted: preserve aborted=true/reason so the hydrated
      //      step sees the cancellation that happened before serialize.
      //   2. Already tagged with workflow infrastructure, i.e. a signal
      //      from a workflow-managed AbortController, which has stream/hook
      //      backing for cross-boundary propagation.
      // Plain non-aborted native signals are intentionally dropped (would
      // mint stream infra for every Request, including the auto-generated
      // signal on `new Request(url)`).
      const signal = readProperty(value, 'signal');
      if (
        signal &&
        (readProperty(signal, 'aborted') ||
          readProperty(signal, ABORT_STREAM_NAME))
      ) {
        data.signal = signal as AbortSignal;
      }
      return data;
    },
    Response: (value) => {
      // See the Request reducer above.
      if (!isInstanceOfPrototype(value, responsePrototype.value)) return false;
      return {
        type: readProperty(value, 'type') as Response['type'],
        url: readProperty(value, 'url') as string,
        status: readProperty(value, 'status') as number,
        statusText: readProperty(value, 'statusText') as string,
        headers: readProperty(value, 'headers') as Headers,
        body: readProperty(value, 'body') as ReadableStream | null,
        redirected: readProperty(value, 'redirected') as boolean,
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
 * instances (and `holder`s in reducer helpers). All optional: a plain
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

  // Deduped via ABORT_LISTENER_ATTACHED marker: see attachAbortListenerOnce.
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
 * to N steps would otherwise accumulate N listeners, each writing the same
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
            const key = await resolveEncryptionKey(cryptoKey);
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
 * @param runId
 * @param cryptoKey
 * @param framedByteStreams - When `true`, byte streams (`type: 'bytes'`)
 *   are wrapped in length-prefixed frames on the wire so the consumer
 *   can reconnect on transient errors. Should match the target run's
 *   capability: see `getRunCapabilities` in `capabilities.ts`. Defaults
 *   to `false` for backwards compatibility with older runs.
 * @returns
 */
export function getExternalReducers(
  global: Record<string, any> = globalThis,
  ops: Promise<void>[],
  runId: string,
  cryptoKey: EncryptionKeyParam,
  framedByteStreams = false,
  // Turbo optimistic start: a nested `ReadableStream` found while serializing
  // is piped to its own server stream independently of the outer sink, so its
  // first chunk can race `run_started`. Thread the run-ready barrier into that
  // sink so the write orders after the run exists. Undefined outside turbo /
  // on the await path.
  runReadyBarrier?: Promise<unknown>
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

      const writable = new WorkflowServerWritableStream(
        runId,
        name,
        runReadyBarrier
      );
      if (type === 'bytes') {
        if (framedByteStreams) {
          ops.push(value.pipeThrough(getByteFramingStream()).pipeTo(writable));
        } else {
          ops.push(value.pipeTo(writable));
        }
      } else {
        ops.push(
          value
            .pipeThrough(
              getSerializeStream(
                getExternalReducers(
                  global,
                  ops,
                  runId,
                  cryptoKey,
                  framedByteStreams,
                  runReadyBarrier
                ),
                cryptoKey
              )
            )
            .pipeTo(writable)
        );
      }

      const s: SerializableSpecial['ReadableStream'] = { name };
      if (type) s.type = type;
      if (type === 'bytes' && framedByteStreams) s.framing = 'framed-v1';
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
      // for the full lifetime of the receiving run, with no in-process
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
        const existingPublicKey = (value as any)[
          STREAM_SERVER_PUBLIC_KEY_SYMBOL
        ];
        if (typeof existingPublicKey === 'string') {
          descriptor.encryptionPublicKey = existingPublicKey;
        }
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
/**
 * Prototypes used for brand-style identification in the reducers below.
 *
 * The stream and abort classes are host classes injected into the sandbox, so
 * instances carry the host prototype in their chain and a chain walk
 * identifies them without consulting `Symbol.hasInstance` on the sandbox
 * class. `undefined` when the runtime lacks the class, in which case
 * identification falls back to the infrastructure symbols alone.
 */
/**
 * The prototype of a host class that may also be injected into the sandbox.
 * Prefers the sandbox binding (the same host class object in practice) and
 * falls back to the host's own, so a chain walk identifies instances from
 * either realm without consulting `Symbol.hasInstance`.
 */
function getHostClassPrototype(
  global: Record<string, any>,
  name: string
): object | undefined {
  // Descriptor reads (`readProperty`), not bare gets: an accessor or Proxy
  // planted on the sandbox global (or the constructor) must be recorded in
  // the guest-code sink (it gates VM retention), not silently executed.
  // Callers wrap this in `once(...)` per reducer set, so the read happens
  // exactly once per serialize pass, on the first guard invocation, inside
  // the pass's sink scope, never per value.
  const ctor = readProperty(global, name) ?? readProperty(globalThis, name);
  if (typeof ctor !== 'function') return undefined;
  return readProperty(ctor, 'prototype') as object | undefined;
}

export function getWorkflowReducers(
  global: Record<string, any> = globalThis
): Partial<Reducers> {
  const readableStreamPrototype = once(() =>
    getHostClassPrototype(global, 'ReadableStream')
  );
  const writableStreamPrototype = once(() =>
    getHostClassPrototype(global, 'WritableStream')
  );
  const abortControllerPrototype = once(() =>
    getHostClassPrototype(global, 'AbortController')
  );
  const abortSignalPrototype = once(() =>
    getHostClassPrototype(global, 'AbortSignal')
  );
  return {
    ...getAllBaseReducers(global),

    // Readable/Writable streams from within the workflow execution environment
    // are "handles" that can be passed around to other steps.
    ReadableStream: (value) => {
      // Walk the prototype chain instead of `instanceof global.ReadableStream`:
      // the class is host-provided (injected into the sandbox), so its
      // prototype is in the chain of both real streams and the
      // `Object.create(ReadableStream.prototype)` handles used for request
      // bodies, but a chain walk never consults `Symbol.hasInstance`, which
      // the sandbox can define and which ran for every value the earlier
      // reducers did not claim. Reads below go through descriptors so a
      // getter on a step argument cannot run unreported.
      if (!isInstanceOfPrototype(value, readableStreamPrototype.value))
        return false;

      // Check if this is a fake stream storing BodyInit from Request/Response constructor
      const bodyInit = readProperty(value, BODY_INIT_SYMBOL);
      if (bodyInit !== undefined) {
        // This is a fake stream - serialize the BodyInit directly
        // devalue will handle serializing strings, Uint8Array, etc.
        return { bodyInit };
      }

      const name = readProperty(value, STREAM_NAME_SYMBOL) as string;
      if (!name) {
        throw new WorkflowRuntimeError('ReadableStream `name` is not set');
      }
      const s: Extract<
        SerializableSpecial['ReadableStream'],
        { name: string }
      > = { name };
      const type = readProperty(value, STREAM_TYPE_SYMBOL) as
        | 'bytes'
        | undefined;
      if (type) s.type = type;
      const framing = readProperty(value, STREAM_FRAMING_SYMBOL) as
        | ByteStreamFraming
        | undefined;
      if (framing) s.framing = framing;
      return s;
    },
    WritableStream: (value) => {
      // See the ReadableStream reducer above for why this walks the chain.
      if (!isInstanceOfPrototype(value, writableStreamPrototype.value))
        return false;
      const name = readProperty(value, STREAM_NAME_SYMBOL) as string;
      if (!name) {
        throw new WorkflowRuntimeError('WritableStream `name` is not set');
      }
      const s: SerializableSpecial['WritableStream'] = { name };
      // When the handle was forwarded from another run (parent → child
      // via `start()`), preserve the foreign runId so the step-side
      // reviver opens the writable against the original stream.
      const foreignRunId = readProperty(value, STREAM_SERVER_RUN_ID_SYMBOL);
      if (typeof foreignRunId === 'string') s.runId = foreignRunId;
      const foreignDeploymentId = readProperty(
        value,
        STREAM_SERVER_DEPLOYMENT_ID_SYMBOL
      );
      if (typeof foreignDeploymentId === 'string') {
        s.deploymentId = foreignDeploymentId;
      }
      const foreignPublicKey = readProperty(
        value,
        STREAM_SERVER_PUBLIC_KEY_SYMBOL
      );
      if (typeof foreignPublicKey === 'string') {
        s.encryptionPublicKey = foreignPublicKey;
      }
      return s;
    },

    // AbortController/AbortSignal in workflow context: read only symbols (handles).
    // In the workflow VM, global.AbortController is a class but global.AbortSignal
    // is a plain object (not a class), so instanceof checks won't work for signals.
    // Detect instances by the presence of the ABORT_STREAM_NAME symbol instead.
    AbortController: (value) => {
      // `value.signal` was a bare read, so a `signal` getter on any object
      // reaching this reducer executed unreported. Read through descriptors
      // and gate on the infrastructure symbol / prototype first.
      if (value === null || typeof value !== 'object') return false;
      const holder = value as AbortController & AbortHolder;
      const ownSymbol = readProperty(value, ABORT_STREAM_NAME);
      const isNativeAbortController = isInstanceOfPrototype(
        value,
        abortControllerPrototype.value
      );
      if (ownSymbol === undefined && !isNativeAbortController) {
        // Not ours and not a native controller, but a foreign controller
        // may still carry the symbol on its signal.
        const maybeSignal = readProperty(value, 'signal');
        if (
          maybeSignal === null ||
          typeof maybeSignal !== 'object' ||
          readProperty(maybeSignal, ABORT_STREAM_NAME) === undefined
        ) {
          return false;
        }
      }
      const signal = readProperty(value, 'signal');
      if (!signal) return false;
      return reduceAbortBySymbol(signal as AbortSignal, holder);
    },
    AbortSignal: (value) => {
      if (value === null || typeof value !== 'object') return false;
      const hasAbortSymbol =
        readProperty(value, ABORT_STREAM_NAME) !== undefined;
      const isNativeAbortSignal = isInstanceOfPrototype(
        value,
        abortSignalPrototype.value
      );
      if (!hasAbortSymbol && !isNativeAbortSignal) return false;
      return reduceAbortBySymbol(value as AbortSignal, value as AbortHolder);
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
  cryptoKey: EncryptionKeyParam,
  framedByteStreams = false,
  // Turbo optimistic start: a returned `ReadableStream` is piped to the server
  // after the body but within the same op flush, so its first chunk can race
  // `run_started`. Thread the run-ready barrier into the sink so that write
  // orders after the run exists. Undefined outside turbo / on the await path.
  runReadyBarrier?: Promise<unknown>
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
      // it's already being sunk to the server and we can return the
      // name and type.
      let name = value[STREAM_NAME_SYMBOL];
      let type = value[STREAM_TYPE_SYMBOL];
      // The framing symbol is set when a workflow VM revives a stream
      // handle from a previous step (see `getWorkflowRevivers`). When
      // present we must propagate the same framing choice on the way
      // back out, since the bytes already on the server's stream are in
      // that format; switching format mid-stream would corrupt them.
      let framing: ByteStreamFraming | undefined = value[STREAM_FRAMING_SYMBOL];

      if (!name) {
        const streamId = ((global as any)[STABLE_ULID] || defaultUlid)();
        name = `strm_${streamId}`;
        type = getStreamType(value);
        framing = type === 'bytes' && framedByteStreams ? 'framed-v1' : framing;

        const writable = new WorkflowServerWritableStream(
          runId,
          name,
          runReadyBarrier
        );
        if (type === 'bytes') {
          if (framing === 'framed-v1') {
            ops.push(
              value.pipeThrough(getByteFramingStream()).pipeTo(writable)
            );
          } else {
            ops.push(value.pipeTo(writable));
          }
        } else {
          ops.push(
            value
              .pipeThrough(
                getSerializeStream(
                  getStepReducers(
                    global,
                    ops,
                    runId,
                    cryptoKey,
                    framedByteStreams,
                    runReadyBarrier
                  ),
                  cryptoKey
                )
              )
              .pipeTo(writable)
          );
        }
      }

      const s: SerializableSpecial['ReadableStream'] = { name };
      if (type) s.type = type;
      if (framing) s.framing = framing;
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
      const foreignPublicKey = (value as any)[STREAM_SERVER_PUBLIC_KEY_SYMBOL];
      if (typeof foreignPublicKey === 'string') {
        s.encryptionPublicKey = foreignPublicKey;
      }
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
        if (result.value && !result.done) {
          // An abort packet arrived: propagate it as fast as possible. Release
          // the lock (synchronous) rather than cancelling here: on a
          // service-backed World `reader.cancel()` can do a network round-trip,
          // and awaiting it before `controller.abort()` would delay (or, if it
          // hangs, drop) real-time abort delivery to the in-flight step.
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released; ignore.
          }
          try {
            // Hydrate via the same machinery the writer used so the reason
            // round-trips with full type fidelity. Encryption key (if any)
            // comes from the step context, set up by the step executor before
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
        } else {
          // The step finished (or the reader was cancelled) without an abort.
          // Cancel (not just release) so the underlying World stream is torn
          // down: a polling World (e.g. world-local) otherwise leaks a tail
          // reader (a 100ms filesystem poll plus emitter listeners) per step
          // invocation for the life of the process, since a signal-bearing step
          // opens one of these on every revival and usually never aborts. Fire
          // and forget: a service-backed World's cancel may hit the network,
          // and this path must not block the step's ops-settle window.
          void reader.cancel().catch(() => {});
        }
      } catch {
        // Stream read failed: signal won't propagate in real-time,
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
 * internally: the constructed `request.signal` is a fresh AbortSignal that
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
            // encryption key, symmetric with what the suspension handler
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
        // The durable hook resume (which writes the `hook_received` event that
        // records this abort in the workflow's event log) must be committed
        // before the step completes. Otherwise the workflow continuation
        // enqueued by `step_completed` can advance past the abort (dispatching
        // a later step with a stale, non-aborted `signal`) before the event
        // exists. Route it to `preCompletionOps` (awaited inline before
        // completion) rather than `ops` (best-effort, background). The stream
        // write above stays in `ops`: it must fire ASAP to reach an in-flight
        // sibling step and is not the durable record.
        // Swallow errors here so the promise can only ever enforce ordering
        // when awaited (see the no-reject contract on
        // StepContext.preCompletionOps); a failed resume retries on next replay.
        const hookResume = (async () => {
          try {
            const { resumeHook: resumeHookFn } = await import(
              './runtime/resume-hook.js'
            );
            await resumeHookFn(value.hookToken, {
              aborted: true,
              reason,
            });
          } catch {
            // Best-effort hook resume: retry on next replay
          }
        })();
        ctx.preCompletionOps.push(hookResume);
      }
    }
  };

  return controller;
}

/**
 * Revives only an AbortSignal without the patched abort() overhead.
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
 * Resolve the write-only key a run needs when writing into another run's
 * forwarded stream.
 *
 * Three tiers, cheapest first:
 *
 * 1. The descriptor carries the owner's X25519 public key: seal to it with
 *    no I/O whatsoever. The owner published the key when it created the
 *    stream, so this is the zero-round-trip path.
 * 2. The descriptor carries the owner's deployment ID: resolve the owner's
 *    symmetric key, which cross-deployment means a key-API round trip.
 * 3. Neither (descriptors written by older SDKs): load the owning run first,
 *    then resolve its symmetric key.
 *
 * Tiers 2 and 3 import the key encrypt-only, which is an honor-system
 * restriction: the same bytes could decrypt. Tier 1 makes it a cryptographic
 * guarantee: a public key cannot read anything.
 */
async function getForwardedWritableEncryptionKey(
  runId: string,
  deploymentId: string | undefined,
  encryptionPublicKey: string | undefined
): Promise<PayloadKey | undefined> {
  const ownerPublicKey = decodeRunPublicKey(encryptionPublicKey);
  if (ownerPublicKey) return sealTo(ownerPublicKey);

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

      if (value.type === 'bytes') {
        // For byte streams, use flushable pipe with lock polling.
        // If the producer wrote framed bytes (framing === 'framed-v1'),
        // unwrap the length-prefix envelope before handing chunks to
        // the user. Absent / 'raw' framing means legacy raw bytes:
        // pipe through unchanged for backwards compatibility.
        //
        // No auto-reconnect here yet: raw byte streams have no wire
        // framing to count consumed chunks with. Framed-v1 byte streams
        // make frame counting possible, so extending the reconnecting
        // reader to them is a separate follow-up.
        const readable = new WorkflowServerReadableStream(
          runId,
          value.name,
          value.startIndex
        );
        const state = createFlushableState();
        ops.push(state.promise);

        // Create an identity (or unframing) transform to give the user a readable
        const { readable: userReadable, writable } =
          value.framing === 'framed-v1'
            ? getByteUnframingStream()
            : new global.TransformStream();

        // Start the flushable pipe in the background
        flushablePipe(readable, writable, state).catch(() => {
          // Errors are handled via state.reject
        });

        // Start polling to detect when user releases lock
        pollReadableLock(userReadable, state);

        return userReadable;
      } else {
        // Non-byte streams carry length-prefixed frames, so we can count
        // completed frames and transparently reconnect when the server
        // stream connection times out mid-run.
        const readable = createReconnectingFramedStream(
          runId,
          value.name,
          value.startIndex
        );
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
      // Same handling as `getStepRevivers.WritableStream`: see comments
      // there for the cross-run case (writable carries `runId` from
      // parent → child forwarding via `start()`).
      const targetRunId = typeof value.runId === 'string' ? value.runId : runId;
      const targetKey: EncryptionKeyParam =
        targetRunId === runId
          ? cryptoKey
          : getForwardedWritableEncryptionKey(
              targetRunId,
              value.deploymentId,
              value.encryptionPublicKey
            );

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
      // Keep the owner's public key on the handle so a further forward stays on
      // the zero-lookup sealed path.
      if (typeof value.encryptionPublicKey === 'string') {
        Object.defineProperty(
          serialize.writable,
          STREAM_SERVER_PUBLIC_KEY_SYMBOL,
          {
            value: value.encryptionPublicKey,
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
    // Workflow function reviver for workflow context: returns a function-like
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
        // Carry the wire-framing decision through the workflow VM so
        // that when the handle is later passed to a step (which reads
        // the actual bytes from the server) we know whether to unframe.
        // Defaults to undefined for streams whose serialized ref didn't
        // carry the field; those are treated as legacy raw bytes.
        [STREAM_FRAMING_SYMBOL]: {
          value: value.framing,
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
      // Preserve the owner's public key for the same reason as the runId
      // above. Without it, forwarding a writable through a workflow to a step
      // silently drops the key, and the step falls back to fetching the
      // owner's symmetric key, the round trip sealing exists to remove.
      if (typeof value.encryptionPublicKey === 'string') {
        descriptor[STREAM_SERVER_PUBLIC_KEY_SYMBOL] = {
          value: value.encryptionPublicKey,
          writable: false,
        };
      }
      return Object.create(global.WritableStream.prototype, descriptor);
    },

    // AbortController/AbortSignal revived inside the workflow VM. Use the
    // real WorkflowAbortSignal class so addEventListener('abort', fn) actually
    // fires when the signal aborts (the previous no-op stub silently dropped
    // listener registrations, a silent correctness bug for natural patterns
    // like `signal.addEventListener('abort', fn)` after receiving a deserialized
    // signal). The signal does not own a hook subscription here; abort state
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
    //     presence, not truthiness, is significant because
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
        // For byte streams, use flushable pipe with lock polling.
        // If the producer wrote framed bytes (framing === 'framed-v1'),
        // unwrap the length-prefix envelope before handing chunks to
        // the user step. Absent / 'raw' framing means legacy raw bytes:
        // pipe through unchanged for backwards compatibility.
        const state = createFlushableState();
        ops.push(state.promise);

        // Create an identity (or unframing) transform to give the user a readable
        const { readable: userReadable, writable } =
          value.framing === 'framed-v1'
            ? getByteUnframingStream()
            : new global.TransformStream();

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
      // block reviver return: `getSerializeStream` accepts the
      // `Promise<CryptoKey | undefined>` directly and awaits it lazily
      // on the first chunk written. The key is imported encrypt-only
      // so the receiving run can never decrypt anything else on the
      // owning run's stream; it can only contribute new writes.
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
          : getForwardedWritableEncryptionKey(
              targetRunId,
              targetDeploymentId,
              value.encryptionPublicKey
            );

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
      // server stream. When forwarded across `start()` again (e.g.
      // the child passes this writable on to a grandchild), the
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
      // Keep the owner's public key on the handle so a further forward stays on
      // the zero-lookup sealed path.
      //
      // When the descriptor carries no key and the stream belongs to THIS run,
      // derive it. A writable taken with `getWritable()` in a workflow body has
      // only a name on it (the workflow VM holds no key material by design),
      // so nothing could publish the key when the handle was created. Reviving
      // happens in a step, which does hold this run's key, and any later
      // forward then copies the symbol.
      //
      // It has to happen here rather than at serialization time: `start()`
      // dehydrates its arguments with the CHILD's runId and the CHILD's key, so
      // the owning run's key is no longer in scope by then.
      //
      // `targetRunId === runId` is the guard that matters. For a stream another
      // run owns we must not advertise our key: the receiver would seal to us
      // and the real owner could never open what it wrote.
      if (
        typeof value.encryptionPublicKey !== 'string' &&
        targetRunId === runId &&
        isRunPayloadKeys(cryptoKey)
      ) {
        Object.defineProperty(
          serialize.writable,
          STREAM_SERVER_PUBLIC_KEY_SYMBOL,
          {
            value: bytesToBase64(cryptoKey.keyPair.publicKey),
            writable: false,
          }
        );
      }
      if (typeof value.encryptionPublicKey === 'string') {
        Object.defineProperty(
          serialize.writable,
          STREAM_SERVER_PUBLIC_KEY_SYMBOL,
          {
            value: value.encryptionPublicKey,
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
  key: PayloadKey | undefined
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
  key: PayloadKey | undefined
): Promise<Uint8Array | unknown> {
  return decrypt(data, key);
}

/**
 * Replay hydration has two stages:
 *
 * 1. Host-side preparation decrypts and decompresses persisted data. That work
 *    is independent of a workflow VM and can be cached across replay VMs.
 * 2. Deserialization revives the prepared representation against the current
 *    VM's globals. It must run again for every VM to produce fresh object graphs
 *    and correctly scoped Workflow objects.
 *
 * `data` is the boundary between those stages. For current-format payloads it
 * is still format-prefixed serialized bytes, not a live JavaScript value.
 */
export interface PreparedReplayPayload {
  readonly data: unknown;
}

/**
 * Swappable implementation of the host-side preparation stage. Supporting
 * both direct and promised results lets a future synchronous Node decryptor use
 * the same cache contract as today's asynchronous Web Crypto implementation.
 */
export type ReplayPayloadPreparer = (
  value: unknown,
  key: PayloadKey | undefined
) => PreparedReplayPayload | Promise<PreparedReplayPayload>;

/**
 * Decrypt and decompress persisted data without parsing it into JavaScript.
 * Legacy non-binary values pass through unchanged for their consumer to revive.
 */
export const prepareReplayPayload: ReplayPayloadPreparer = async (
  value,
  key
) => {
  const compressionStats: CompressionStats = {};
  const prepared = await decompress(
    await decrypt(value, key),
    compressionStats
  );
  await recordCompression(compressionStats, 'deserialize');
  return { data: prepared };
};

/**
 * Parse a prepared workflow argument or successful step/hook payload using the
 * current workflow VM's globals and revivers. Each call intentionally creates
 * a fresh object graph so mutations cannot leak across replay iterations.
 */
export function deserializePreparedReplayPayload(
  prepared: PreparedReplayPayload,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): any {
  return workflowModule.deserialize(prepared.data, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(getWorkflowRevivers(global)),
      ...extraRevivers,
    },
  });
}

/**
 * Parse a prepared step error using the current workflow VM's class revivers.
 * This preserves thrown-value identity without sharing objects between VMs.
 */
export function deserializePreparedStepError(
  prepared: PreparedReplayPayload,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): unknown {
  const { data } = prepared;
  if (!(data instanceof Uint8Array)) {
    return unflatten(data as any[], {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  const { format, payload } = decodeFormatPrefix(data);
  if (format === SerializationFormat.DEVALUE_V1) {
    const str = new TextDecoder().decode(payload);
    return parse(str, {
      ...getWorkflowRevivers(global),
      ...extraRevivers,
    });
  }

  throw new Error(`Unsupported serialization format: ${format}`);
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
 *
 * @param value - The value to serialize
 * @param runId - The workflow run ID (required for encryption context)
 * @param key - Encryption key (undefined to skip encryption)
 * @param ops - Promise array for stream operations
 * @param global - Global object for serialization context
 * @param v1Compat - Enable legacy v1 compatibility mode
 * @param framedByteStreams - Whether the target run can decode wire-framed
 *   byte streams. Should match the target deployment's capability: see
 *   `getRunCapabilities` in `capabilities.ts`. Defaults to `false` for
 *   backwards compatibility with older runs.
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateWorkflowArguments(
  value: unknown,
  runId: string,
  key: PayloadKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false,
  framedByteStreams = false,
  compression = false
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(
      value,
      getExternalReducers(global, ops, runId, key, framedByteStreams)
    );
    return revive(str);
  }
  try {
    const compressionStats: CompressionStats = {};
    const result = await clientModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(
        getExternalReducers(global, ops, runId, key, framedByteStreams)
      ),
      compression,
      compressionStats,
    });
    await recordCompression(compressionStats, 'serialize');
    return result;
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
 * arguments from the database at the start of workflow execution. A prepared
 * payload skips host-side decrypt/decompress but always performs VM revival.
 */
export async function hydrateWorkflowArguments(
  value: Uint8Array | unknown,
  _runId: string,
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {},
  prepared?: PreparedReplayPayload
): Promise<any> {
  return deserializePreparedReplayPayload(
    prepared ?? (await prepareReplayPayload(value, key)),
    global,
    extraRevivers
  );
}

/**
 * Dehydrate workflow return value for storage.
 */
export async function dehydrateWorkflowReturnValue(
  value: unknown,
  _runId: string,
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false,
  compression = false,
  /**
   * Optional sink receiving every workflow-code execution serialization could
   * not avoid, for callers that need them programmatically (e.g. a
   * retained-VM gate deciding whether the VM is still reusable). The
   * executions are emitted as span attributes either way, so omitting this
   * loses nothing observability-wise. The retained-VM gate in
   * runtime/suspension-handler.ts passes one for step-input dehydration.
   */
  guestCodeStatsOut?: GuestCodeStats
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getWorkflowReducers(global));
    return revive(str);
  }
  try {
    const compressionStats: CompressionStats = {};
    const guestCodeStats: GuestCodeStats = guestCodeStatsOut ?? {
      executions: [],
    };
    const result = await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(getWorkflowReducers(global)),
      compression,
      compressionStats,
      guestCodeStats,
    });
    await recordCompression(compressionStats, 'serialize');
    await recordGuestCodeExecutions(guestCodeStats);
    return result;
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
  key: PayloadKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<any> {
  const compressionStats: CompressionStats = {};
  const result = await clientModule.deserialize(value, key, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(
        getExternalRevivers(global, ops, runId, key)
      ),
      ...extraRevivers,
    },
    compressionStats,
  });
  await recordCompression(compressionStats, 'deserialize');
  return result;
}

/**
 * Called from the workflow handler when a step is being created.
 * Dehydrates values from within the workflow execution environment.
 */
export async function dehydrateStepArguments(
  value: unknown,
  _runId: string,
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  v1Compat = false,
  compression = false,
  /** See `dehydrateWorkflowReturnValue`. */
  guestCodeStatsOut?: GuestCodeStats
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(value, getWorkflowReducers(global));
    return revive(str);
  }
  try {
    const compressionStats: CompressionStats = {};
    const guestCodeStats: GuestCodeStats = guestCodeStatsOut ?? {
      executions: [],
    };
    const result = await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(getWorkflowReducers(global)),
      compression,
      compressionStats,
      guestCodeStats,
    });
    await recordCompression(compressionStats, 'serialize');
    await recordGuestCodeExecutions(guestCodeStats);
    return result;
  } catch (error) {
    const cause = unwrapSerializationCause(error);
    const { message, hint } = formatSerializationError('step arguments', cause);
    throw new SerializationError(message, { hint, cause });
  }
}

/**
 * Called from the step executor to hydrate the arguments of a step
 * from the database at the start of the step execution.
 */
export async function hydrateStepArguments(
  value: Uint8Array | unknown,
  runId: string,
  key: PayloadKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {},
  deploymentId?: string
): Promise<any> {
  const compressionStats: CompressionStats = {};
  const result = await stepModule.deserialize(value, key, {
    global,
    extraRevivers: {
      ...getStreamAndRequestRevivers(
        getStepRevivers(global, ops, runId, key, deploymentId)
      ),
      ...extraRevivers,
    },
    compressionStats,
  });
  await recordCompression(compressionStats, 'deserialize');
  return result;
}

/**
 * Called from the step executor when a step has completed.
 * Dehydrates values from within the step execution environment
 * into a format that can be saved to the database.
 *
 * @param value - The value to serialize
 * @param runId - Run ID for encryption context
 * @param key - Encryption key (undefined to skip encryption)
 * @param ops - Promise array for stream operations
 * @param global - Global object for serialization context
 * @param v1Compat - Enable legacy v1 compatibility mode
 * @param framedByteStreams - Whether the target run can decode wire-framed
 *   byte streams. Should match the target deployment's capability: see
 *   `getRunCapabilities` in `capabilities.ts`. Defaults to `false` for
 *   backwards compatibility with older runs.
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
export async function dehydrateStepReturnValue(
  value: unknown,
  runId: string,
  key: PayloadKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  v1Compat = false,
  framedByteStreams = false,
  compression = false,
  // Turbo optimistic start: order the first chunk of a returned stream after
  // the backgrounded `run_started`. Threaded into the step reducers' stream
  // sink. Undefined outside turbo / on the await path.
  runReadyBarrier?: Promise<unknown>
): Promise<Uint8Array | unknown> {
  if (v1Compat) {
    const str = stringify(
      value,
      getStepReducers(
        global,
        ops,
        runId,
        key,
        framedByteStreams,
        runReadyBarrier
      )
    );
    return revive(str);
  }
  try {
    const compressionStats: CompressionStats = {};
    const result = await stepModule.serialize(value, key, {
      global,
      extraReducers: getStreamAndRequestReducers(
        getStepReducers(
          global,
          ops,
          runId,
          key,
          framedByteStreams,
          runReadyBarrier
        )
      ),
      compression,
      compressionStats,
    });
    await recordCompression(compressionStats, 'serialize');
    return result;
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
 * Called from the step executor when a step throws. Dehydrates the thrown
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
  key: PayloadKey | undefined,
  ops: Promise<any>[] = [],
  global: Record<string, any> = globalThis,
  compression = false
): Promise<Uint8Array> {
  try {
    const str = stringify(value, getStepReducers(global, ops, runId, key));
    const payload = new TextEncoder().encode(str);
    const serialized = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    // Compress before encrypting: encrypted bytes don't compress.
    const compressionStats: CompressionStats = {};
    const compressed = await compress(
      serialized,
      compression,
      compressionStats
    );
    const encrypted = (await maybeEncrypt(
      compressed as Uint8Array,
      key
    )) as Uint8Array;
    await recordCompression(compressionStats, 'serialize');
    return encrypted;
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
 * @param prepared - Optional cached decrypt/decompress result
 * @returns The hydrated thrown value, ready to reject the step promise
 */
export async function hydrateStepError(
  value: Uint8Array | unknown,
  _runId: string,
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {},
  prepared?: PreparedReplayPayload
): Promise<unknown> {
  return deserializePreparedStepError(
    prepared ?? (await prepareReplayPayload(value, key)),
    global,
    extraRevivers
  );
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
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  compression = false
): Promise<Uint8Array> {
  try {
    const str = stringify(value, getWorkflowReducers(global));
    const payload = new TextEncoder().encode(str);
    const serialized = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      payload
    ) as Uint8Array;
    // Compress before encrypting: encrypted bytes don't compress.
    const compressionStats: CompressionStats = {};
    const compressed = await compress(
      serialized,
      compression,
      compressionStats
    );
    const encrypted = (await maybeEncrypt(
      compressed as Uint8Array,
      key
    )) as Uint8Array;
    await recordCompression(compressionStats, 'serialize');
    return encrypted;
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
  key: PayloadKey | undefined,
  ops: Promise<void>[] = [],
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {}
): Promise<unknown> {
  const compressionStats: CompressionStats = {};
  const decrypted = await decompress(
    await decrypt(value, key),
    compressionStats
  );
  await recordCompression(compressionStats, 'deserialize');

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
 * @param prepared - Optional cached decrypt/decompress result
 * Called from the workflow handler when replaying the event log
 * of a `step_completed` event.
 */
export async function hydrateStepReturnValue(
  value: Uint8Array | unknown,
  _runId: string,
  key: PayloadKey | undefined,
  global: Record<string, any> = globalThis,
  extraRevivers: Record<string, (value: any) => any> = {},
  prepared?: PreparedReplayPayload
): Promise<any> {
  return deserializePreparedReplayPayload(
    prepared ?? (await prepareReplayPayload(value, key)),
    global,
    extraRevivers
  );
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
