import {
  EntityConflictError,
  PreconditionFailedError,
  RunExpiredError,
  StreamError,
  StreamExpiredError,
  ThrottleError,
  TooEarlyError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  envNumber,
  type GetChunksOptions,
  type StreamChunksResponse,
  type Streamer,
  type StreamInfoResponse,
} from '@workflow/world';
import { z } from 'zod';
import {
  getStreamCloseDispatcher,
  getStreamDispatcher,
} from './http-client.js';
import {
  errorForResponse,
  getVercelDiagnostics,
  instrumentedFetch,
} from './http-core.js';
import { encodeMultiChunks } from './stream-chunks.js';
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
 * `WORKFLOW_MAX_CHUNKS_PER_REQUEST`. Lower it (paired with the server's
 * `MAX_CHUNKS_PER_BATCH` override) to exercise the batch-splitting path.
 */
const getMaxChunksPerRequest = (): number =>
  envNumber('WORKFLOW_MAX_CHUNKS_PER_REQUEST', MAX_CHUNKS_PER_REQUEST, {
    integer: true,
    min: 1,
  });

// All stream requests share the instrumented envelope (`instrumentedFetch`):
// an OTEL client span, trace-context injection, `DEBUG` logging, and the
// x-vercel diagnostic headers, which provide the same coverage the v3/v4 paths
// have.
//
// Writes (the PUT write/close path) go through the H2 stream dispatcher (see
// getStreamDispatcher): they send a fully-buffered body (or none), so they
// benefit from H2 multiplexing without hitting the duplex issues that keep the
// long-lived live-read (GET) on the global dispatcher. Because stream appends
// aren't idempotent, that stream dispatcher uses a deliberately narrowed retry
// policy (see STREAM_RETRY_OPTIONS): it retries only on transient connection
// errors and HTTP 429 (both of which guarantee the chunk was never persisted)
// and never on 5xx, so a retry can't duplicate an already-applied write.
// Snapshot reads (chunks/info) go through makeRequest (default H1 dispatcher);
// the live-read (GET) and list keep the global dispatcher (no custom retry) and
// no request timeout. The live read is long-lived and a whole-request deadline
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
// read is affected by the timeout. Writes, completion, and snapshot reads
// (chunks/info/list) stay on v2.
function getStreamReadUrl(name: string, runId: string, httpConfig: HttpConfig) {
  return new URL(
    `${httpConfig.baseUrl}/v3/runs/${encodeURIComponent(runId)}/stream/${encodeURIComponent(name)}`
  );
}

/**
 * Stream-operation attributes layered onto the shared HTTP client span (see
 * instrumentedFetch). These make stream writes/reads sliceable by run, stream
 * name, and operation (beyond the generic `http PUT`/`http GET` verb) and
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

async function createStreamReadError(response: Response): Promise<Error> {
  const fallback = `Failed to fetch stream: ${response.status}`;
  if (response.status !== 410) {
    return new StreamError(fallback, { status: response.status });
  }

  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
      details?: unknown;
    };
    return errorForResponse(
      response.status,
      typeof body.message === 'string' ? body.message : fallback,
      { code: body.error, details: body.details }
    );
  } catch {
    return new StreamError(fallback, { status: response.status });
  }
}

function toStreamError(message: string, cause: unknown): Error {
  if (
    WorkflowWorldError.is(cause) ||
    EntityConflictError.is(cause) ||
    RunExpiredError.is(cause) ||
    StreamError.is(cause) ||
    StreamExpiredError.is(cause) ||
    TooEarlyError.is(cause) ||
    ThrottleError.is(cause) ||
    PreconditionFailedError.is(cause)
  ) {
    return cause;
  }
  return new StreamError(message, { cause });
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

  return new StreamError(
    `Stream ${operation} failed: HTTP ${response.status} (${context.join('; ')}): ${text}`,
    { url: url.toString(), status: response.status }
  );
}

export { encodeMultiChunks } from './stream-chunks.js';

const StreamInfoResponseSchema = z.object({
  tailIndex: z.number(),
  done: z.boolean(),
});

/**
 * Zod schema for the paginated stream chunks response from the server.
 * When using CBOR (the default for makeRequest), chunk data arrives as
 * native Uint8Array byte strings, so no base64 decoding is required.
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
          transportErrorCode: 'STREAM_ERROR',
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
        // Note: for batches spanning multiple pages, atomicity is relaxed.
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
            transportErrorCode: 'STREAM_ERROR',
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
          // Close is idempotent (unlike chunk appends), so its dispatcher
          // retries 5xx, as required by the server's close-barrier protocol,
          // which surfaces transient reconciliation states as retriable
          // 503s with the stream left durably closing.
          dispatcher: getStreamCloseDispatcher(config),
          timeoutMs: null,
          transportErrorCode: 'STREAM_ERROR',
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
        // Stream bytes themselves are untyped binary, but any pre-header error
        // is a JSON envelope. Asking explicitly avoids a CBOR 410 that this
        // binary response path cannot decode while leaving successful stream
        // bodies unchanged.
        httpConfig.headers.set('Accept', 'application/json');
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
          transportErrorCode: 'STREAM_ERROR',
          logLabel: url.pathname,
          spanName: 'workflow.stream.read.connect',
          attributes: streamSpanAttributes({
            runId,
            name,
            operation: 'read',
            startIndex,
          }),
          buildError: createStreamReadError,
        });
        if (!response.body) {
          throw new StreamError('No response body for stream', {
            url: url.toString(),
          });
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
        try {
          return await makeRequest({
            endpoint,
            config,
            schema: StreamChunksResponseSchema,
          });
        } catch (cause) {
          throw toStreamError(
            `Failed to read stream chunks for ${name}`,
            cause
          );
        }
      },

      async getInfo(runId: string, name: string): Promise<StreamInfoResponse> {
        const endpoint = `/v2/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(name)}/info`;
        try {
          return await makeRequest({
            endpoint,
            config,
            schema: StreamInfoResponseSchema,
          });
        } catch (cause) {
          throw toStreamError(`Failed to read stream info for ${name}`, cause);
        }
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
          transportErrorCode: 'STREAM_ERROR',
          logLabel: url.pathname,
          buildError: (res) =>
            new StreamError(`Failed to list streams: ${res.status}`, {
              url: url.toString(),
              status: res.status,
            }),
        });
        try {
          return (await response.json()) as string[];
        } catch (cause) {
          throw toStreamError('Failed to parse stream list response', cause);
        }
      },
    },
  };
}
