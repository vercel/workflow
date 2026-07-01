// ============================================================================
// Streaming-write recovery (the rare path: unclean segment failure)
// ============================================================================
//
// When a streaming segment fails uncleanly (connection drop / 5xx — anything
// but a clean `200`), the writer does not know which of its in-flight frames
// the backend persisted before the cut. This module reconstructs that from the
// persisted tail and replays only the un-persisted frames on a fresh request.
//
// Why the framed-v2 marker is load-bearing here: multiple writers can append to
// one stream concurrently (parent → child forwarding, concurrent steps), so a
// server chunk index is NOT attributable to a single writer. The writer instead
// finds its OWN frames by matching `writerId` in the frame marker, and resumes
// after the highest `seq` it authored that is already persisted.
//
// Reserve-ahead race: `reserveDurableStreamChunkIndex` bumps the shared counter
// BEFORE the chunk is stored, so `getInfo().tailIndex` can momentarily point at
// a reserved-but-unpersisted chunk. We read the tail with backoff (10/100/1000
// ms); if a tail chunk is still unreadable after the window, the write has
// genuinely failed and we surface a real error rather than silently skipping a
// gap.
//
// A persisted chunk's bytes are the full framed-v2 inner frame — the world's
// multi-chunk parser strips only the outer transport length prefix, leaving
// `[4-byte inner length][writerId][seq][payload]`. So the marker is read at
// `FRAME_HEADER_SIZE` into each chunk's data (see `frame-marker.ts`).

import { WorkflowRuntimeError } from '@workflow/errors';
import {
  FRAME_HEADER_SIZE,
  FRAME_MARKER_SIZE,
  readFrameMarker,
  writerIdKey,
} from './frame-marker.js';

/** One persisted chunk from the tail (matches `world` `StreamChunk`). */
export interface TailChunk {
  index: number;
  data: Uint8Array;
}

/**
 * The subset of the world's streamer that recovery needs. Injected so the
 * algorithm is unit-testable without a real world.
 */
export interface RecoveryTransport {
  getInfo(): Promise<{ tailIndex: number }>;
  getChunks(opts: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: TailChunk[]; cursor: string | null; hasMore: boolean }>;
  /** Replay a fresh streaming request; resolves with the new chunk indices. */
  writeStream(
    frames: ReadableStream<Uint8Array>
  ): Promise<{ chunkIndices: number[] }>;
}

export interface RecoveryOptions {
  /** This writer's identity — frames with this id in the tail are ours. */
  writerId: Uint8Array;
  /**
   * First server index that could hold one of the unconfirmed frames — one
   * past the last index confirmed by the prior clean segment (`max(indices)+1`,
   * or 0 if none). Chunks below this are older commits, not ours to inspect.
   */
  scanFromIndex: number;
  /** Backoff schedule for a reserved-but-unpersisted tail chunk. */
  backoffMs?: number[];
  /** Max whole-recovery attempts (re-scan + replay) before giving up. */
  maxAttempts?: number;
  /** Chunks per `getChunks` page. */
  chunkPageSize?: number;
  /** Injectable sleep for deterministic tests. Default real timers. */
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_BACKOFF_MS = [10, 100, 1000];
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the framed-v2 marker from a persisted chunk, or null if too short. */
function markerOf(
  data: Uint8Array
): { writerId: Uint8Array; seq: bigint } | null {
  if (data.length < FRAME_HEADER_SIZE + FRAME_MARKER_SIZE) return null;
  return readFrameMarker(data.subarray(FRAME_HEADER_SIZE));
}

/** The chunk's `seq` if it was authored by `targetKey`, else undefined. */
function seqIfOurs(data: Uint8Array, targetKey: string): bigint | undefined {
  const marker = markerOf(data);
  if (!marker || writerIdKey(marker.writerId) !== targetKey) return undefined;
  return marker.seq;
}

function framesToReadable(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(frames[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Result of one full pagination pass over the persisted window. */
interface WindowScan {
  /** Highest chunk index observed in `[scanFromIndex, tailIndex]`. */
  maxIndex: number;
  /** Highest `seq` authored by the target writer, or undefined if none. */
  maxSeq: bigint | undefined;
}

/**
 * Page through the whole stream once, keeping only chunks in
 * `[scanFromIndex, tailIndex]`, and report the highest index seen and the
 * highest `seq` authored by `targetKey`.
 */
async function scanWindowOnce(
  transport: RecoveryTransport,
  targetKey: string,
  scanFromIndex: number,
  tailIndex: number,
  pageSize: number
): Promise<WindowScan> {
  let cursor: string | undefined;
  let maxIndex = scanFromIndex - 1;
  let maxSeq: bigint | undefined;

  for (;;) {
    const page = await transport.getChunks({ limit: pageSize, cursor });
    for (const chunk of page.data) {
      if (chunk.index < scanFromIndex || chunk.index > tailIndex) continue;
      if (chunk.index > maxIndex) maxIndex = chunk.index;
      const seq = seqIfOurs(chunk.data, targetKey);
      if (seq !== undefined && (maxSeq === undefined || seq > maxSeq)) {
        maxSeq = seq;
      }
    }
    cursor = page.cursor ?? undefined;
    if (!page.hasMore || !cursor) break;
  }

  return { maxIndex, maxSeq };
}

/**
 * Scan the persisted window `[scanFromIndex, tailIndex]` and return the highest
 * `seq` authored by `writerId`, or `undefined` if none of ours is present.
 *
 * Retries the whole scan on backoff while the readable tail falls short of
 * `tailIndex` (a reserved-but-unpersisted chunk); throws once the backoff is
 * exhausted and the gap remains — a genuinely failed write, surfaced rather
 * than skipped.
 */
async function scanTailForMaxSeq(
  transport: RecoveryTransport,
  targetKey: string,
  scanFromIndex: number,
  tailIndex: number,
  backoffMs: number[],
  pageSize: number,
  sleep: (ms: number) => Promise<void>
): Promise<bigint | undefined> {
  if (tailIndex < scanFromIndex) return undefined;

  for (let attempt = 0; ; attempt++) {
    const { maxIndex, maxSeq } = await scanWindowOnce(
      transport,
      targetKey,
      scanFromIndex,
      tailIndex,
      pageSize
    );
    if (maxIndex >= tailIndex) return maxSeq;

    // Tail gap: the chunk at `tailIndex` was reserved but is not readable yet.
    if (attempt >= backoffMs.length) {
      throw new WorkflowRuntimeError(
        `Stream recovery: tail chunk ${tailIndex} was reserved but never ` +
          `persisted (still unreadable after ${backoffMs.length} backoff ` +
          `attempts) — the write has failed.`
      );
    }
    await sleep(backoffMs[attempt]);
  }
}

/**
 * Recover unconfirmed frames after an unclean segment failure. Finds this
 * writer's highest already-persisted `seq` in the tail and replays only the
 * frames after it on a fresh streaming request.
 *
 * `unconfirmed` are complete framed-v2 frames
 * (`[4-byte length][writerId][seq][payload]`); their `seq` is read from the
 * marker, so the caller need not track it separately.
 *
 * Resolves with the chunk indices assigned to the replayed frames (empty if
 * everything was already durable). Rejects if the tail can't be reconciled
 * within the backoff window, or if replay keeps failing past `maxAttempts`.
 */
export async function recoverStreamTail(
  unconfirmed: Uint8Array[],
  options: RecoveryOptions,
  transport: RecoveryTransport
): Promise<{ chunkIndices: number[] }> {
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pageSize = options.chunkPageSize ?? DEFAULT_PAGE_SIZE;
  const sleep = options.sleep ?? defaultSleep;
  const targetKey = writerIdKey(options.writerId);

  // Sort our frames by seq so the replay preserves authored order regardless of
  // how the buffer was assembled.
  const bySeq = unconfirmed
    .map((frame) => {
      const marker = markerOf(frame);
      if (!marker) {
        throw new WorkflowRuntimeError(
          'Stream recovery: unconfirmed frame is smaller than a framed-v2 marker.'
        );
      }
      return { seq: marker.seq, frame };
    })
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  for (let attempt = 0; ; attempt++) {
    const { tailIndex } = await transport.getInfo();
    const maxPersistedSeq = await scanTailForMaxSeq(
      transport,
      targetKey,
      options.scanFromIndex,
      tailIndex,
      backoffMs,
      pageSize,
      sleep
    );

    const toReplay =
      maxPersistedSeq === undefined
        ? bySeq
        : bySeq.filter((x) => x.seq > maxPersistedSeq);

    if (toReplay.length === 0) {
      // Everything we had in flight was already persisted before the cut.
      return { chunkIndices: [] };
    }

    try {
      return await transport.writeStream(
        framesToReadable(toReplay.map((x) => x.frame))
      );
    } catch (error) {
      // The replay itself may have partially persisted, so re-scan on retry
      // rather than blindly resending everything.
      if (attempt + 1 >= maxAttempts) throw error;
    }
  }
}
