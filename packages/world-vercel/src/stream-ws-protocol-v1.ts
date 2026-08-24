import { z } from 'zod';
import { encodeFrame } from './frames.js';

/**
 * The independently versioned WebSocket protocol for stream writes.
 *
 * This is not a REST API or persisted workflow-spec version. A breaking change
 * to framing, ordering, acknowledgements, retries, or mandatory control frames
 * needs a new `/websockets/vN` endpoint rather than a spec-version bump.
 */
export const STREAM_WS_PROTOCOL_V1 = 'workflow-stream-ws/v1';

const RequestIdSchema = z.number().int().nonnegative();
const HttpStatusSchema = z.number().int().min(100).max(599);
const SuccessStatusSchema = z.number().int().min(200).max(299);

/** v1 request metadata. The binary frame body is the stream chunk. */
export const StreamWsWriteRequestMetaSchema = z.object({
  type: z.literal('stream_write'),
  reqId: RequestIdSchema,
});

/** Successful v1 reply metadata. `nextIndex` is server-assigned and dense. */
export const StreamWsWriteAckMetaSchema = z.object({
  type: z.literal('stream_write_ack'),
  reqId: RequestIdSchema,
  status: SuccessStatusSchema,
  nextIndex: RequestIdSchema,
});

/** Error v1 reply metadata. Its frame body is deliberately opaque. */
export const StreamWsErrorMetaSchema = z.object({
  type: z.literal('error'),
  reqId: RequestIdSchema,
  status: HttpStatusSchema,
});

export const StreamWsReplyMetaSchema = z.discriminatedUnion('type', [
  StreamWsWriteAckMetaSchema,
  StreamWsErrorMetaSchema,
]);

export type StreamWsWriteRequestMeta = z.infer<
  typeof StreamWsWriteRequestMetaSchema
>;
export type StreamWsWriteAckMeta = z.infer<typeof StreamWsWriteAckMetaSchema>;
export type StreamWsErrorMeta = z.infer<typeof StreamWsErrorMetaSchema>;
export type StreamWsReplyMeta = z.infer<typeof StreamWsReplyMetaSchema>;

/**
 * Encodes one complete v1 WebSocket message using the shared binary envelope:
 * `u32be(cbor-meta length) || cbor-meta || u32be(body length) || body`.
 */
export function encodeStreamWsWriteRequest(
  meta: StreamWsWriteRequestMeta,
  body: Uint8Array
): Uint8Array {
  return encodeFrame(StreamWsWriteRequestMetaSchema.parse(meta), body);
}
