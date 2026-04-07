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
    streams: {
      async write(
        runId: string | Promise<string>,
        name: string,
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

      async writeMulti(
        runId: string | Promise<string>,
        name: string,
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

      async close(runId: string | Promise<string>, name: string) {
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

      async get(_runId: string, name: string, startIndex?: number) {
        const httpConfig = await getHttpConfig(config);
        const url = getStreamUrl(name, undefined, httpConfig);
        if (typeof startIndex === 'number') {
          url.searchParams.set('startIndex', String(startIndex));
        }
        const response = await fetch(url, {
          headers: httpConfig.headers,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch stream: ${response.status}`);
        }
        if (!response.body) {
          throw new Error('No response body for stream');
        }
        return response.body as ReadableStream<Uint8Array>;
      },

      async getChunks(
        runId: string,
        name: string,
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

      async getInfo(
        runId: string,
        name: string
      ): Promise<StreamInfoResponse> {
        const endpoint = `/v2/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(name)}/info`;
        return makeRequest({
          endpoint,
          config,
          schema: StreamInfoResponseSchema,
        });
      },

      async list(runId: string) {
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
    },
  };
}
