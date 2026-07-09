import {
  envNumber,
  type GetChunksOptions,
  type StreamChunksResponse,
  type Streamer,
  type StreamInfoResponse,
} from '@workflow/world';
import { z } from 'zod';
import { getStreamDispatcher } from './http-client.js';
import { getVercelDiagnostics, instrumentedFetch } from './http-core.js';
import {
  WorkflowRunId,
  WorkflowStreamName,
  WorkflowStreamOperation,
  WorkflowStreamStartIndex,
} from './telemetry.js';
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

// Writes (PUT) and stream completion use the v2 stream endpoint.
function getStreamUrl(name: string, runId: string, httpConfig: HttpConfig) {
  return new URL(
    `${httpConfig.baseUrl}/v2/runs/${encodeURIComponent(runId)}/stream/${encodeURIComponent(name)}`
  );
}

// The live-read (GET) endpoint is versioned at v3: on a max-duration timeout
// (or a mid-stream connection drop) the server errors the response body
// instead of closing it cleanly, which is what lets the reconnecting reader
// (`createReconnectingFramedStream`) resume from the next chunk rather than
// treating the timeout as end-of-stream. Reading from v2 would silently
// truncate long-lived streams at the server's 2-minute limit. Only the live
// read is affected by the timeout — writes, completion, and snapshot reads
// (chunks/info/list) stay on v2.
function getStreamReadUrl(name: string, runId: string, httpConfig: HttpConfig) {
  return new URL(
    `${httpConfig.baseUrl}/v3/runs/${encodeURIComponent(runId)}/stream/${encodeURIComponent(name)}`
  );
}

/**
 * Stream-operation attributes layered onto the shared HTTP client span (see
 * instrumentedFetch). These make stream writes/reads sliceable by run, stream
 * name, and operation — beyond the generic `http PUT`/`http GET` verb — and
 * are no-ops when no OTEL SDK is registered (the span is undefined).
 */
function streamSpanAttributes(args: {
  runId: string;
  name: string;
  operation: 'write' | 'write_multi' | 'close' | 'read';
  startIndex?: number;
}): Record<string, string | number> {
  return {
    ...WorkflowRunId(args.runId),
    ...WorkflowStreamName(args.name),
    ...WorkflowStreamOperation(args.operation),
    ...(typeof args.startIndex === 'number'
      ? WorkflowStreamStartIndex(args.startIndex)
      : {}),
  };
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
          spanName: 'workflow.stream.write',
          durationAttribute: 'workflow.stream.write.chunk_rtt',
          attributes: streamSpanAttributes({
            runId: resolvedRunId,
            name,
            operation: 'write',
          }),
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
            spanName: 'workflow.stream.write',
            durationAttribute: 'workflow.stream.write.chunk_rtt',
            attributes: streamSpanAttributes({
              runId: resolvedRunId,
              name,
              operation: 'write_multi',
            }),
            buildError: async (res) =>
              createStreamRequestError('write', url, res, await res.text()),
          });
          // Drain so undici can release the pooled connection between pages.
          await response.text();
        }
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
          spanName: 'workflow.stream.write',
          durationAttribute: 'workflow.stream.write.chunk_rtt',
          attributes: streamSpanAttributes({
            runId: resolvedRunId,
            name,
            operation: 'close',
          }),
          buildError: async (res) =>
            createStreamRequestError('close', url, res, await res.text()),
        });
        // Drain the (empty) response so undici can release the pooled connection.
        await response.text();
      },

      async get(runId: string, name: string, startIndex?: number) {
        const httpConfig = await getHttpConfig(config);
        const url = getStreamReadUrl(name, runId, httpConfig);
        if (typeof startIndex === 'number') {
          url.searchParams.set('startIndex', String(startIndex));
        }
        // The `.connect` span covers dispatch → response headers (the
        // network-connect portion). The end-to-end time-to-first-chunk span
        // (`workflow.stream.read`) is emitted from the core reader
        // (`WorkflowServerReadableStream`) when the first chunk reaches the
        // consumer, so it includes deframing and doesn't need a wrapper here.
        // Live read: keep the global dispatcher and no request timeout so the
        // long-lived, reconnecting read isn't truncated.
        const response = await instrumentedFetch({
          method: 'GET',
          url: url.toString(),
          headers: httpConfig.headers,
          dispatcher: undefined,
          timeoutMs: null,
          logLabel: url.pathname,
          spanName: 'workflow.stream.read.connect',
          attributes: streamSpanAttributes({
            runId,
            name,
            operation: 'read',
            startIndex,
          }),
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
