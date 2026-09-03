import { z } from 'zod';
import { encodeFrame } from './frames.js';

/** Dedicated read protocol; independent of writes, REST, and specVersion. */
export const STREAM_READ_WS_PROTOCOL_V1 = 'workflow-stream-read-ws/v1';

const NonnegativeIntegerSchema = z.number().int().nonnegative();
const RequestIdSchema = NonnegativeIntegerSchema;

/** One logical ReadableStream identity, reused across transport attempts. */
export const StreamReadWsReaderIdSchema = z
  .string()
  .regex(/^read_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
export type StreamReadWsReaderId = z.infer<typeof StreamReadWsReaderIdSchema>;

export const StreamReadWsCreditMetaSchema = z.object({
  type: z.literal('credit'),
  chunks: z.number().int().positive(),
});
export const StreamReadWsCancelMetaSchema = z.object({
  type: z.literal('cancel'),
  reqId: RequestIdSchema,
  reason: z.string().optional(),
});
export const StreamReadWsClientMetaSchema = z.discriminatedUnion('type', [
  StreamReadWsCreditMetaSchema,
  StreamReadWsCancelMetaSchema,
]);

export const StreamReadWsOpenedMetaSchema = z
  .object({
    type: z.literal('opened'),
    requestedStartIndex: z.number().int(),
    resolvedStartIndex: NonnegativeIntegerSchema,
  })
  .superRefine((frame, ctx) => {
    if (
      frame.requestedStartIndex >= 0 &&
      frame.resolvedStartIndex !== frame.requestedStartIndex
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a non-negative requested index resolves to itself',
      });
    }
  });
export const StreamReadWsChunkMetaSchema = z.object({
  type: z.literal('chunk'),
  index: NonnegativeIntegerSchema,
});
export const StreamReadWsEofMetaSchema = z
  .object({
    type: z.literal('eof'),
    finalIndex: z.number().int().min(-1),
    nextIndex: NonnegativeIntegerSchema,
  })
  .superRefine((frame, ctx) => {
    if (frame.nextIndex !== frame.finalIndex + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'eof nextIndex must equal finalIndex + 1',
      });
    }
  });
export const StreamReadWsEndReasonSchema = z.enum([
  'source_interrupted',
  'max_duration',
  'drain',
  'idle',
  'capacity',
]);
export const StreamReadWsEndMetaSchema = z.object({
  type: z.literal('end'),
  reason: StreamReadWsEndReasonSchema,
  retryAfterMs: NonnegativeIntegerSchema.optional(),
});
export const StreamReadWsErrorCodeSchema = z.enum([
  'invalid_start_index',
  'read_failed',
  'protocol_error',
]);
export const StreamReadWsErrorMetaSchema = z.object({
  type: z.literal('error'),
  status: z.number().int(),
  code: StreamReadWsErrorCodeSchema,
  message: z.string().optional(),
});
export const StreamReadWsCancelAckMetaSchema = z.object({
  type: z.literal('cancel_ack'),
  reqId: RequestIdSchema,
});
export const StreamReadWsServerMetaSchema = z.discriminatedUnion('type', [
  StreamReadWsOpenedMetaSchema,
  StreamReadWsChunkMetaSchema,
  StreamReadWsEofMetaSchema,
  StreamReadWsEndMetaSchema,
  StreamReadWsErrorMetaSchema,
  StreamReadWsCancelAckMetaSchema,
]);

export type StreamReadWsClientMeta = z.infer<
  typeof StreamReadWsClientMetaSchema
>;
export type StreamReadWsServerMeta = z.infer<
  typeof StreamReadWsServerMetaSchema
>;

export function getStreamReadWsProtocolV1Url(
  baseUrl: string,
  runId: string,
  streamId: string,
  startIndex: number,
  readerId: StreamReadWsReaderId
): URL {
  if (!Number.isSafeInteger(startIndex)) {
    throw new Error('stream read startIndex must be a safe integer');
  }
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/websockets/v1/runs/${encodeURIComponent(runId)}/stream-reads/${encodeURIComponent(streamId)}`;
  url.search = new URLSearchParams({
    startIndex: String(startIndex),
    readerId: StreamReadWsReaderIdSchema.parse(readerId),
  }).toString();
  return url;
}

/** Client control frames always have an empty body. */
export function encodeStreamReadWsControl(
  meta: StreamReadWsClientMeta
): Uint8Array {
  return encodeFrame(
    StreamReadWsClientMetaSchema.parse(meta),
    new Uint8Array()
  );
}

/** Parse one server envelope, enforcing that only chunk carries a body. */
export function parseStreamReadWsServerFrame(
  meta: Record<string, unknown>,
  body: Uint8Array
): { meta: StreamReadWsServerMeta; body: Uint8Array } {
  const parsed = StreamReadWsServerMetaSchema.parse(meta);
  if (parsed.type !== 'chunk' && body.byteLength !== 0) {
    throw new Error(`stream read ${parsed.type} body must be empty`);
  }
  return { meta: parsed, body };
}
