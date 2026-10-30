/**
 * Continuation framing for object-stream writes that exceed the transport's
 * per-chunk size cap.
 *
 * ## Why
 *
 * Every object-stream write becomes exactly one wire chunk
 * (`getSerializeStream` emits one length-prefixed frame per `write()`, and
 * `WorkflowServerWritableStream` performs one transport write per frame).
 * Transports cap a chunk: the Vercel stream API refuses a chunk over 10 MiB,
 * and the WebSocket write path cannot carry a message over 16 MiB at all.
 * A single large write (a base64 image, a big tool result) therefore failed
 * outright, with no way for the producer to make it fit short of restructuring
 * its data.
 *
 * ## What
 *
 * A write whose encoded payload would not fit one chunk is split into several
 * **outer frames**, each carrying a slice of the payload plus continuation
 * metadata. The reader reassembles the slices and then decodes the result
 * exactly as it would have decoded an unsplit payload.
 *
 * Each part is an ordinary frame whose payload is format-prefixed `splt`:
 *
 * ```
 * [4 bytes "splt"][1 byte version][4 bytes groupId][2 bytes index][2 bytes count][slice bytes]
 * ```
 *
 * ## Invariants this relies on, and why the layering is what it is
 *
 * - **Splitting happens last, outside encryption and compression.** The
 *   continuation header must stay readable by a reader that has not (yet)
 *   resolved a key, since it is what tells that reader a frame is a fragment
 *   rather than a whole value. Slicing the finished ciphertext also keeps one
 *   AEAD tag over the whole logical value, so a group missing a part fails to
 *   open instead of decoding to a truncated value.
 * - **One part is one outer frame is one stored chunk.** Resume positions stay
 *   outer-frame positions: `createReconnectingFramedStream` counts frames and
 *   reopens at `startIndex + consumedFrames` without knowing anything about
 *   groups, and a reconnect in the middle of a group simply continues at the
 *   next part.
 * - **A reader may start mid-group.** A read with an explicit `startIndex`
 *   (including the negative, last-N form) can land on part 3 of 5. Those parts
 *   are dropped, not errored: {@link createSplitReassembler} only begins a
 *   group at `index === 0` and resynchronises at the next one.
 *
 * ## Compatibility
 *
 * `splt` is a wire-format change, so producers gate it on the target run's
 * {@link RunCapabilities.splitStreamChunks} the same way they gate
 * `framedByteStreams`. With the gate off, nothing in this module runs and the
 * bytes on the wire are identical to those a pre-`splt` producer wrote.
 */

import { SerializationError } from '@workflow/errors';
import { encodeWithFormatPrefix } from './format.js';
import { SerializationFormat } from './types.js';

/** Wire version of the continuation header. */
const SPLIT_VERSION = 1;

/**
 * Bytes of continuation metadata inside a part's payload, after the 4-byte
 * `splt` format prefix: version, group id, part index, part count.
 */
export const SPLIT_HEADER_SIZE = 1 + 4 + 2 + 2;

/**
 * Total wire overhead one part adds over the slice it carries: the outer
 * frame's length prefix, the `splt` format prefix, and the continuation
 * header. Producers subtract this from the transport's chunk cap to size
 * their slices.
 */
export const SPLIT_PART_OVERHEAD_BYTES = 4 + 4 + SPLIT_HEADER_SIZE;

/** `index`/`count` are u16, so a group holds at most this many parts. */
export const MAX_SPLIT_PARTS = 0xffff;

/**
 * Upper bound on the reassembled payload of one group, matching the maximum a
 * single unsplit frame could ever have carried. Shared by the splitter
 * (rejects at write time, where the error names the offending write) and the
 * reassembler (bounds the memory a malformed group can make a reader hold), so
 * any group the splitter produces is one the reassembler can always complete.
 */
export const MAX_SPLIT_VALUE_BYTES = 100_000_000;

/** One decoded continuation part. */
export interface SplitPart {
  readonly groupId: number;
  readonly index: number;
  readonly count: number;
  readonly slice: Uint8Array;
}

/**
 * Reads the continuation header of a `splt` payload (the bytes *after* the
 * format prefix). Returns `undefined` for a header this reader does not
 * understand — a truncated part or a future wire version — so callers can
 * drop it rather than error a stream a newer producer wrote.
 */
export function decodeSplitPart(payload: Uint8Array): SplitPart | undefined {
  if (payload.byteLength < SPLIT_HEADER_SIZE) return undefined;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  if (view.getUint8(0) !== SPLIT_VERSION) return undefined;
  const count = view.getUint16(7, false);
  const index = view.getUint16(5, false);
  // A zero count, or an index outside it, cannot name a position in any group.
  if (count === 0 || index >= count) return undefined;
  return {
    groupId: view.getUint32(1, false),
    index,
    count,
    slice: payload.subarray(SPLIT_HEADER_SIZE),
  };
}

/** Builds one complete, format-prefixed part payload. */
function encodeSplitPart(
  groupId: number,
  index: number,
  count: number,
  slice: Uint8Array
): Uint8Array {
  const part = new Uint8Array(SPLIT_HEADER_SIZE + slice.byteLength);
  const view = new DataView(part.buffer);
  view.setUint8(0, SPLIT_VERSION);
  view.setUint32(1, groupId >>> 0, false);
  view.setUint16(5, index, false);
  view.setUint16(7, count, false);
  part.set(slice, SPLIT_HEADER_SIZE);
  return encodeWithFormatPrefix(SerializationFormat.SPLIT, part) as Uint8Array;
}

/**
 * A group id that distinguishes one group from its neighbours on the wire.
 *
 * It is not a durable identifier and must never be derived from a counter: a
 * replayed or reconnected writer restarts at the same counter value, and two
 * adjacent groups sharing an id would let a reader splice parts of one onto
 * the other. 32 random bits make that collision negligible, and the reader
 * additionally requires contiguous indexes and a matching part count.
 */
function nextGroupId(): number {
  const bytes = new Uint8Array(4);
  const webCrypto = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
    return new DataView(bytes.buffer).getUint32(0, false);
  }
  // Math.random is only reached on a runtime with no Web Crypto at all. The id
  // is a disambiguator, not a secret, so this degrades availability-first.
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/**
 * Splits `payload` into continuation parts, each at most `maxSliceBytes` of
 * payload. Returns the parts in order; every element is a complete `splt`
 * payload ready to be length-prefix framed and written as its own chunk.
 *
 * @throws SerializationError when the payload cannot be carried even split:
 * over {@link MAX_SPLIT_VALUE_BYTES}, or needing more than
 * {@link MAX_SPLIT_PARTS} parts at the given slice size.
 */
export function splitPayload(
  payload: Uint8Array,
  maxSliceBytes: number,
  groupId: number = nextGroupId()
): Uint8Array[] {
  if (maxSliceBytes < 1) {
    throw new SerializationError(
      `Split slice size must be at least 1 byte, got ${maxSliceBytes}.`
    );
  }
  if (payload.byteLength > MAX_SPLIT_VALUE_BYTES) {
    throw new SerializationError(
      `Stream chunk of ${payload.byteLength} bytes exceeds the maximum ` +
        `size a split write can carry (${MAX_SPLIT_VALUE_BYTES}).`,
      {
        hint: 'Write the value as a byte stream, or store it externally and stream a reference to it.',
      }
    );
  }
  const count = Math.max(1, Math.ceil(payload.byteLength / maxSliceBytes));
  if (count > MAX_SPLIT_PARTS) {
    throw new SerializationError(
      `Stream chunk of ${payload.byteLength} bytes would need ${count} ` +
        `continuation frames; the maximum is ${MAX_SPLIT_PARTS}.`,
      {
        hint: 'Write the value as a byte stream, or store it externally and stream a reference to it.',
      }
    );
  }
  const parts: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * maxSliceBytes;
    parts.push(
      encodeSplitPart(
        groupId,
        index,
        count,
        payload.subarray(
          start,
          Math.min(start + maxSliceBytes, payload.byteLength)
        )
      )
    );
  }
  return parts;
}

/** Why a reassembler discarded a part. Diagnostics only; reads continue. */
export type SplitDropReason =
  /** A part this reader cannot parse: truncated, or a future wire version. */
  | 'unreadable'
  /** A continuation whose group never started here, e.g. a mid-group read. */
  | 'orphaned'
  /** A part that does not continue the open group (id, order, or count). */
  | 'out-of-order'
  /** A group whose reassembled size would exceed the shared bound. */
  | 'too-large';

export type SplitAcceptResult =
  /** More parts are needed before the value is whole. */
  | { readonly kind: 'pending' }
  /** The group completed; `payload` is the reassembled, still-encoded value. */
  | { readonly kind: 'complete'; readonly payload: Uint8Array }
  /** Nothing to deliver; see `reason`. */
  | { readonly kind: 'dropped'; readonly reason: SplitDropReason };

export interface SplitReassembler {
  /** Offers one `splt` payload (the bytes after the format prefix). */
  accept(payload: Uint8Array): SplitAcceptResult;
  /** Whether a group is open, i.e. the stream ended mid-group. */
  readonly pending: boolean;
  /** Abandons any open group. Used when a reader resumes from elsewhere. */
  reset(): void;
}

/**
 * Reassembles continuation parts back into whole payloads.
 *
 * One reassembler belongs to one reader session and persists across the
 * reconnects that session makes, so a group split by a dropped connection
 * completes from the parts the reopened connection delivers.
 *
 * Anything that is not a well-formed continuation of the open group is
 * dropped rather than errored, because the common cause is a legitimate read
 * position rather than corruption: a read with an explicit `startIndex` can
 * begin on any part of any group. Dropping a fragment the caller could never
 * have assembled, and resynchronising at the next `index === 0`, is the
 * behaviour that makes a mid-group `startIndex` usable at all.
 */
/** A group being reassembled: its identity, and the slices received so far. */
interface OpenGroup {
  readonly groupId: number;
  readonly count: number;
  /** The part index this group expects next. */
  next: number;
  readonly slices: Uint8Array[];
}

function sizeOf(group: OpenGroup): number {
  let total = 0;
  for (const slice of group.slices) total += slice.byteLength;
  return total;
}

export function createSplitReassembler(): SplitReassembler {
  let open: OpenGroup | undefined;

  function drop(reason: SplitDropReason): SplitAcceptResult {
    open = undefined;
    return { kind: 'dropped', reason };
  }

  /**
   * The group `part` extends, or the reason it extends none. A part 0 always
   * opens a fresh group, superseding any group still open: the only way one is
   * left open is a producer that never finished it (a crashed or replaced
   * writer), whose parts can never be completed from here.
   */
  function groupFor(part: SplitPart): OpenGroup | SplitDropReason {
    if (part.index === 0) {
      return { groupId: part.groupId, count: part.count, next: 0, slices: [] };
    }
    if (open === undefined) return 'orphaned';
    if (
      open.groupId !== part.groupId ||
      open.count !== part.count ||
      open.next !== part.index
    ) {
      return 'out-of-order';
    }
    return open;
  }

  return {
    get pending() {
      return open !== undefined;
    },
    reset() {
      open = undefined;
    },
    accept(payload) {
      const part = decodeSplitPart(payload);
      if (!part) return drop('unreadable');

      const group = groupFor(part);
      if (typeof group === 'string') return drop(group);
      open = group;

      if (sizeOf(group) + part.slice.byteLength > MAX_SPLIT_VALUE_BYTES) {
        return drop('too-large');
      }
      group.slices.push(part.slice);
      group.next = part.index + 1;
      if (group.next < group.count) return { kind: 'pending' };

      const reassembled = new Uint8Array(sizeOf(group));
      let offset = 0;
      for (const slice of group.slices) {
        reassembled.set(slice, offset);
        offset += slice.byteLength;
      }
      open = undefined;
      return { kind: 'complete', payload: reassembled };
    },
  };
}
