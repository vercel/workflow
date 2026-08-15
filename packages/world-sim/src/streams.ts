/**
 * In-memory streamer.
 *
 * Streams carry step/workflow payloads that exceed the inline event budget,
 * plus any `ReadableStream` a workflow passes around. The simulation keeps
 * them as plain chunk arrays.
 *
 * The one subtlety is `get()`: a reader can legitimately attach to a stream
 * before the writer has produced anything, and must then observe chunks as
 * they arrive rather than seeing an empty stream. Because the scheduler runs
 * one delivery at a time and never blocks on wall-clock time, a reader that
 * parked on an unfinished stream would deadlock the scenario. So readers park
 * on a promise that the *writer* resolves, and `abortOpenReaders()` releases
 * any that are still parked when the scenario ends — turning what would be a
 * hang into a reported diagnostic.
 */

import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  KeyedStreamAppendRequest,
  KeyedStreamAppendResult,
} from '@workflow/world';

interface StreamState {
  chunks: Uint8Array[];
  closed: boolean;
  /** Resolvers for readers waiting on more data. */
  waiters: (() => void)[];
  keyed: Map<
    string,
    { semanticDigest: string; chunk: Uint8Array; index: number }
  >;
}

export interface SimStreamer extends Streamer {
  /** Number of readers currently parked on an unfinished stream. */
  openReaderCount(): number;
  /** Release every parked reader; used at scenario teardown. */
  abortOpenReaders(): void;
  streamNames(runId: string): string[];
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
}

export function createSimStreamer(): SimStreamer {
  const streams = new Map<string, StreamState>();
  let openReaders = 0;
  let aborted = false;

  const key = (runId: string, name: string) => `${runId}\0${name}`;

  function stateFor(runId: string, name: string): StreamState {
    const k = key(runId, name);
    let state = streams.get(k);
    if (!state) {
      state = { chunks: [], closed: false, waiters: [], keyed: new Map() };
      streams.set(k, state);
    }
    return state;
  }

  function wake(state: StreamState) {
    const waiters = state.waiters;
    state.waiters = [];
    for (const w of waiters) w();
  }

  return {
    keyedStreamAppendVersion: 1,
    streams: {
      async appendKeyed(
        runId: string,
        name: string,
        request: KeyedStreamAppendRequest
      ): Promise<KeyedStreamAppendResult> {
        const state = stateFor(runId, name);
        const existing = state.keyed.get(request.idempotencyKey);
        if (existing) {
          if (existing.semanticDigest !== request.semanticDigest)
            throw new Error(
              'Keyed stream append retried with a different digest'
            );
          return {
            inserted: false,
            canonicalChunk: Uint8Array.from(existing.chunk),
            index: existing.index,
          };
        }
        const chunk = Uint8Array.from(request.chunk);
        const result = {
          semanticDigest: request.semanticDigest,
          chunk,
          index: state.chunks.length,
        };
        state.keyed.set(request.idempotencyKey, result);
        state.chunks.push(chunk);
        wake(state);
        return {
          inserted: true,
          canonicalChunk: Uint8Array.from(chunk),
          index: result.index,
        };
      },
      async write(runId, name, chunk) {
        const state = stateFor(runId, name);
        state.chunks.push(toBytes(chunk));
        wake(state);
      },
      async writeMulti(runId, name, chunks) {
        const state = stateFor(runId, name);
        for (const chunk of chunks) state.chunks.push(toBytes(chunk));
        wake(state);
      },
      async close(runId, name) {
        const state = stateFor(runId, name);
        state.closed = true;
        wake(state);
      },
      async get(runId, name, startIndex = 0) {
        const state = stateFor(runId, name);
        let index =
          startIndex < 0
            ? Math.max(0, state.chunks.length + startIndex)
            : startIndex;
        openReaders++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          openReaders--;
        };
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            while (index >= state.chunks.length) {
              if (state.closed || aborted) {
                release();
                controller.close();
                return;
              }
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
            controller.enqueue(state.chunks[index++]);
          },
          cancel() {
            release();
          },
        });
      },
      async list(runId) {
        const prefix = `${runId}\0`;
        return [...streams.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
      },
      async getChunks(
        runId: string,
        name: string,
        options?: GetChunksOptions
      ): Promise<StreamChunksResponse> {
        const state = stateFor(runId, name);
        // `Math.max(1, …)`: a caller asking for zero chunks gets one rather
        // than an empty page that reports `hasMore` forever.
        const limit = Math.max(1, Math.min(options?.limit ?? 100, 1000));
        // A cursor is an opaque string from a previous page; a garbled one
        // must not become `NaN` and slice the whole array away silently.
        const parsed = Number(options?.cursor ?? 0);
        const from =
          Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
        const slice = state.chunks.slice(from, from + limit);
        const next = from + slice.length;
        return {
          data: slice.map((data, i) => ({ index: from + i, data })),
          cursor: next < state.chunks.length ? String(next) : null,
          hasMore: next < state.chunks.length,
          done: state.closed,
        };
      },
      async getInfo(runId, name) {
        const state = stateFor(runId, name);
        return { tailIndex: state.chunks.length - 1, done: state.closed };
      },
    },

    openReaderCount: () => openReaders,
    abortOpenReaders() {
      aborted = true;
      for (const state of streams.values()) wake(state);
    },
    streamNames(runId) {
      const prefix = `${runId}\0`;
      return [...streams.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}
