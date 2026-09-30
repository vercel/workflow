/**
 * Large frames on the events WebSocket: a frame whose encoded size is over
 * the message limit is sent as several WebSocket messages ("parts") and
 * rebuilt by the receiver, so the transport works where a single WebSocket
 * message is size-limited. The backend implements the same algorithm; the
 * shared golden fixture in `ws-parts.test.ts` keeps the two in step.
 *
 * - First part: the frame's own meta plus `partIndex: 0` and `partCount`,
 *   with the first piece of the body.
 * - Continuation part: meta `{ type: 'part', reqId, partIndex, partCount }`,
 *   with the next piece of the body.
 *
 * A frame that fits in one message carries neither field and is unchanged.
 */

import { decode } from 'cbor-x';
import { type DecodedFrame, encodeFrame } from './frames.js';

export const WS_PART_TYPE = 'part';

/** Default bound on every WebSocket message sent, header included. Leaves
 *  margin under the 16 MiB (2^24 bytes) WebSocket message limit some
 *  deployments impose. */
export const DEFAULT_WS_MAX_MESSAGE_BYTES = 12 * 1024 * 1024;

/** Largest frame a receiver will rebuild from parts. */
export const WS_MAX_FRAME_BYTES = 256 * 1024 * 1024;

const MIN_WS_MAX_MESSAGE_BYTES = 1024;

/**
 * The configured message limit: `WORKFLOW_WS_MAX_MESSAGE_BYTES` when set to
 * a positive integer, otherwise the default.
 */
export function wsMaxMessageBytes(
  raw: string | undefined = process.env.WORKFLOW_WS_MAX_MESSAGE_BYTES
): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WS_MAX_MESSAGE_BYTES;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_WS_MAX_MESSAGE_BYTES) {
    return DEFAULT_WS_MAX_MESSAGE_BYTES;
  }
  return value;
}

/**
 * Encode one frame as the WebSocket messages to send, in order: a single
 * message when it fits in `maxMessageBytes`, otherwise a first part plus
 * continuation parts, each at most `maxMessageBytes`.
 *
 * Only frames with a client `reqId` can be split, since continuations are
 * matched to their frame by it. Throws for an oversized frame without one.
 */
export function encodeWsFrameMessages(
  meta: Record<string, unknown>,
  body: Uint8Array,
  maxMessageBytes: number
): Uint8Array[] {
  const whole = encodeFrame(meta, body);
  if (whole.byteLength <= maxMessageBytes) return [whole];

  const reqId = meta.reqId;
  if (!isClientReqId(reqId)) {
    throw new Error(
      `ws frame of ${whole.byteLength} bytes exceeds the ${maxMessageBytes}-byte message limit and has no reqId to split it under`
    );
  }

  // Header sizes depend on `partCount`, which depends on the slice sizes.
  // Size both headers with the largest `partIndex`/`partCount` possible
  // (at most one part per body byte, plus the first), which can only
  // overestimate them.
  const bound = body.byteLength + 1;
  const firstHeaderBytes = encodeFrame(
    { ...meta, partIndex: 0, partCount: bound },
    EMPTY
  ).byteLength;
  const continuationHeaderBytes = encodeFrame(
    continuationMeta(reqId, bound, bound),
    EMPTY
  ).byteLength;
  const firstSlice = maxMessageBytes - firstHeaderBytes;
  const continuationSlice = maxMessageBytes - continuationHeaderBytes;
  if (firstSlice <= 0 || continuationSlice <= 0) {
    throw new Error(
      `ws frame meta does not fit in the ${maxMessageBytes}-byte message limit`
    );
  }

  // Positive: the whole frame is over the limit, and the first part's header
  // is at least as large as the frame's own.
  const rest = body.byteLength - firstSlice;
  const partCount = 1 + Math.ceil(rest / continuationSlice);
  const messages: Uint8Array[] = [
    encodeFrame(
      { ...meta, partIndex: 0, partCount },
      body.subarray(0, firstSlice)
    ),
  ];
  for (let index = 1; index < partCount; index++) {
    const start = firstSlice + (index - 1) * continuationSlice;
    messages.push(
      encodeFrame(
        continuationMeta(reqId, index, partCount),
        body.subarray(
          start,
          Math.min(start + continuationSlice, body.byteLength)
        )
      )
    );
  }
  return messages;
}

const EMPTY = new Uint8Array(0);

/**
 * {@link encodeWsFrameMessages} for a frame that is already encoded: returns
 * it untouched when it fits, and otherwise re-reads its meta (the body is not
 * copied) and splits it.
 */
export function splitEncodedFrame(
  frame: Uint8Array,
  maxMessageBytes: number
): Uint8Array[] {
  if (frame.byteLength <= maxMessageBytes) return [frame];
  const { meta, body } = decodeFrame(frame);
  return encodeWsFrameMessages(meta, body, maxMessageBytes);
}

/**
 * Decode exactly one frame from one buffer, synchronously. A WebSocket
 * message is one frame by construction, so trailing bytes are an error.
 * Throws on a truncated or malformed frame.
 */
export function decodeFrame(raw: Uint8Array): DecodedFrame {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.byteLength < 4) {
    throw new Error('ws frame shorter than the meta length prefix');
  }
  const metaEnd = 4 + view.getUint32(0, false);
  if (raw.byteLength < metaEnd + 4) {
    throw new Error('ws frame too short for meta + body length prefix');
  }
  const meta: unknown = decode(raw.subarray(4, metaEnd));
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('ws frame meta must be a CBOR map');
  }
  const bodyStart = metaEnd + 4;
  const bodyEnd = bodyStart + view.getUint32(metaEnd, false);
  if (raw.byteLength !== bodyEnd) {
    throw new Error(
      raw.byteLength < bodyEnd
        ? 'ws frame shorter than its declared body length'
        : `ws frame has ${raw.byteLength - bodyEnd} trailing bytes`
    );
  }
  return {
    meta: meta as Record<string, unknown>,
    body: raw.subarray(bodyStart, bodyEnd),
  };
}

function continuationMeta(
  reqId: number,
  partIndex: number,
  partCount: number
): Record<string, unknown> {
  return { type: WS_PART_TYPE, reqId, partIndex, partCount };
}

/** A part broke the protocol. The connection can't be trusted any more. */
export class WsPartProtocolError extends Error {
  override name = 'WsPartProtocolError';
}

interface OpenFrame {
  meta: Record<string, unknown>;
  partCount: number;
  nextIndex: number;
  chunks: Uint8Array[];
  bytes: number;
}

/**
 * Rebuilds split frames on one connection. Feed it every decoded message in
 * arrival order: it returns the complete frame when one is ready (a whole
 * message, or the last part of a split one), `undefined` while a split frame
 * is still arriving, and throws {@link WsPartProtocolError} on anything the
 * protocol doesn't allow. Open frames are keyed by `reqId`, so parts of
 * different frames may interleave.
 */
export class WsPartAssembler {
  private readonly open = new Map<number, OpenFrame>();

  constructor(private readonly maxFrameBytes: number = WS_MAX_FRAME_BYTES) {}

  accept(frame: DecodedFrame): DecodedFrame | undefined {
    const { meta, body } = frame;

    if (meta.type === WS_PART_TYPE) return this.continue(meta, body);

    if (!('partIndex' in meta) && !('partCount' in meta)) return frame;

    // First part of a split frame.
    const { reqId, partIndex, partCount } = meta;
    if (!isClientReqId(reqId)) {
      throw new WsPartProtocolError('first part has no valid reqId');
    }
    if (partIndex !== 0) {
      throw new WsPartProtocolError(
        `first part for reqId ${reqId} has partIndex ${String(partIndex)}, expected 0`
      );
    }
    if (!isPartCount(partCount)) {
      throw new WsPartProtocolError(
        `first part for reqId ${reqId} has invalid partCount ${String(partCount)}`
      );
    }
    if (this.open.has(reqId)) {
      throw new WsPartProtocolError(
        `second first part for reqId ${reqId} while one is open`
      );
    }
    const { partIndex: _index, partCount: _count, ...frameMeta } = meta;
    const entry: OpenFrame = {
      meta: frameMeta,
      partCount,
      nextIndex: 1,
      chunks: [],
      bytes: 0,
    };
    this.addChunk(reqId, entry, body);
    this.open.set(reqId, entry);
    return undefined;
  }

  /** Number of split frames still arriving. */
  get openFrames(): number {
    return this.open.size;
  }

  private continue(
    meta: Record<string, unknown>,
    body: Uint8Array
  ): DecodedFrame | undefined {
    const keys = Object.keys(meta);
    if (
      keys.length !== 4 ||
      !('reqId' in meta) ||
      !('partIndex' in meta) ||
      !('partCount' in meta)
    ) {
      throw new WsPartProtocolError(
        `continuation part must have exactly type, reqId, partIndex and partCount, got ${keys.join(', ')}`
      );
    }
    const { reqId, partIndex, partCount } = meta;
    if (!isClientReqId(reqId)) {
      throw new WsPartProtocolError('continuation part has no valid reqId');
    }
    const entry = this.open.get(reqId);
    if (!entry) {
      throw new WsPartProtocolError(
        `continuation part for reqId ${reqId} with no open frame`
      );
    }
    if (partCount !== entry.partCount) {
      throw new WsPartProtocolError(
        `continuation part for reqId ${reqId} has partCount ${String(partCount)}, expected ${entry.partCount}`
      );
    }
    if (partIndex !== entry.nextIndex) {
      throw new WsPartProtocolError(
        `continuation part for reqId ${reqId} has partIndex ${String(partIndex)}, expected ${entry.nextIndex}`
      );
    }
    this.addChunk(reqId, entry, body);
    entry.nextIndex++;
    if (entry.nextIndex < entry.partCount) return undefined;

    this.open.delete(reqId);
    const joined = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { meta: entry.meta, body: joined };
  }

  private addChunk(reqId: number, entry: OpenFrame, body: Uint8Array): void {
    entry.bytes += body.byteLength;
    if (entry.bytes > this.maxFrameBytes) {
      this.open.delete(reqId);
      throw new WsPartProtocolError(
        `frame for reqId ${reqId} exceeds ${this.maxFrameBytes} bytes`
      );
    }
    // Copy: the decoded body may be a view over a buffer `ws` reuses.
    entry.chunks.push(body.slice());
  }
}

function isClientReqId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPartCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2;
}
