/**
 * v4 event endpoints — fully framed wire protocol.
 *
 * Both directions use the same length-prefixed binary frame layout:
 *
 *   frame := [u32_be meta_len][cbor_meta][u32_be body_len][body_bytes]
 *
 * - **POST**: request body is one frame. `cbor_meta` carries structured
 *   event metadata (eventType, specVersion, deploymentId, workflowName,
 *   …, executionContext); `body_bytes` is the opaque user payload that
 *   the server stores without ever decoding it.
 * - **GET single event**: response body is one frame.
 * - **LIST events**: response body is a stream of frames terminated by a
 *   sentinel frame (meta = `{_end: 1, next?: cursor, hasMore?: boolean}`).
 *
 * Requests carry special HTTP response headers (eventId / runId / createdAt)
 * for client convenience, to allow metadata access without decoding the body.
 *
 * Higher-level callers (the world-vercel adapter) CBOR-encode their JS
 * values into the `payload` parameter and CBOR-decode returned `body`
 * bytes — this module stays at the wire-bytes layer.
 */

import { decode } from 'cbor-x';
import { decodeFrames, encodeFrame, V4_FRAME_CONTENT_TYPE } from './frames.js';
import { getEventsDispatcher } from './http-client.js';
import {
  errorForResponse,
  instrumentedFetch,
  parseRetryAfter,
} from './http-core.js';
import { type APIConfig, getHttpConfig } from './utils.js';

/**
 * Issue an instrumented v4 request through the global `fetch` — NOT undici's
 * `request`.
 *
 * Vercel's observability "outgoing requests" view instruments the global
 * `fetch`. Calling `undici.request()` directly bypasses that instrumentation,
 * so v4 event traffic disappeared from the log viewer while queue traffic
 * (which uses `fetch`) kept showing. `instrumentedFetch` routes through the
 * global `fetch` with the custom dispatcher, restoring visibility while also
 * opening the OTEL client span, injecting trace context, setting the
 * cache-bust header (see #618), and emitting `DEBUG` logs — the same envelope
 * the v3 `makeRequest` path has always had.
 *
 * The events API uses its own HTTP/2-enabled dispatcher
 * (`getEventsDispatcher`): these reads/writes are plain request/response (or a
 * streamed LIST response) and benefit from multiplexing. The default dispatcher
 * stays on HTTP/1.1 because H2 deadlocks the queue's webhook respondWith
 * mechanism — see http-client.ts.
 *
 * No per-request timeout: a LIST response streams the full event-log page, which
 * for a large run can legitimately take a while to drain — a whole-request
 * deadline would abort it mid-stream.
 */
async function fetchV4(
  url: string,
  init: { method: string; headers: Headers; body?: Uint8Array },
  config: APIConfig | undefined,
  opName: string
): Promise<Response> {
  return instrumentedFetch({
    method: init.method,
    url,
    headers: init.headers,
    body: init.body,
    dispatcher: getEventsDispatcher(config),
    timeoutMs: null,
    logLabel: opName,
    buildError: async (response) =>
      errorFromV4Response(
        response.status,
        headersToRecord(response.headers),
        await response.text(),
        opName,
        url
      ),
  });
}

/** Flatten a fetch `Headers` into the record shape throwForErrorResponse
 *  expects (it mirrors the v3 `makeRequest` error contract). */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * POST surfaces these so callers can read the created eventId without
 * decoding the CBOR response body
 */
export const V4_RESPONSE_HEADERS = {
  eventId: 'x-wf-event-id',
  runId: 'x-wf-run-id',
  createdAt: 'x-wf-created-at',
} as const;

export interface CreateEventV4Input {
  // runId is required even for run_created, because the payload is keyed under the runId
  runId: string;
  eventType: string;
  /** Opaque payload bytes. Pass undefined for events that don't carry
   *  user data (e.g. step_started). */
  payload?: Uint8Array;
  specVersion: number;
  correlationId?: string;
  vercelId?: string;
  /** Client-side time at which the event occurred. */
  occurredAt?: Date;
  remoteRefBehavior?: 'resolve' | 'lazy';
  deploymentId?: string;
  workflowName?: string;
  stepName?: string;
  attempt?: number;
  /** cbor-x encodes Date as CBOR tag 1 (epoch) and the server decodes it
   *  back to a Date — the round-trip is symmetric, so wait_created /
   *  step_retrying / etc. see a Date in eventData.resumeAt on the read
   *  side. */
  resumeAt?: Date;
  /** step_retrying's custom backoff timestamp (RetryableError.retryAfter).
   *  The queue enforces the actual delay, but the backend persists this on
   *  the step entity for premature-delivery pacing and observability. */
  retryAfter?: Date;
  hookToken?: string;
  hookIsWebhook?: boolean;
  hookIsSystem?: boolean;
  errorCode?: string;
  /** run_cancelled's optional free-text cancellation reason. Small plaintext
   *  metadata, capped at 512 chars by the @workflow/world schema. */
  cancelReason?: string;
  /** Arbitrary structured map; rides as a native CBOR object in the
   *  frame meta. Bounded by the server at 2 KB encoded. */
  executionContext?: Record<string, unknown>;
  /** Initial run attributes (run_created, and run_started on the
   *  resilient-start path). Validated server-side against the attribute
   *  key/value/count caps. */
  attributes?: Record<string, string>;
  /** attr_set's attribute change list ({key, value|null} entries). */
  changes?: Array<Record<string, unknown>>;
  /** attr_set's writer provenance ({type:'workflow'} or
   *  {type:'step', stepId, attempt}). */
  writer?: Record<string, unknown>;
  /** Opt-in for framework-level callers to write `$`-prefixed reserved
   *  attribute keys (attr_set / run_created / run_started). */
  allowReservedAttributes?: boolean;
  /** Client-measured time-to-first-step ms, riding on the run's first
   *  step_completed / step_failed. Consumed server-side for latency
   *  metrics; not read back. */
  ttfs?: number;
  /** Client-measured step-to-step overhead ms (previous step's terminal
   *  event → this step's body starting), riding on step_completed /
   *  step_failed. Consumed server-side for latency metrics. */
  stso?: number;
  /** Progress counters taken when the STSO gap began. */
  stepCount?: number;
  eventCount?: number;
  /** Runtime optimizations active for the ttfs/stso measurement
   *  (e.g. 'turbo', 'lazyStepStart', 'optimisticStart'). */
  optimizations?: string[];
  /** Opt-in inline-delta request. On a step-terminal write
   *  (step_completed / step_failed) the inline loop passes the cursor it
   *  held before the write so the server can return the authoritative
   *  event-log delta on the response `events`/`cursor`/`hasMore`, letting
   *  the runtime skip a follow-up events.list. Ignored by the server for
   *  other event types; older servers ignore it entirely (the runtime then
   *  falls back to events.list). */
  sinceCursor?: string;
  /** Run-started preload opt-out. Turbo backgrounds run_started as a write
   *  barrier only and never reads the preloaded log, so it asks the server to
   *  skip the list+resolve. Acted on by the server only for run_started;
   *  older servers ignore it and preload as before. */
  skipPreload?: boolean;
}

export interface CreateEventV4Result {
  eventId: string;
  runId: string;
  createdAt: string;
  /**
   * Materialized-entity bag — CBOR-decoded from the response body. The
   * server hands back the same shape v2/v3 use for EventResult so the
   * adapter layer can drop these fields into its return value unchanged.
   * Keys are unset when the event type doesn't materialize that entity
   * kind.
   */
  body: {
    event?: unknown;
    run?: unknown;
    step?: unknown;
    hook?: unknown;
    wait?: unknown;
    events?: unknown[];
    cursor?: string | null;
    hasMore?: boolean;
    /**
     * Lazy step start: true when the server's step_started created the step
     * on this call. Absent from older servers (safe default: not the lazy
     * creator). Threaded into EventResult.stepCreated by the events adapter.
     */
    stepCreated?: boolean;
  };
}

/** Build the CBOR meta map for a v4 POST frame. Drops undefined entries
 *  so the wire shape matches what the server expects to see. */
function buildPostFrameMeta(
  input: CreateEventV4Input
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    eventType: input.eventType,
    specVersion: input.specVersion,
  };
  if (input.correlationId !== undefined)
    meta.correlationId = input.correlationId;
  if (input.vercelId !== undefined) meta.vercelId = input.vercelId;
  if (input.occurredAt !== undefined) meta.occurredAt = input.occurredAt;
  if (input.remoteRefBehavior !== undefined) {
    meta.remoteRefBehavior = input.remoteRefBehavior;
  }
  if (input.deploymentId !== undefined) meta.deploymentId = input.deploymentId;
  if (input.workflowName !== undefined) meta.workflowName = input.workflowName;
  if (input.stepName !== undefined) meta.stepName = input.stepName;
  if (input.attempt !== undefined) meta.attempt = input.attempt;
  if (input.resumeAt !== undefined) meta.resumeAt = input.resumeAt;
  if (input.retryAfter !== undefined) meta.retryAfter = input.retryAfter;
  if (input.hookToken !== undefined) meta.hookToken = input.hookToken;
  if (input.hookIsWebhook !== undefined)
    meta.hookIsWebhook = input.hookIsWebhook;
  if (input.hookIsSystem !== undefined) meta.hookIsSystem = input.hookIsSystem;
  if (input.errorCode !== undefined) meta.errorCode = input.errorCode;
  if (input.cancelReason !== undefined) meta.cancelReason = input.cancelReason;
  if (input.executionContext !== undefined) {
    meta.executionContext = input.executionContext;
  }
  if (input.attributes !== undefined) meta.attributes = input.attributes;
  if (input.changes !== undefined) meta.changes = input.changes;
  if (input.writer !== undefined) meta.writer = input.writer;
  if (input.allowReservedAttributes !== undefined) {
    meta.allowReservedAttributes = input.allowReservedAttributes;
  }
  if (input.ttfs !== undefined) meta.ttfs = input.ttfs;
  if (input.stso !== undefined) meta.stso = input.stso;
  if (input.stepCount !== undefined) meta.stepCount = input.stepCount;
  if (input.eventCount !== undefined) meta.eventCount = input.eventCount;
  if (input.optimizations !== undefined) {
    meta.optimizations = input.optimizations;
  }
  if (input.sinceCursor !== undefined) meta.sinceCursor = input.sinceCursor;
  if (input.skipPreload !== undefined) meta.skipPreload = input.skipPreload;
  return meta;
}

/**
 * Build the typed error for a non-2xx v4 response. Reuses the shared
 * `errorForResponse` status → error-type contract (409→EntityConflictError,
 * 410→RunExpiredError, 425→TooEarlyError, 429→ThrottleError, else
 * →WorkflowWorldError) so v3 and v4 stay in lockstep — only the message
 * *string* is v4-specific (`v4 {opName} failed: HTTP …`, which the runtime and
 * log tooling key on; the hook 404 → HookNotFoundError translation in events.ts
 * keys off status === 404).
 */
function errorFromV4Response(
  statusCode: number,
  responseHeaders: Record<string, string | string[] | undefined>,
  errorBody: string,
  opName: string,
  url: string
): Error {
  let message = `v4 ${opName} failed: HTTP ${statusCode}`;
  let code: string | undefined;
  try {
    const json = JSON.parse(errorBody) as { message?: string; code?: string };
    if (typeof json.message === 'string') message = json.message;
    if (typeof json.code === 'string') code = json.code;
  } catch {
    // body wasn't JSON — keep the default message, append raw text below
    if (errorBody) message += ` ${errorBody}`;
  }

  const retryAfter = parseRetryAfter(
    readHeader(responseHeaders, 'retry-after')
  );
  // A firewall-challenge 429 is routed to the retryable transport path (not
  // ThrottleError) so step_started writes back off + cap rather than looping.
  return errorForResponse(statusCode, message, {
    retryAfter,
    code,
    url,
    mitigated: readHeader(responseHeaders, 'x-vercel-mitigated'),
  });
}

/**
 * Throwing wrapper around `errorFromV4Response`. Exported for unit tests; the
 * request paths throw via `instrumentedFetch`'s `buildError`.
 */
export function throwForErrorResponse(
  statusCode: number,
  responseHeaders: Record<string, string | string[] | undefined>,
  errorBody: string,
  opName: string,
  url: string
): never {
  throw errorFromV4Response(
    statusCode,
    responseHeaders,
    errorBody,
    opName,
    url
  );
}

/**
 * POST /api/v4/runs/:runId/events/:eventType
 *
 * Sends the full request as a single v4 frame and returns the event ids
 * + materialized-entity bag from the CBOR response body. Throws on
 * non-2xx.
 *
 * The trailing `:eventType` path segment is an alias of the canonical
 * `/events` route: it exists purely so the event type is visible in
 * access logs / traces / route metrics without decoding the frame body.
 * The frame meta's `eventType` remains authoritative — the backend
 * cross-checks the two and logs (but does not reject) a mismatch.
 */
export async function createWorkflowRunEventV4(
  input: CreateEventV4Input,
  config?: APIConfig
): Promise<CreateEventV4Result> {
  // getHttpConfig sets the Authorization header (explicit config.token or
  // per-request OIDC fallback) — same contract as the v3 makeRequest path.
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/octet-stream');

  const frame = encodeFrame(
    buildPostFrameMeta(input),
    input.payload ?? new Uint8Array(0)
  );

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(input.runId)}/events/${encodeURIComponent(input.eventType)}`;
  const response = await fetchV4(
    url,
    { method: 'POST', headers, body: frame },
    config,
    'createEvent'
  );

  const eventId = response.headers.get(V4_RESPONSE_HEADERS.eventId);
  const runId = response.headers.get(V4_RESPONSE_HEADERS.runId);
  const createdAt = response.headers.get(V4_RESPONSE_HEADERS.createdAt);
  if (
    typeof eventId !== 'string' ||
    typeof runId !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('v4 createEvent: response missing required x-wf-* headers');
  }

  // Decode the materialized-entity bag from the CBOR response body.
  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const body =
    bodyBytes.byteLength > 0
      ? (decode(bodyBytes) as CreateEventV4Result['body'])
      : {};

  return { eventId, runId, createdAt, body };
}

/**
 * Decoded event entity returned by GET /api/v4/runs/:runId/events/:eventId.
 * The server CBOR-encodes the full entity with refs resolved server-side,
 * so the payload field (input/output/result/error/payload/metadata
 * depending on eventType) already contains the resolved bytes — the
 * adapter layer doesn't need to splice them in.
 */
export interface DecodedV4Event {
  eventId: string;
  runId: string;
  eventType: string;
  correlationId?: string;
  createdAt: Date | string;
  occurredAt?: Date | string;
  specVersion?: number;
  eventData?: Record<string, unknown>;
}

function readHeader(
  responseHeaders: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = responseHeaders[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

/**
 * GET /api/v4/runs/:runId/events/:eventId
 *
 * Returns one v4 frame: the full event entity (CBOR-decoded from the
 * frame meta) plus the resolved payload bytes (frame body, possibly
 * empty). The wire format is identical to a single LIST frame so the
 * server can stream the payload back without buffering — callers
 * are responsible for splicing `body` into `event.eventData[payloadField]`
 * when they need the resolved value. The world-vercel adapter does this
 * in events.ts.
 */
export async function getEventV4(
  runId: string,
  eventId: string,
  config?: APIConfig
): Promise<{ event: DecodedV4Event; body: Uint8Array }> {
  const { baseUrl, headers } = await getHttpConfig(config);

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventId)}`;
  const response = await fetchV4(
    url,
    { method: 'GET', headers },
    config,
    'getEvent'
  );
  const contentType = response.headers.get('content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 getEvent: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
    );
  }

  // fetch's `Response.body` is a web ReadableStream, which is async-iterable
  // on Node (readableStream async iteration, since v16.5.0) — feed it straight
  // to decodeFrames. The cast is only because TS's lib `ReadableStream` type
  // omits the async iterator. Do NOT round-trip through `node:stream`
  // Readable.toWeb: a dynamic `import('node:stream')` resolves to an empty
  // module namespace in Next.js webpack server bundles and crashes.
  const chunks = response.body as unknown as AsyncIterable<Uint8Array>;

  // GET emits a single frame (no sentinel); decodeFrames returns at EOF
  // after yielding it.
  for await (const frame of decodeFrames(chunks)) {
    return { event: frame.meta as unknown as DecodedV4Event, body: frame.body };
  }
  throw new Error(`v4 getEvent: empty frame stream for ${eventId}`);
}

export interface ListEventsV4Params {
  cursor?: string;
  limit?: number;
  sortOrder?: 'asc' | 'desc';
  /**
   * Whether the backend resolves payload bytes into each frame body.
   * `resolve` (default) streams the bytes; `lazy` emits empty-body frames
   * (the ref descriptor stays in the frame meta) — for metadata-only
   * listings that would otherwise download every payload just to discard
   * it. A backend that predates this flag ignores it and streams full
   * bodies, so callers must still tolerate bodies being present.
   */
  remoteRefBehavior?: 'resolve' | 'lazy';
}

/**
 * A single event extracted from a v4 LIST frame. Mirrors `DecodedV4Event`
 * but also carries the raw payload bytes — for payload-bearing events the
 * server emits the resolved bytes in the frame body (so it never has to
 * decode them) and the SDK is expected to splice them back into the
 * appropriate `eventData` field.
 */
export interface ListedEventV4 {
  event: DecodedV4Event;
  /** Resolved payload bytes. Empty for events without a payload. */
  body: Uint8Array;
}

export interface ListEventsV4Result {
  events: ListedEventV4[];
  /**
   * Trailing cursor. Present even on the final page — it doubles as the
   * resume point for incremental loads — so it is NOT a reliable "more
   * pages" signal on its own. Use `hasMore` for that.
   */
  next?: string;
  /**
   * Explicit "another page of results exists" flag from the sentinel.
   * `undefined` against older servers that don't emit it, in which case
   * the caller falls back to `Boolean(next)`.
   */
  hasMore?: boolean;
}

/**
 * Drive a v4 frame-stream list response into an in-memory page. Used by
 * both the by-runId and by-correlationId list endpoints — the wire
 * shape is identical, only the URL differs.
 *
 * `headers` come from the caller's single getHttpConfig resolution (the
 * same call that produced the baseUrl in `url`) so each LIST resolves
 * auth exactly once.
 */
async function consumeListFrameStream(
  url: string,
  headers: Headers,
  config: APIConfig | undefined,
  opName: string
): Promise<ListEventsV4Result> {
  const response = await fetchV4(
    url,
    { method: 'GET', headers },
    config,
    opName
  );
  const contentType = response.headers.get('content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 ${opName}: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
    );
  }

  // See getEventV4: fetch's web ReadableStream is async-iterable on Node; the
  // cast only works around TS's lib type omitting the async iterator.
  const chunks = response.body as unknown as AsyncIterable<Uint8Array>;

  const events: ListedEventV4[] = [];
  let next: string | undefined;
  let hasMore: boolean | undefined;
  let sawEndSentinel = false;
  for await (const frame of decodeFrames(chunks)) {
    if (frame.meta._end === 1) {
      if (typeof frame.meta.next === 'string') next = frame.meta.next;
      if (typeof frame.meta.hasMore === 'boolean') hasMore = frame.meta.hasMore;
      sawEndSentinel = true;
      break;
    }
    events.push({
      event: frame.meta as unknown as DecodedV4Event,
      body: frame.body,
    });
  }

  // A LIST response always ends with the `{_end: 1}` sentinel frame. EOF
  // without it means the response was truncated — and if the cut landed
  // between two complete frames, decodeFrames alone can't tell. Returning
  // the partial page here would surface as `hasMore: false` and silently
  // drop events (replay correctness!), so fail loudly instead; the read
  // is idempotent and safe for the caller to retry.
  if (!sawEndSentinel) {
    throw new Error(
      `v4 ${opName}: frame stream ended without the end-of-stream sentinel ` +
        `(${events.length} events read) — truncated response?`
    );
  }

  return {
    events,
    ...(next ? { next } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
  };
}

/**
 * Append the shared list params (pagination + ref behavior) to `sp`.
 * Shared by the runId and correlationId list query builders so both send
 * `remoteRefBehavior` identically.
 */
function appendListParams(sp: URLSearchParams, params: ListEventsV4Params) {
  if (params.cursor) sp.set('cursor', params.cursor);
  if (params.limit !== undefined) sp.set('limit', String(params.limit));
  if (params.sortOrder) sp.set('sortOrder', params.sortOrder);
  if (params.remoteRefBehavior) {
    sp.set('remoteRefBehavior', params.remoteRefBehavior);
  }
}

function paginationToQuery(params: ListEventsV4Params): string {
  const sp = new URLSearchParams();
  appendListParams(sp, params);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * GET /api/v4/runs/:runId/events
 *
 * Parses the binary-frame stream into a list of events plus the
 * pagination cursor (from the sentinel frame). Each frame's CBOR meta
 * IS the full event entity, with the payload field still in `eventData`
 * as a `RefDescriptor` (lazy); the resolved payload bytes ride in the
 * frame body. The adapter layer splices them back into eventData.
 *
 * Eagerly drains the stream into memory to match the existing
 * `getWorkflowRunEvents` page-at-a-time contract. A streaming variant
 * that yields events one at a time without buffering the page would be
 * a small refactor (decodeFrames is already async-iterable).
 */
export async function getWorkflowRunEventsV4(
  runId: string,
  params: ListEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl, headers } = await getHttpConfig(config);
  const url =
    `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events` +
    paginationToQuery(params);
  return consumeListFrameStream(url, headers, config, 'listEvents');
}

/**
 * GET /api/v4/events?correlationId=...
 *
 * Same frame stream as getWorkflowRunEventsV4 but selected by
 * correlationId (GSI) instead of runId. Used by the storage adapter's
 * `events.listByCorrelationId` path — the v3 client used
 * `/v2/events?correlationId=...` for the equivalent query.
 */
export async function getEventsByCorrelationIdV4(
  correlationId: string,
  params: ListEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl, headers } = await getHttpConfig(config);
  const sp = new URLSearchParams();
  sp.set('correlationId', correlationId);
  appendListParams(sp, params);
  const url = `${baseUrl}/v4/events?${sp.toString()}`;
  return consumeListFrameStream(
    url,
    headers,
    config,
    'listEventsByCorrelationId'
  );
}
