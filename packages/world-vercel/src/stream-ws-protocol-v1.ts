import { z } from 'zod';
import { encodeFrame } from './frames.js';
import { encodeMultiChunks } from './stream-chunks.js';

/**
 * The independently versioned WebSocket protocol for stream writes.
 *
 * This is not a REST API or persisted workflow-spec version. A breaking change
 * to framing, ordering, acknowledgements, retries, or mandatory control frames
 * needs a new `/websockets/vN` endpoint rather than a spec-version bump.
 */
export const STREAM_WS_PROTOCOL_V1 = 'workflow-stream-ws/v1';

/** Shared v1 request-work bound; this is not a per-second rate limit. */
export const STREAM_WS_V1_MAX_CHUNKS_PER_WRITE = 1000;
/** Shared v1 size bound for each decoded chunk. */
export const STREAM_WS_V1_MAX_CHUNK_BYTES = 10 * 1024 * 1024;

const NonnegativeIntegerSchema = z.number().int().nonnegative();
const RequestIdSchema = NonnegativeIntegerSchema;

/**
 * One in-memory WritableStream lifetime, including HTTP/WS transitions.
 *
 * This id is observational, not a fence: the same writer id can appear on
 * multiple connections, and v1 does not use it to reject either connection.
 */
export const StreamWriterIdSchema = z
  .string()
  .regex(/^wrtr_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);

/**
 * v1 write metadata. `chunkSeq` is the first writer-local sequence in this
 * body, not a persisted stream-global index. It advances by `numChunks` across
 * HTTP/WS transitions. v1 observes but does not enforce continuity or
 * uniqueness: an accepted duplicate/discontinuous sequence appends its chunks
 * again rather than replaying, filling a gap, or fencing another connection.
 */
export const StreamWsWriteRequestMetaSchema = z.object({
  type: z.literal('write'),
  reqId: RequestIdSchema,
  chunkSeq: NonnegativeIntegerSchema,
  numChunks: z.number().int().positive().max(STREAM_WS_V1_MAX_CHUNKS_PER_WRITE),
});

/** v1 close metadata. Its frame body must be empty. */
export const StreamWsCloseRequestMetaSchema = z.object({
  type: z.literal('close'),
  reqId: RequestIdSchema,
});

export const StreamWsRequestMetaSchema = z.discriminatedUnion('type', [
  StreamWsWriteRequestMetaSchema,
  StreamWsCloseRequestMetaSchema,
]);

export const StreamWsWriteAckMetaSchema = z.object({
  type: z.literal('write_ack'),
  reqId: RequestIdSchema,
});

export const StreamWsCloseAckMetaSchema = z.object({
  type: z.literal('close_ack'),
  reqId: RequestIdSchema,
});

/** An absent request id makes the error connection-fatal. */
export const StreamWsErrorMetaSchema = z.object({
  type: z.literal('error'),
  reqId: RequestIdSchema.optional(),
  status: z.number().int(),
  message: z.string().optional(),
});

export const StreamWsReplyMetaSchema = z.discriminatedUnion('type', [
  StreamWsWriteAckMetaSchema,
  StreamWsCloseAckMetaSchema,
  StreamWsErrorMetaSchema,
]);

/*
 * v1 pipelining is ordered and fail-stop. The server executes requests serially
 * in receive order. Its first failed request prevents later queued writes or
 * closes from executing and poisons the writer. An unknown client outcome is
 * likewise never replayed. The whole WebSocket-message ceiling is deliberately
 * implementation- and measurement-defined beyond the per-chunk/count bounds.
 */

export type StreamWriterId = z.infer<typeof StreamWriterIdSchema>;
export type StreamWsWriteRequestMeta = z.infer<
  typeof StreamWsWriteRequestMetaSchema
>;
export type StreamWsCloseRequestMeta = z.infer<
  typeof StreamWsCloseRequestMetaSchema
>;
export type StreamWsRequestMeta = z.infer<typeof StreamWsRequestMetaSchema>;
export type StreamWsWriteAckMeta = z.infer<typeof StreamWsWriteAckMetaSchema>;
export type StreamWsCloseAckMeta = z.infer<typeof StreamWsCloseAckMetaSchema>;
export type StreamWsErrorMeta = z.infer<typeof StreamWsErrorMetaSchema>;
export type StreamWsReplyMeta = z.infer<typeof StreamWsReplyMetaSchema>;

/** Builds the independently versioned, writer-observability-aware v1 URL. */
export function getStreamWsProtocolV1Url(
  baseUrl: string,
  runId: string,
  streamId: string,
  writerId: StreamWriterId
): URL {
  const parsedWriterId = StreamWriterIdSchema.parse(writerId);
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/websockets/v1/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(streamId)}`;
  url.search = new URLSearchParams({ writerId: parsedWriterId }).toString();
  return url;
}

/**
 * Encodes one complete v1 write message. The outer envelope is the shared
 * frame codec; its body is the existing stream multi-chunk representation.
 */
export function encodeStreamWsWriteRequest(
  meta: StreamWsWriteRequestMeta,
  chunks: (string | Uint8Array)[]
): Uint8Array {
  const parsed = StreamWsWriteRequestMetaSchema.parse(meta);
  if (parsed.numChunks !== chunks.length) {
    throw new Error(
      `stream WebSocket write declares ${parsed.numChunks} chunks but received ${chunks.length}`
    );
  }
  const encoder = new TextEncoder();
  for (const chunk of chunks) {
    const byteLength =
      typeof chunk === 'string'
        ? encoder.encode(chunk).byteLength
        : chunk.byteLength;
    if (byteLength > STREAM_WS_V1_MAX_CHUNK_BYTES) {
      throw new Error(
        `stream WebSocket chunk is ${byteLength} bytes; maximum is ${STREAM_WS_V1_MAX_CHUNK_BYTES}`
      );
    }
  }
  return encodeFrame(parsed, encodeMultiChunks(chunks));
}

/** Encodes one complete v1 close message with an empty body. */
export function encodeStreamWsCloseRequest(
  meta: StreamWsCloseRequestMeta
): Uint8Array {
  return encodeFrame(
    StreamWsCloseRequestMetaSchema.parse(meta),
    new Uint8Array()
  );
}

/** Validates a v1 response envelope, whose body is always empty. */
export function parseStreamWsReply(
  meta: Record<string, unknown>,
  body: Uint8Array
): StreamWsReplyMeta {
  if (body.byteLength !== 0) {
    throw new Error('stream WebSocket reply body must be empty');
  }
  return StreamWsReplyMetaSchema.parse(meta);
}
