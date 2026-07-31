import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { z } from 'zod';
import {
  getStreamCloseDispatcher,
  getStreamDispatcher,
} from './http-client.js';
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
const DEFAULT_STREAM_MUTATION_TIMEOUT_MS = 30_000;

// All stream requests share the instrumented envelope (`instrumentedFetch`):
// an OTEL client span, trace-context injection, `DEBUG` logging, and the
// x-vercel diagnostic headers — the same coverage the v3/v4 paths have.
//
// Stream writes (the PUT write/close path) go through the H2 stream
// dispatchers: they send a fully-buffered body (or none), so they benefit from
// H2 multiplexing without hitting the duplex issues that keep the long-lived
// live-read (GET) on the global dispatcher. The two mutations have different
// retry policies because they differ in idempotency:
//  - chunk appends are NOT idempotent, so getStreamDispatcher's policy (see
//    STREAM_RETRY_OPTIONS) retries only on transient connection errors and
//    HTTP 429 — both of which guarantee the chunk was never persisted — and
//    never on 5xx, so a retry can't duplicate an already-applied write.
//  - close IS idempotent, so getStreamCloseDispatcher's policy (see
//    STREAM_CLOSE_RETRY_OPTIONS) also retries 5xx; the server's close-barrier
//    protocol relies on that, surfacing transient reconciliation states as
//    retriable 503s with the stream left durably closing.
// Snapshot reads (chunks/info) go through makeRequest (default H1 dispatcher);
// the live-read (GET) and list keep the global dispatcher (no custom retry) and
// no request timeout — the live read is long-lived and a whole-request deadline
// would truncate it.

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

function getStreamMutationTimeoutMs() {
  const parsed = Number.parseInt(
    process.env.WORKFLOW_VERCEL_STREAM_TIMEOUT_MS ?? '',
    10
  );
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_STREAM_MUTATION_TIMEOUT_MS;
}

/**
 * Issue an instrumented stream mutation (a `write` or `close` PUT), throwing on
 * a non-2xx and draining the response body so undici can release the pooled
 * connection.
 *
 * The per-request deadline is handed to `instrumentedFetch`, which raises a
 * typed, retryable `WorkflowWorldError` on expiry instead of the opaque
 * `AbortError` that a bare `AbortSignal.timeout` surfaces.
 */
async function fetchStreamMutation(
  url: URL,
  init: { method: string; headers: Headers; body?: string | Uint8Array },
  operation: 'write' | 'close',
  config?: APIConfig
): Promise<void> {
  const response = await instrumentedFetch({
    method: init.method,
    url: url.toString(),
    headers: init.headers,
    body: init.body,
    // Stream mutations go through the dedicated H2 stream dispatchers rather
    // than the global agent — see the note at the top of this file. Close is
    // idempotent (unlike chunk appends), so it gets the dispatcher that
    // retries 5xx, which the server's close-barrier protocol depends on.
    dispatcher:
      operation === 'close'
        ? getStreamCloseDispatcher(config)
        : getStreamDispatcher(config),
    timeoutMs: getStreamMutationTimeoutMs(),
    logLabel: url.pathname,
    buildError: async (res) =>
      createStreamRequestError(operation, url, res, await res.text()),
  });
  // Drain the (empty) response so undici can release the pooled connection.
  await response.text();
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
      const url = getStreamUrl(name, resolvedRunId, httpConfig);
      await fetchStreamMutation(
        url,
        {
          method: 'PUT',
          body: chunk,
          headers: httpConfig.headers,
        },
        'write',
        config
      );
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
        const url = getStreamUrl(name, resolvedRunId, httpConfig);
        await fetchStreamMutation(
          url,
          {
            method: 'PUT',
            body,
            headers: httpConfig.headers,
          },
          'write',
          config
        );
      }
    },

    async closeStream(name: string, runId: string | Promise<string>) {
      // Await runId if it's a promise to ensure proper flushing
      const resolvedRunId = await runId;

      const httpConfig = await getHttpConfig(config);
      httpConfig.headers.set('X-Stream-Done', 'true');
      const url = getStreamUrl(name, resolvedRunId, httpConfig);
      await fetchStreamMutation(
        url,
        {
          method: 'PUT',
          headers: httpConfig.headers,
        },
        'close',
        config
      );
    },

    async readFromStream(name: string, startIndex?: number) {
      const httpConfig = await getHttpConfig(config);
      const url = getStreamUrl(name, undefined, httpConfig);
      if (typeof startIndex === 'number') {
        url.searchParams.set('startIndex', String(startIndex));
      }
      // Attach an AbortController so cancelling the returned stream
      // (from WorkflowServerReadableStream / getReadable consumers)
      // actually aborts the in-flight HTTP request instead of leaving
      // the socket hanging until the server times out.
      const abortController = new AbortController();
      // Live read: keep the global dispatcher and no request timeout so the
      // long-lived, reconnecting read isn't truncated.
      const response = await instrumentedFetch({
        method: 'GET',
        url: url.toString(),
        headers: httpConfig.headers,
        dispatcher: undefined,
        timeoutMs: null,
        signal: abortController.signal,
        logLabel: url.pathname,
        buildError: (res) => new Error(`Failed to fetch stream: ${res.status}`),
      });
      if (!response.body) {
        throw new Error('No response body for stream');
      }
      const upstream = response.body as ReadableStream<Uint8Array>;
      // Wrap the body so cancel() propagates to the AbortController —
      // fetch implementations differ on whether cancelling the body
      // alone tears down the socket.
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const reader = upstream.getReader();
          const pump = async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  return;
                }
                controller.enqueue(value);
              }
            } catch (err) {
              controller.error(err);
            }
          };
          pump();
        },
        cancel(reason) {
          abortController.abort(reason);
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
      const response = await instrumentedFetch({
        method: 'GET',
        url: url.toString(),
        headers: httpConfig.headers,
        dispatcher: undefined,
        timeoutMs: null,
        logLabel: url.pathname,
        buildError: (res) => new Error(`Failed to list streams: ${res.status}`),
      });
      return (await response.json()) as string[];
    },
  };
}
