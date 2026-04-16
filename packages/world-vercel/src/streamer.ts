import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { z } from 'zod';
import {
  type APIConfig,
  getHttpConfig,
  type HttpConfig,
  makeRequest,
} from './utils.js';

/**
 * Maximum number of chunks per request, matching the server-side
 * MAX_CHUNKS_PER_BATCH. Larger batches are split into multiple requests.
 */
export const MAX_CHUNKS_PER_REQUEST = 1000;

// Streaming calls use plain fetch() without the undici dispatcher.
// The dispatcher's retry logic doesn't apply well to streaming operations
// (partial writes, long-lived reads), and duplex streams are incompatible
// with undici's experimental H2 support.

/**
 * Stream control frame constants, mirroring workflow-server's format.
 *
 * Control frame (13 bytes):
 *   [0-3]  Zero-frame marker (0x00 0x00 0x00 0x00)
 *   [4]    Flags — bit 0: done (1 = complete, 0 = timeout/reconnect)
 *   [5-8]  nextIndex — big-endian uint32, chunk index to resume from
 *   [9-12] Magic footer — "WFCT" (0x57 0x46 0x43 0x54)
 */
export const STREAM_CONTROL_FRAME_SIZE = 13;
const STREAM_CONTROL_MAGIC = new Uint8Array([0x57, 0x46, 0x43, 0x54]);

export interface StreamControlFrame {
  done: boolean;
  nextIndex: number;
}

/**
 * Try to parse a stream control frame from the tail of a buffer.
 * Returns the parsed frame and the byte length of the control data,
 * or null if no valid control frame is present.
 */
export function parseStreamControlFrame(
  buffer: Uint8Array
): (StreamControlFrame & { totalLength: number }) | null {
  if (buffer.length < STREAM_CONTROL_FRAME_SIZE) return null;

  const offset = buffer.length - STREAM_CONTROL_FRAME_SIZE;

  // Check zero-frame marker (bytes 0-3 must be 0x00)
  if (
    buffer[offset] !== 0 ||
    buffer[offset + 1] !== 0 ||
    buffer[offset + 2] !== 0 ||
    buffer[offset + 3] !== 0
  ) {
    return null;
  }

  // Check magic footer at bytes 9-12
  if (
    buffer[offset + 9] !== STREAM_CONTROL_MAGIC[0] ||
    buffer[offset + 10] !== STREAM_CONTROL_MAGIC[1] ||
    buffer[offset + 11] !== STREAM_CONTROL_MAGIC[2] ||
    buffer[offset + 12] !== STREAM_CONTROL_MAGIC[3]
  ) {
    return null;
  }

  const flags = buffer[offset + 4];
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 5, 4);
  const nextIndex = view.getUint32(0, false);

  return {
    done: (flags & 1) === 1,
    nextIndex,
    totalLength: STREAM_CONTROL_FRAME_SIZE,
  };
}

function getStreamUrl(
  name: string,
  runId: string | undefined,
  httpConfig: HttpConfig
) {
  if (runId) {
    return new URL(
      `${httpConfig.baseUrl}/v2/runs/${encodeURIComponent(runId)}/stream/${encodeURIComponent(name)}`
    );
  }
  return new URL(`${httpConfig.baseUrl}/v2/stream/${encodeURIComponent(name)}`);
}

/**
 * Encode multiple chunks into a length-prefixed binary format.
 * Format: [4 bytes big-endian length][chunk bytes][4 bytes length][chunk bytes]...
 *
 * This preserves chunk boundaries so the server can store them as separate
 * chunks, maintaining correct startIndex semantics for readers.
 *
 * @internal Exported for testing purposes
 */
export function encodeMultiChunks(chunks: (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder();

  // Convert all chunks to Uint8Array and calculate total size
  const binaryChunks: Uint8Array[] = [];
  let totalSize = 0;

  for (const chunk of chunks) {
    const binary = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    binaryChunks.push(binary);
    totalSize += 4 + binary.length; // 4 bytes for length prefix
  }

  // Allocate buffer and write length-prefixed chunks
  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const binary of binaryChunks) {
    view.setUint32(offset, binary.length, false); // big-endian
    offset += 4;
    result.set(binary, offset);
    offset += binary.length;
  }

  return result;
}

const StreamInfoResponseSchema = z.object({
  tailIndex: z.number(),
  done: z.boolean(),
});

/**
 * Zod schema for the paginated stream chunks response from the server.
 * When using CBOR (the default for makeRequest), chunk data arrives as
 * native Uint8Array byte strings — no base64 decoding required.
 */
const StreamChunksResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number(),
      data: z.instanceof(Uint8Array),
    })
  ),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  done: z.boolean(),
});

/** Creates the HTTP-backed streamer that talks to workflow-server. */
export function createStreamer(config?: APIConfig): Streamer {
  return {
    async writeToStream(
      name: string,
      runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);
      const response = await fetch(
        getStreamUrl(name, resolvedRunId, httpConfig),
        {
          method: 'PUT',
          body: chunk,
          headers: httpConfig.headers,
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Stream write failed: HTTP ${response.status}: ${text}`
        );
      }
    },

    async writeToStreamMulti(
      name: string,
      runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;

      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);

      // Signal to server that this is a multi-chunk batch
      httpConfig.headers.set('X-Stream-Multi', 'true');

      // Send in pages of MAX_CHUNKS_PER_REQUEST to stay within the
      // server's per-batch limit (MAX_CHUNKS_PER_BATCH).
      // Note: for batches spanning multiple pages, atomicity is relaxed —
      // earlier pages may persist while a later page fails. The caller
      // retains the full buffer on error, so chunks from successful pages
      // will be re-sent on retry, producing duplicates. This is acceptable
      // because the alternative (400 on all >1000 chunk flushes) is worse,
      // and the scenario requires a network failure mid-batch.
      for (let i = 0; i < chunks.length; i += MAX_CHUNKS_PER_REQUEST) {
        const batch = chunks.slice(i, i + MAX_CHUNKS_PER_REQUEST);
        const body = encodeMultiChunks(batch);
        const response = await fetch(
          getStreamUrl(name, resolvedRunId, httpConfig),
          {
            method: 'PUT',
            body,
            headers: httpConfig.headers,
          }
        );
        const text = await response.text();
        if (!response.ok) {
          throw new Error(
            `Stream write failed: HTTP ${response.status}: ${text}`
          );
        }
      }
    },

    async closeStream(name: string, runId: string | Promise<string>) {
      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);
      httpConfig.headers.set('X-Stream-Done', 'true');
      const response = await fetch(
        getStreamUrl(name, resolvedRunId, httpConfig),
        {
          method: 'PUT',
          headers: httpConfig.headers,
        }
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Stream close failed: HTTP ${response.status}: ${text}`
        );
      }
    },

    async readFromStream(name: string, startIndex?: number) {
      let currentStartIndex = startIndex ?? 0;

      // Cap reconnections to prevent infinite loops if the server
      // never completes the stream. 50 reconnects at 2-min server
      // timeout ≈ 100 minutes of streaming.
      const MAX_RECONNECTS = 50;
      let reconnectCount = 0;

      const connect = async (): Promise<Response> => {
        const httpConfig = await getHttpConfig(config);
        // Use v3 to receive the stream control frame for reconnection.
        const url = new URL(
          `${httpConfig.baseUrl}/v3/stream/${encodeURIComponent(name)}`
        );
        url.searchParams.set('startIndex', String(currentStartIndex));
        const response = await fetch(url, {
          headers: httpConfig.headers,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch stream: ${response.status}`);
        }
        if (!response.body) {
          throw new Error('No response body for stream');
        }
        return response;
      };

      // Read the entire response as bytes, then strip any trailing
      // control frame. This avoids the complexity of hold-back buffering
      // inside a ReadableStream pull loop, which interacts poorly with
      // the proxy and byte-stream wrappers in production.
      const readFull = async (): Promise<{
        data: Uint8Array;
        control: (StreamControlFrame & { totalLength: number }) | null;
      }> => {
        const response = await connect();
        const buffer = new Uint8Array(await response.arrayBuffer());
        const control = parseStreamControlFrame(buffer);
        if (control) {
          const dataLen = buffer.length - control.totalLength;
          return {
            data: dataLen > 0 ? buffer.subarray(0, dataLen) : new Uint8Array(0),
            control,
          };
        }
        return { data: buffer, control: null };
      };

      // Collect all data, transparently reconnecting on server timeout.
      const parts: Uint8Array[] = [];
      for (;;) {
        const { data, control } = await readFull();
        if (data.length > 0) {
          parts.push(data);
        }

        if (!control || control.done) {
          // Stream complete or no control frame (older server).
          break;
        }

        // Timeout — reconnect from the next chunk index.
        reconnectCount++;
        if (reconnectCount > MAX_RECONNECTS) {
          throw new Error(
            `Stream exceeded maximum reconnection attempts (${MAX_RECONNECTS})`
          );
        }
        currentStartIndex = control.nextIndex;
      }

      // Return a ReadableStream that emits the collected data.
      let emitted = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            for (const part of parts) {
              controller.enqueue(part);
            }
          }
          controller.close();
        },
      });
    },

    async getStreamChunks(
      name: string,
      runId: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse> {
      const params = new URLSearchParams();
      if (options?.limit != null) {
        params.set('limit', String(options.limit));
      }
      if (options?.cursor) {
        params.set('cursor', options.cursor);
      }
      const qs = params.toString();
      const endpoint = `/v2/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(name)}/chunks${qs ? `?${qs}` : ''}`;
      return makeRequest({
        endpoint,
        config,
        schema: StreamChunksResponseSchema,
      });
    },

    async getStreamInfo(
      name: string,
      runId: string
    ): Promise<StreamInfoResponse> {
      const endpoint = `/v2/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(name)}/info`;
      return makeRequest({
        endpoint,
        config,
        schema: StreamInfoResponseSchema,
      });
    },

    async listStreamsByRunId(runId: string) {
      const httpConfig = await getHttpConfig(config);
      const url = new URL(
        `${httpConfig.baseUrl}/v2/runs/${encodeURIComponent(runId)}/streams`
      );
      const response = await fetch(url, {
        headers: httpConfig.headers,
      });
      if (!response.ok) {
        throw new Error(`Failed to list streams: ${response.status}`);
      }
      return (await response.json()) as string[];
    },
  };
}
