import type { Streamer } from '@workflow/world';
import { type APIConfig, getHttpConfig, type HttpConfig } from './utils.js';

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
      `${httpConfig.baseUrl}/v2/runs/${runId}/stream/${encodeURIComponent(name)}`
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
      await response.text();
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

      const body = encodeMultiChunks(chunks);
      const response = await fetch(
        getStreamUrl(name, resolvedRunId, httpConfig),
        {
          method: 'PUT',
          body,
          headers: httpConfig.headers,
        }
      );
      await response.text();
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
      await response.text();
    },

    async readFromStream(name: string, startIndex?: number) {
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

    async listStreamsByRunId(runId: string) {
      const httpConfig = await getHttpConfig(config);
      const url = new URL(`${httpConfig.baseUrl}/v2/runs/${runId}/streams`);
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
