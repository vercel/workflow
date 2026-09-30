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
 *
 * Direction by direction:
 * - Requests: this client splits any request over the limit. The server
 *   always accepts parts, so this needs a server that supports them.
 * - Replies: the server splits a reply only for a client whose upgrade
 *   request lists `frame-parts` in {@link WS_FLAGS_HEADER}, which this client
 *   always does. Older clients don't, and keep getting whole replies.
 */

import { envNumber } from '@workflow/world';
import { type DecodedFrame, decodeFrame, encodeFrame } from './frames.js';

/**
 * Upgrade request header listing the protocol flags this client supports, as
 * comma-separated tokens. A server only uses a behaviour an older client would
 * misread when the client lists its flag.
 */
export const WS_FLAGS_HEADER = 'x-workflow-ws-flags';

/** Flag: this client rebuilds replies the server sends as parts. */
export const WS_FLAG_FRAME_PARTS = 'frame-parts';

/** The flags this client sends on every upgrade. */
export const WS_CLIENT_FLAGS = [WS_FLAG_FRAME_PARTS] as const;

export const WS_PART_TYPE = 'part';

/** Default bound on every WebSocket message sent, header included. Leaves
 *  margin under the 16 MiB (2^24 bytes) WebSocket message limit some
 *  deployments impose. */
export const DEFAULT_WS_MAX_MESSAGE_BYTES = 12 * 1024 * 1024;

/** Largest configurable message limit: the 16 MiB WebSocket message limit. */
export const MAX_WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Smallest configurable message limit. At this limit
 *  {@link WS_MAX_PART_COUNT} parts still carry a {@link WS_MAX_FRAME_BYTES}
 *  frame, with room for a large first-part header. */
export const MIN_WS_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * The message limit: `WORKFLOW_WS_MAX_MESSAGE_BYTES`, clamped to
 * {@link MIN_WS_MAX_MESSAGE_BYTES}..{@link MAX_WS_MAX_MESSAGE_BYTES} (with a
 * one-time warning), or the default when unset or not an integer.
 */
export function wsMaxMessageBytes(): number {
  return envNumber(
    'WORKFLOW_WS_MAX_MESSAGE_BYTES',
    DEFAULT_WS_MAX_MESSAGE_BYTES,
    {
      min: MIN_WS_MAX_MESSAGE_BYTES,
      max: MAX_WS_MAX_MESSAGE_BYTES,
      integer: true,
    }
  );
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

  if (body.byteLength > WS_MAX_FRAME_BYTES) {
    throw new WsFrameTooLargeError(
      `ws frame body of ${body.byteLength} bytes is over the ${WS_MAX_FRAME_BYTES}-byte limit for a split frame`
    );
  }

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
  if (partCount > WS_MAX_PART_COUNT) {
    throw new Error(
      `ws frame of ${whole.byteLength} bytes needs ${partCount} parts at a ${maxMessageBytes}-byte message limit; at most ${WS_MAX_PART_COUNT} are allowed`
    );
  }
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

function continuationMeta(
  reqId: number,
  partIndex: number,
  partCount: number
): Record<string, unknown> {
  return { type: WS_PART_TYPE, reqId, partIndex, partCount };
}

/** A frame is too large to send, even as parts. Nothing was sent. */
export class WsFrameTooLargeError extends Error {
  override name = 'WsFrameTooLargeError';
}

/** A part broke the protocol. The connection can't be trusted any more. */
export class WsPartProtocolError extends Error {
  override name = 'WsPartProtocolError';
}

/**
 * Largest frame a receiver rebuilds from parts. The receiver holds at most one
 * unfinished split frame per connection (see {@link WS_MAX_OPEN_FRAMES}), so
 * this also bounds the part bytes a connection can hold.
 */
export const WS_MAX_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Most split frames one connection may have open at once. Senders send each
 * frame's parts back to back and don't interleave frames, so one is enough.
 */
export const WS_MAX_OPEN_FRAMES = 1;

/**
 * Most parts a frame may declare. With {@link WS_MAX_OPEN_FRAMES} and
 * {@link WS_MAX_FRAME_BYTES} bounding memory, this bounds the other cost a
 * sender can impose: the number of messages handled per frame, so tiny parts
 * can't pile up. 257 parts reach {@link WS_MAX_FRAME_BYTES} at any message
 * limit of at least 1 MiB plus a header.
 */
export const WS_MAX_PART_COUNT = 257;

interface OpenFrame {
  meta: Record<string, unknown>;
  partCount: number;
  nextIndex: number;
  chunks: Uint8Array[];
  bytes: number;
  /** Nobody wants this frame: its parts are checked and counted, not kept. */
  discard: boolean;
  /** Its body passed `maxBodyBytes`: read through like a discarded frame,
   *  then reported through `onTooLarge`. */
  tooLarge: boolean;
}

export interface WsPartAssemblerOptions {
  /** Largest frame to rebuild. Default {@link WS_MAX_FRAME_BYTES}. A frame
   *  over it is a protocol error. */
  maxFrameBytes?: number;
  /**
   * Largest body a caller will accept, at most `maxFrameBytes`. A frame whose
   * body passes it stops being buffered at that point and is read through;
   * `onTooLarge` is called once its last part arrives, and it is never
   * returned. Lets a receiver refuse an oversized request without holding it
   * or dropping the connection. Default: `maxFrameBytes`.
   */
  maxBodyBytes?: number;
  onTooLarge?: (reqId: number, bytes: number) => void;
  /** Most open split frames. Default {@link WS_MAX_OPEN_FRAMES}. */
  maxOpenFrames?: number;
  /** Most parts per frame. Default {@link WS_MAX_PART_COUNT}. */
  maxPartCount?: number;
  /**
   * Whether a split frame for `reqId` is still wanted, asked at its first
   * part. An unwanted frame's parts are still checked, so the stream stays in
   * sync, but not buffered; `onDiscarded` is called once its last part
   * arrives. Default: every frame is wanted.
   */
  wanted?: (reqId: number) => boolean;
  onDiscarded?: (reqId: number) => void;
}

/**
 * Rebuilds split frames on one connection. Feed it every decoded message in
 * arrival order: it returns the complete frame when one is ready (a whole
 * message, or the last part of a split one), `undefined` while a split frame
 * is still arriving, and throws {@link WsPartProtocolError} on anything the
 * protocol doesn't allow. Open frames are keyed by `reqId`, so parts of
 * different frames may interleave.
 *
 * Bounded per connection: at most `maxOpenFrames` open frames of at most
 * `maxFrameBytes` each, and at most `maxPartCount` parts per frame. Breaking a
 * bound is a protocol error.
 */
export class WsPartAssembler {
  private readonly open = new Map<number, OpenFrame>();
  private readonly maxFrameBytes: number;
  private readonly maxBodyBytes: number;
  private readonly onTooLarge: (reqId: number, bytes: number) => void;
  private readonly maxOpenFrames: number;
  private readonly maxPartCount: number;
  private readonly wanted: (reqId: number) => boolean;
  private readonly onDiscarded: (reqId: number) => void;

  constructor(options: WsPartAssemblerOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? WS_MAX_FRAME_BYTES;
    this.maxBodyBytes = Math.min(
      options.maxBodyBytes ?? this.maxFrameBytes,
      this.maxFrameBytes
    );
    this.onTooLarge = options.onTooLarge ?? (() => {});
    this.maxOpenFrames = options.maxOpenFrames ?? WS_MAX_OPEN_FRAMES;
    this.maxPartCount = options.maxPartCount ?? WS_MAX_PART_COUNT;
    this.wanted = options.wanted ?? (() => true);
    this.onDiscarded = options.onDiscarded ?? (() => {});
  }

  accept(frame: DecodedFrame): DecodedFrame | undefined {
    const { meta, body } = frame;

    if (meta.type === WS_PART_TYPE) return this.continue(meta, body);

    const { reqId, partIndex, partCount } = meta;
    if (!('partIndex' in meta) && !('partCount' in meta)) {
      // A whole frame reusing a reqId whose split frame is still arriving
      // would be a second request, or reply, under one id.
      if (isClientReqId(reqId) && this.open.has(reqId)) {
        throw new WsPartProtocolError(
          `whole frame for reqId ${reqId} while its split frame is open`
        );
      }
      return frame;
    }

    // First part of a split frame.
    if (!isClientReqId(reqId)) {
      throw new WsPartProtocolError('first part has no valid reqId');
    }
    if (partIndex !== 0) {
      throw new WsPartProtocolError(
        `first part for reqId ${reqId} has partIndex ${String(partIndex)}, expected 0`
      );
    }
    if (!isPartCount(partCount) || partCount > this.maxPartCount) {
      throw new WsPartProtocolError(
        `first part for reqId ${reqId} has invalid partCount ${String(partCount)} (2..${this.maxPartCount})`
      );
    }
    if (this.open.has(reqId)) {
      throw new WsPartProtocolError(
        `second first part for reqId ${reqId} while one is open`
      );
    }
    if (this.open.size >= this.maxOpenFrames) {
      throw new WsPartProtocolError(
        `more than ${this.maxOpenFrames} split frames open at once`
      );
    }
    const { partIndex: _index, partCount: _count, ...frameMeta } = meta;
    const entry: OpenFrame = {
      meta: frameMeta,
      partCount,
      nextIndex: 1,
      chunks: [],
      bytes: 0,
      discard: !this.wanted(reqId),
      tooLarge: false,
    };
    this.open.set(reqId, entry);
    this.addChunk(reqId, entry, body);
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
    const last = entry.nextIndex === entry.partCount - 1;
    this.addChunk(reqId, entry, body);
    entry.nextIndex++;
    if (!last) return undefined;

    this.close(reqId);
    if (entry.tooLarge) {
      this.onTooLarge(reqId, entry.bytes);
      return undefined;
    }
    if (entry.discard) {
      this.onDiscarded(reqId);
      return undefined;
    }
    const joined = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { meta: entry.meta, body: joined };
  }

  private addChunk(reqId: number, entry: OpenFrame, body: Uint8Array): void {
    if (entry.bytes + body.byteLength > this.maxFrameBytes) {
      this.close(reqId);
      throw new WsPartProtocolError(
        `frame for reqId ${reqId} exceeds ${this.maxFrameBytes} bytes`
      );
    }
    entry.bytes += body.byteLength;
    if (!entry.discard && entry.bytes > this.maxBodyBytes) {
      // Too large for the caller: stop buffering and release what was held.
      entry.discard = true;
      entry.tooLarge = true;
      entry.chunks = [];
    }
    if (entry.discard) return;
    // Copy: the decoded body may be a view over a buffer `ws` reuses.
    entry.chunks.push(body.slice());
  }

  /** Forget an open frame, releasing its buffered bytes. */
  private close(reqId: number): void {
    this.open.delete(reqId);
  }
}

function isClientReqId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPartCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2;
}
