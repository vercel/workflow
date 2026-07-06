import {
  envNumber,
  type GetChunksOptions,
  type StreamChunksResponse,
  type Streamer,
  type StreamInfoResponse,
  type StreamWriteChannel,
  type StreamWriteChannelHandlers,
} from '@workflow/world';
import { WebSocket as UndiciWebSocket } from 'undici';
import { z } from 'zod';
import { getStreamDispatcher } from './http-client.js';
import { getVercelDiagnostics, instrumentedFetch } from './http-core.js';
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

/**
 * Effective max chunks per write request. Override via
 * `WORKFLOW_MAX_CHUNKS_PER_REQUEST` — lower it (paired with the server's
 * `MAX_CHUNKS_PER_BATCH` override) to exercise the batch-splitting path.
 */
const getMaxChunksPerRequest = (): number =>
  envNumber('WORKFLOW_MAX_CHUNKS_PER_REQUEST', MAX_CHUNKS_PER_REQUEST, {
    integer: true,
    min: 1,
  });

// All stream requests share the instrumented envelope (`instrumentedFetch`):
// an OTEL client span, trace-context injection, `DEBUG` logging, and the
// x-vercel diagnostic headers — the same coverage the v3/v4 paths have.
//
// Writes (the PUT write/close path) go through the H2 stream dispatcher (see
// getStreamDispatcher): they send a fully-buffered body (or none), so they
// benefit from H2 multiplexing without hitting the duplex issues that keep the
// long-lived live-read (GET) on the global dispatcher. Because stream appends
// aren't idempotent, that stream dispatcher uses a deliberately narrowed retry
// policy (see STREAM_RETRY_OPTIONS): it retries only on transient connection
// errors and HTTP 429 — both of which guarantee the chunk was never persisted —
// and never on 5xx, so a retry can't duplicate an already-applied write.
// Snapshot reads (chunks/info) go through makeRequest (default H1 dispatcher);
// the live-read (GET) and list keep the global dispatcher (no custom retry) and
// no request timeout — the live read is long-lived and a whole-request deadline
// would truncate it.

// All stream reads and writes use the v3 stream endpoint:
//  - GET (live read): on a max-duration timeout (or a mid-stream connection
//    drop) the server errors the response body instead of closing it cleanly,
//    which is what lets the reconnecting reader
//    (`createReconnectingFramedStream`) resume from the next chunk rather
//    than treating the timeout as end-of-stream. Reading from v2 would
//    silently truncate long-lived streams at the server's 2-minute limit.
//  - GET .../ws (write channel, `connectWrite`): upgrades to a WebSocket on
//    which each binary message is one chunk, persisted + published on arrival
//    and acked back on the same connection — the write path for framed-v2
//    streams. The dedicated path also makes the rollout observable: any hit
//    on it in request logs is a streaming-mode writer.
//  - PUT (write/writeMulti/close): the batched fallback path and the done
//    marker. Handler semantics match v2; keeping current-generation writers
//    on one version makes rollout and request-log analysis unambiguous.
// Snapshot reads (chunks/info) and the stream list stay on v2.
function getStreamUrl(name: string, runId: string, httpConfig: HttpConfig) {
  return new URL(
    `${httpConfig.baseUrl}/v3/runs/${encodeURIComponent(runId)}/stream/${encodeURIComponent(name)}`
  );
}

function createStreamRequestError(
  operation: 'write' | 'close',
  url: URL,
  response: Response,
  text: string
): Error {
  const context = [
    `PUT ${url.origin}${url.pathname}`,
    ...getVercelDiagnostics(response.headers),
  ];

  return new Error(
    `Stream ${operation} failed: HTTP ${response.status} (${context.join('; ')}): ${text}`
  );
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
 * One ack on the stream write channel: the 0-based ordinal of the chunk
 * within the connection and the backend index it persisted under. Sent by the
 * server as a JSON text message after each binary chunk message, in order.
 * Tolerant of extra fields.
 */
const StreamWriteAckSchema = z.object({
  index: z.number(),
  chunkIndex: z.number(),
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
        const url = getStreamUrl(name, resolvedRunId, httpConfig);
        const response = await instrumentedFetch({
          method: 'PUT',
          url: url.toString(),
          body: chunk,
          headers: httpConfig.headers,
          dispatcher: getStreamDispatcher(config),
          timeoutMs: null,
          logLabel: url.pathname,
          buildError: async (res) =>
            createStreamRequestError('write', url, res, await res.text()),
        });
        // Drain the (empty) response so undici can release the pooled connection.
        await response.text();
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
        const maxChunksPerRequest = getMaxChunksPerRequest();
        for (let i = 0; i < chunks.length; i += maxChunksPerRequest) {
          const batch = chunks.slice(i, i + maxChunksPerRequest);
          const body = encodeMultiChunks(batch);
          const url = getStreamUrl(name, resolvedRunId, httpConfig);
          const response = await instrumentedFetch({
            method: 'PUT',
            url: url.toString(),
            body,
            headers: httpConfig.headers,
            dispatcher: getStreamDispatcher(config),
            timeoutMs: null,
            logLabel: url.pathname,
            buildError: async (res) =>
              createStreamRequestError('write', url, res, await res.text()),
          });
          // Drain so undici can release the pooled connection between pages.
          await response.text();
        }
      },

      async connectWrite(
        runId: string,
        name: string,
        handlers: StreamWriteChannelHandlers
      ): Promise<StreamWriteChannel> {
        const httpConfig = await getHttpConfig(config);
        const url = getStreamUrl(name, runId, httpConfig);
        url.pathname = `${url.pathname}/ws`;
        url.protocol = 'wss:';

        // undici's WebSocket (unlike the WHATWG global) accepts custom
        // headers on the upgrade request, so the channel authenticates
        // exactly like every HTTP call (Authorization + the trusted-OIDC
        // deployment-protection bypass, both already set by getHttpConfig).
        // (Plain record: undici's WebSocketInit headers type doesn't accept a
        // WHATWG Headers instance.)
        const ws = new UndiciWebSocket(url, {
          headers: Object.fromEntries(httpConfig.headers),
        });

        // onClose must fire exactly once, whether the socket errors, is
        // closed by the server, or closed locally.
        let closed = false;
        const emitClose = (event: { code?: number; reason?: string }) => {
          if (closed) return;
          closed = true;
          handlers.onClose(event);
        };

        ws.addEventListener('message', (event) => {
          // Acks are JSON text messages `{ index, chunkIndex }`, in order.
          try {
            const ack = StreamWriteAckSchema.parse(
              JSON.parse(String(event.data))
            );
            handlers.onAck(ack);
          } catch {
            // An unparseable server message means the two sides disagree on
            // the protocol — fail the channel rather than silently dropping
            // what might have been an ack.
            emitClose({ reason: 'unparseable ack from server' });
            ws.close();
          }
        });
        ws.addEventListener('close', (event) => {
          emitClose({ code: event.code, reason: event.reason });
        });
        ws.addEventListener('error', () => {
          // 'close' follows 'error' per spec, but emit defensively in case
          // the socket never completes the close handshake.
          emitClose({ reason: 'connection error' });
        });

        await new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener(
            'close',
            (event) =>
              reject(
                new Error(
                  `Stream write channel failed to connect: ` +
                    `${event.code ?? ''} ${event.reason ?? ''}`.trim()
                )
              ),
            { once: true }
          );
        });

        return {
          send(chunk: Uint8Array) {
            ws.send(chunk);
          },
          close() {
            ws.close(1000, 'writer closing');
          },
        };
      },

      async close(runId: string | Promise<string>, name: string) {
        // Await runId if it's a promise to ensure proper flushing
        const resolvedRunId = await runId;

        const httpConfig = await getHttpConfig(config);
        httpConfig.headers.set('X-Stream-Done', 'true');
        const url = getStreamUrl(name, resolvedRunId, httpConfig);
        const response = await instrumentedFetch({
          method: 'PUT',
          url: url.toString(),
          headers: httpConfig.headers,
          dispatcher: getStreamDispatcher(config),
          timeoutMs: null,
          logLabel: url.pathname,
          buildError: async (res) =>
            createStreamRequestError('close', url, res, await res.text()),
        });
        // Drain the (empty) response so undici can release the pooled connection.
        await response.text();
      },

      async get(runId: string, name: string, startIndex?: number) {
        const httpConfig = await getHttpConfig(config);
        const url = getStreamUrl(name, runId, httpConfig);
        if (typeof startIndex === 'number') {
          url.searchParams.set('startIndex', String(startIndex));
        }
        // Live read: keep the global dispatcher and no request timeout so the
        // long-lived, reconnecting read isn't truncated.
        const response = await instrumentedFetch({
          method: 'GET',
          url: url.toString(),
          headers: httpConfig.headers,
          dispatcher: undefined,
          timeoutMs: null,
          logLabel: url.pathname,
          buildError: (res) =>
            new Error(`Failed to fetch stream: ${res.status}`),
        });
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

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
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
        const response = await instrumentedFetch({
          method: 'GET',
          url: url.toString(),
          headers: httpConfig.headers,
          dispatcher: undefined,
          timeoutMs: null,
          logLabel: url.pathname,
          buildError: (res) =>
            new Error(`Failed to list streams: ${res.status}`),
        });
        return (await response.json()) as string[];
      },
    },
  };
}
