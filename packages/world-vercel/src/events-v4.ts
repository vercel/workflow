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
 *   sentinel frame (meta = `{_end: 1, next?: cursor, hasMore: boolean}`).
 *
 * Requests carry special HTTP response headers (eventId / runId / createdAt)
 * for client convenience, to allow metadata access without decoding the body.
 *
 * Higher-level callers (the world-vercel adapter) CBOR-encode their JS
 * values into the `payload` parameter and CBOR-decode returned `body`
 * bytes — this module stays at the wire-bytes layer.
 */

import assert from 'node:assert/strict';
import { WorkflowWorldError } from '@workflow/errors';
import {
  type Event,
  type EventResult,
  EventSchema,
  type EventType,
  EventTypeSchema,
  getEventDataPayloadField,
  HookSchema,
  type ListEventsParams,
  type PaginationOptions,
  StructuredErrorSchema,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import { decode } from 'cbor-x';
import { z } from 'zod';
import {
  type DecodedFrame,
  decodeFrames,
  encodeFrame,
  V4_FRAME_CONTENT_TYPE,
} from './frames.js';
import {
  getEventsDispatcher,
  noteEventsTransportOutcome,
} from './http-client.js';
import {
  errorForResponse,
  instrumentedFetch,
  parseRetryAfter,
} from './http-core.js';
import { hasSerializedDataFormatPrefix } from './serialized-data.js';
import { deserializeStep, StepWireSchema } from './steps.js';
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
  const dispatcher = getEventsDispatcher(config);
  return instrumentedFetch({
    method: init.method,
    url,
    headers: init.headers,
    body: init.body,
    dispatcher,
    // Repeated transport failures retire the shared events pool and the next
    // request builds a fresh one. undici keeps a black-holed HTTP/2 session in
    // service indefinitely, so without this every request routed onto it fails
    // until the compute instance is recycled — see noteEventsTransportOutcome.
    onTransportOutcome: (error) =>
      noteEventsTransportOutcome(dispatcher, error),
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

const EVENT_ID_HEADER = 'x-wf-event-id';
const MAX_EVENTS_HEADER = 'x-wf-max-events';

interface CreateEventV4InputBase {
  // runId is required even for run_created, because the payload is keyed under the runId
  runId: string;
  /** Opaque payload bytes. Pass undefined for events that don't carry
   *  user data (e.g. step_started). */
  payload?: Uint8Array;
  specVersion: number;
  correlationId?: string;
  vercelId?: string;
  /** Compute instance that wrote this event; rides the frame meta by `vercelId`. */
  computeInstanceId?: string;
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
  /**
   * Earliest time another Hook can use the token after the owning run ends.
   * An active run always retains its token beyond this time.
   */
  hookTokenRetentionUntil?: Date;
  hookIsWebhook?: boolean;
  hookIsSystem?: boolean;
  /** Lazy hook resume idempotency key. Set only on a `hook_received` written
   *  by `resumeHook()`'s parallel fast path; routes the event through the
   *  server's `(runId, resumeId)` constraint so the direct write and the
   *  queue consumer's re-ensure converge on one event. Older servers ignore
   *  it (the deduplication then falls to the sequential path). */
  resumeId?: string;
  errorCode?: string;
  /** run_cancelled's optional free-text cancellation reason. Small plaintext
   *  metadata, capped at 512 chars by the @workflow/world schema. */
  cancelReason?: string;
  /** step_started's inline-ownership stamp: the queue message ID of the
   *  invocation running this step's body inline. Persisted on the event row
   *  so wake replays can observe the active owner. */
  ownerMessageId?: string;
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
  /** The run's X25519 public key, base64 (run_created / resilient-start
   *  run_started). Plaintext metadata, not a payload: the server stores it on
   *  the run entity so cross-run writers can seal to it without holding the
   *  run's symmetric key. */
  encryptionPublicKey?: string;
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
  /** Client-measured run_started-to-first-step ms (the `run_started`
   *  response landing → this step's start POST being issued), riding on the
   *  run's first step_completed / step_failed. Consumed server-side for
   *  latency metrics. */
  rsfs?: number;
  /** Client-measured synchronous replay-compute ms of only the FINAL replay
   *  pass within the rsfs window (the pass that scheduled the first step),
   *  excluding awaited network I/O — not accumulated across earlier
   *  pre-first-step passes, so it is not "the replay portion of rsfs".
   *  Only present alongside rsfs, and only for the run's first step. */
  finalSchedulingReplay?: number;
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
  /**
   * Epoch ms (the ULID time of the latest event the runtime has loaded
   * during replay). Sent by replay-context creates so the backend can
   * reject the event when a newer out-of-band event was recorded after this
   * snapshot, enabling an optimistic-concurrency guard. Omitted by callers
   * without a loaded event log; older servers ignore it entirely.
   */
  stateUpdatedAt?: number;
  /**
   * Number of loaded events at or below `stateUpdatedAt` (i.e. the loaded
   * log's length). Sent with `stateUpdatedAt` so the backend can also reject
   * a snapshot that is *missing* an event at or below its watermark — the
   * corruption case a watermark alone cannot detect. Older servers ignore it.
   */
  stateEventCount?: number;
  /**
   * The runtime's event-log cursor at snapshot time. Advisory: sent so a
   * rejecting backend MAY return the missing events on the 412 body, saving a
   * follow-up events.list. Distinct from `sinceCursor`, which the server acts
   * on for the *accepted* path.
   */
  stateCursor?: string;
  /** Number of consecutive replay divergences resolved by this write. */
  replayDivergenceCount?: number;
  /** Content digest of the serialized resume payload. Forwarded alongside
   *  `resumeId` so the direct write and the queue re-ensure record an identical
   *  digest on the server's `(runId, resumeId)` constraint (the v4 payload ref
   *  is not content-stable server-side). Older servers ignore it. */
  resumePayloadDigest?: string;
}

export type CreateEventV4Input = CreateEventV4InputBase &
  (
    | { eventType: Exclude<EventType, 'run_started'> }
    | { eventType: 'run_started'; skipPreload: true }
  );

/**
 * Shape the v4 client attaches to `PreconditionFailedError.details` when a
 * rejecting server returned the missing events inline. `@workflow/errors`
 * types `details` as `unknown` (it cannot depend on the event type), so
 * consumers narrow structurally — this interface is the contract they narrow
 * to.
 */
export interface PreconditionFailureDetails {
  /** The events the client's snapshot was missing, in server order. */
  events: Event[];
  /** Cursor positioned after the returned events, when the server sent one. */
  cursor?: string;
}

const CreateEventV4BodyBaseSchema = z.object({
  event: EventSchema,
  run: WorkflowRunSchema.optional(),
  step: StepWireSchema.transform(deserializeStep).optional(),
  hook: HookSchema.optional(),
  wait: WaitSchema.optional(),
  stepCreated: z.literal(true).optional(),
  maxEvents: z.number().int().positive().optional(),
});

const CreateEventV4PageSchema = z.union([
  z.object({
    events: z.array(EventSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
  z.object({
    events: z.undefined(),
    cursor: z.undefined(),
    hasMore: z.undefined(),
  }),
]);

const CreateEventV4BodySchema = CreateEventV4BodyBaseSchema.and(
  CreateEventV4PageSchema
);

const CreateEventV4BodySchemas: {
  [T in EventType]: z.ZodType<EventResult<T> & { event: Event }>;
} = {
  run_created: CreateEventV4BodyBaseSchema.extend({
    run: WorkflowRunSchema,
  }).and(CreateEventV4PageSchema),
  run_started: CreateEventV4BodyBaseSchema.extend({
    run: WorkflowRunSchema.and(z.object({ startedAt: z.coerce.date() })),
  }).and(CreateEventV4PageSchema),
  step_started: CreateEventV4BodyBaseSchema.extend({
    step: StepWireSchema.extend({
      startedAt: z.coerce.date(),
    }).transform((step) => ({
      ...deserializeStep(step),
      startedAt: step.startedAt,
    })),
  }).and(CreateEventV4PageSchema),
  run_completed: CreateEventV4BodySchema,
  run_failed: CreateEventV4BodySchema,
  run_cancelled: CreateEventV4BodySchema,
  attr_set: CreateEventV4BodySchema,
  step_created: CreateEventV4BodySchema,
  step_completed: CreateEventV4BodySchema,
  step_failed: CreateEventV4BodySchema,
  step_retrying: CreateEventV4BodySchema,
  hook_created: CreateEventV4BodySchema,
  hook_received: CreateEventV4BodySchema,
  hook_disposed: CreateEventV4BodySchema,
  hook_conflict: CreateEventV4BodySchema,
  wait_created: CreateEventV4BodySchema,
  wait_completed: CreateEventV4BodySchema,
};

const MaxEventsHeaderSchema = z.coerce.number().int().positive();
const EventStreamEndSchema = z.object({
  _end: z.literal(1),
  next: z.string().optional(),
  hasMore: z.boolean(),
});

// Stable runtimes stored these errors as CBOR StructuredError objects rather
// than the format-prefixed serialized bytes emitted by current runtimes.
const legacyStructuredErrorEventTypes = new Set<EventType>([
  'run_failed',
  'step_failed',
  'step_retrying',
]);

function decodeLegacyStructuredError(payload: Uint8Array): unknown {
  if (hasSerializedDataFormatPrefix(payload)) return payload;

  try {
    const parsed = StructuredErrorSchema.safeParse(decode(payload.slice()));
    return parsed.success ? parsed.data : payload;
  } catch {
    return payload;
  }
}

function decodeEventFrame({ meta, body }: DecodedFrame): Event {
  const eventType = EventTypeSchema.parse(meta.eventType);
  if (body.byteLength === 0) return EventSchema.parse(meta);

  const payloadField = getEventDataPayloadField(eventType);
  assert(payloadField, `Event type ${eventType} cannot carry a payload body`);
  assert(meta.eventData && typeof meta.eventData === 'object');

  return EventSchema.parse({
    ...meta,
    eventData: {
      ...meta.eventData,
      [payloadField]: legacyStructuredErrorEventTypes.has(eventType)
        ? decodeLegacyStructuredError(body)
        : body,
    },
  });
}

/** Build the CBOR meta map for a v4 POST frame. Drops undefined entries
 *  so the wire shape matches what the server expects to see. */
function buildPostFrameMeta(
  input: CreateEventV4InputBase & {
    eventType: EventType;
    skipPreload?: true;
  }
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    eventType: input.eventType,
    specVersion: input.specVersion,
  };
  if (input.correlationId !== undefined)
    meta.correlationId = input.correlationId;
  if (input.vercelId !== undefined) meta.vercelId = input.vercelId;
  if (input.computeInstanceId !== undefined)
    meta.computeInstanceId = input.computeInstanceId;
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
  if (input.hookTokenRetentionUntil !== undefined) {
    meta.hookTokenRetentionUntil = input.hookTokenRetentionUntil;
  }
  if (input.hookIsWebhook !== undefined)
    meta.hookIsWebhook = input.hookIsWebhook;
  if (input.hookIsSystem !== undefined) meta.hookIsSystem = input.hookIsSystem;
  if (input.resumeId !== undefined) meta.resumeId = input.resumeId;
  if (input.errorCode !== undefined) meta.errorCode = input.errorCode;
  if (input.cancelReason !== undefined) meta.cancelReason = input.cancelReason;
  if (input.ownerMessageId !== undefined) {
    meta.ownerMessageId = input.ownerMessageId;
  }
  if (input.executionContext !== undefined) {
    meta.executionContext = input.executionContext;
  }
  if (input.attributes !== undefined) meta.attributes = input.attributes;
  if (input.changes !== undefined) meta.changes = input.changes;
  if (input.writer !== undefined) meta.writer = input.writer;
  if (input.allowReservedAttributes !== undefined) {
    meta.allowReservedAttributes = input.allowReservedAttributes;
  }
  if (input.encryptionPublicKey !== undefined) {
    meta.encryptionPublicKey = input.encryptionPublicKey;
  }
  if (input.ttfs !== undefined) meta.ttfs = input.ttfs;
  if (input.stso !== undefined) meta.stso = input.stso;
  if (input.stepCount !== undefined) meta.stepCount = input.stepCount;
  if (input.eventCount !== undefined) meta.eventCount = input.eventCount;
  if (input.rsfs !== undefined) meta.rsfs = input.rsfs;
  if (input.finalSchedulingReplay !== undefined) {
    meta.finalSchedulingReplay = input.finalSchedulingReplay;
  }
  if (input.optimizations !== undefined) {
    meta.optimizations = input.optimizations;
  }
  if (input.sinceCursor !== undefined) meta.sinceCursor = input.sinceCursor;
  if (input.skipPreload) meta.skipPreload = true;
  if (input.stateUpdatedAt !== undefined) {
    meta.stateUpdatedAt = input.stateUpdatedAt;
  }
  if (input.stateEventCount !== undefined) {
    meta.stateEventCount = input.stateEventCount;
  }
  if (input.stateCursor !== undefined) meta.stateCursor = input.stateCursor;
  if (input.replayDivergenceCount !== undefined) {
    meta.replayDivergenceCount = input.replayDivergenceCount;
  }
  if (input.resumePayloadDigest !== undefined) {
    meta.resumePayloadDigest = input.resumePayloadDigest;
  }
  return meta;
}

/**
 * Build the typed error for a non-2xx v4 response. Reuses the shared
 * `errorForResponse` status → error-type contract (409→EntityConflictError,
 * 410→RunExpiredError, 412→PreconditionFailedError, 425→TooEarlyError,
 * 429→ThrottleError, else →WorkflowWorldError) so v3 and v4 stay in lockstep —
 * only the message *string* is v4-specific (`v4 {opName} failed: HTTP …`,
 * which the runtime and log tooling key on; the hook 404 →
 * HookNotFoundError translation in events.ts keys off status === 404).
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
  let details: unknown;
  try {
    const json = JSON.parse(errorBody) as {
      message?: string;
      code?: string;
      events?: unknown;
      cursor?: unknown;
    };
    if (typeof json.message === 'string') message = json.message;
    if (typeof json.code === 'string') code = json.code;
    if (statusCode === 412) details = decodePreconditionDetails(json);
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
    ...(details !== undefined ? { details } : {}),
  });
}

/**
 * Pick the inline event delta off a 412 body.
 *
 * A rejecting server MAY attach the events the client's snapshot was missing,
 * so the runtime can correct its event log without a follow-up events.list.
 * The *presence* of `events` is the server's completeness signal — it omits
 * them entirely when it cannot prove the set accounts for the whole
 * discrepancy — which also means an older or non-supporting server produces
 * the same "no delta" shape as one that declined to prove it, and the client
 * needs a single fallback path for both.
 *
 * Anything unexpected in the payload is dropped rather than repaired: this is
 * untrusted-shaped data on a failure path, and the fallback (a full reload) is
 * always correct.
 */
function decodePreconditionDetails(json: {
  events?: unknown;
  cursor?: unknown;
}): PreconditionFailureDetails | undefined {
  if (!Array.isArray(json.events) || json.events.length === 0) return undefined;
  const events: Event[] = [];
  for (const raw of json.events) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.eventId !== 'string') return undefined;
    if (hasUnusablePayload(candidate)) return undefined;
    const event = EventSchema.safeParse(candidate);
    if (!event.success) return undefined;
    events.push(event.data);
  }
  return {
    events,
    ...(typeof json.cursor === 'string' ? { cursor: json.cursor } : {}),
  };
}

/**
 * True when an event carries a user payload that this JSON body cannot
 * represent, which disqualifies the whole delta.
 *
 * Payload fields (input / output / result / error / payload / metadata) are
 * `Uint8Array` everywhere else in this client — the runtime dehydrates before
 * writing and rehydrates after reading, and the write path throws on anything
 * else. A 412 body is JSON, though: the request carries no
 * `Accept: application/cbor`, so resolved bytes serialize to
 * `{"type":"Buffer","data":[…]}` or an index-keyed object depending on the
 * backend's serializer. `EventSchema` accepts either — its payload fields are
 * unions that bottom out in `z.any()` — so nothing downstream would flag the
 * mangled value; the runtime would hydrate garbage from it instead.
 *
 * Refusing the delta is one-sided safe: the fallback full reload goes over a
 * frame-encoded path that returns real bytes. Deltas made only of
 * payload-less events (waits, hook disposal, attribute writes) keep the fast
 * path.
 */
function hasUnusablePayload(candidate: Record<string, unknown>): boolean {
  const eventType = candidate.eventType;
  if (typeof eventType !== 'string') return false;
  const payloadField = getEventDataPayloadField(eventType);
  if (!payloadField) return false;
  const eventData = candidate.eventData;
  if (typeof eventData !== 'object' || eventData === null) return false;
  const value = (eventData as Record<string, unknown>)[payloadField];
  // An absent/undefined payload is legitimate (a void step result, a workflow
  // returning nothing) and needs no bytes to be correct.
  if (value === undefined) return false;
  return !(value instanceof Uint8Array);
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
 * Sends the full request as a single v4 frame and validates the materialized
 * CBOR response.
 *
 * The trailing `:eventType` path segment is an alias of the canonical
 * `/events` route: it exists purely so the event type is visible in
 * access logs / traces / route metrics without decoding the frame body.
 * The frame meta's `eventType` remains authoritative — the backend
 * cross-checks the two and logs (but does not reject) a mismatch.
 */
async function postWorkflowRunEventV4(
  input: CreateEventV4InputBase & {
    eventType: EventType;
    skipPreload?: true;
  },
  responseType: 'materialized' | 'event-stream',
  config?: APIConfig
) {
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  if (responseType === 'event-stream') {
    headers.set('Accept', V4_FRAME_CONTENT_TYPE);
  }

  const frame = encodeFrame(
    buildPostFrameMeta(input),
    input.payload ?? new Uint8Array(0)
  );

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(input.runId)}/events/${encodeURIComponent(input.eventType)}`;
  return fetchV4(
    url,
    { method: 'POST', headers, body: frame },
    config,
    'createEvent'
  );
}

export async function createWorkflowRunEventV4<T extends EventType>(
  input: CreateEventV4Input & { eventType: T },
  config?: APIConfig
): Promise<EventResult<T> & { event: Event }> {
  const response = await postWorkflowRunEventV4(input, 'materialized', config);

  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error('v4 createEvent: unexpected event page');
  }

  return decodeCreateEventResponse(response, input.eventType);
}

async function decodeCreateEventResponse<T extends EventType>(
  response: Response,
  eventType: T
): Promise<EventResult<T> & { event: Event }> {
  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  if (bodyBytes.byteLength === 0) {
    throw new Error('v4 createEvent: empty response body');
  }
  const schema: z.ZodType<EventResult<T> & { event: Event }> =
    CreateEventV4BodySchemas[eventType].refine(
      ({ event }) =>
        event.eventType === eventType ||
        (eventType === 'hook_created' && event.eventType === 'hook_conflict'),
      { path: ['event', 'eventType'] }
    );
  const parsedBody = schema.safeParse(decode(bodyBytes));
  if (!parsedBody.success) {
    throw new WorkflowWorldError('v4 createEvent: invalid response body', {
      code: 'SCHEMA_VALIDATION',
      cause: parsedBody.error,
    });
  }
  return parsedBody.data;
}

export async function createWorkflowRunStartedEventV4(
  input: CreateEventV4InputBase,
  config?: APIConfig
) {
  const response = await postWorkflowRunEventV4(
    { ...input, eventType: 'run_started' },
    'event-stream',
    config
  );
  const events: Event[] = [];
  const page = await consumeEventFrameStream(response, 'createEvent', events);
  assert(page.cursor, 'v4 createEvent: event stream missing cursor');
  const maxEvents = MaxEventsHeaderSchema.safeParse(
    response.headers.get(MAX_EVENTS_HEADER)
  );
  if (!maxEvents.success) {
    throw new WorkflowWorldError('v4 createEvent: invalid max-events header', {
      code: 'SCHEMA_VALIDATION',
      cause: maxEvents.error,
    });
  }

  return { events, ...page, maxEvents: maxEvents.data };
}

/**
 * Result of a `hook_received` POST that opted into the replay-log preload,
 * discriminated on `kind` (keyed on the response content type).
 */
export type HookReceivedPreloadV4Result =
  /** The server streamed the replay log back as v4 frames. */
  | (ListEventsV4Result & {
      kind: 'stream';
      /**
       * The canonical event this write created or converged on (the resume
       * claim winner's — ours or the producer's), named by the
       * event-id response header. Undefined when the server did not send it.
       */
      canonicalEventId: string | undefined;
      /** Per-run event ceiling from the response header, when present. */
      maxEvents: number | undefined;
    })
  /**
   * The server answered with the normal materialized CBOR body instead —
   * an older server, or one that declined the optimization. The
   * hook_received write itself has still succeeded; callers must not
   * re-post it.
   */
  | {
      kind: 'materialized';
      result: EventResult<'hook_received'> & { event: Event };
    };

/**
 * POST /api/v4/runs/:runId/events/hook_received with the v4-frame `Accept`,
 * consuming either response mode.
 *
 * A server that supports the lazy-hook replay stream answers the consumer's
 * idempotent re-ensure with the run's complete replay log as v4 frames —
 * the same event-frame sequence LIST uses, ending with the `_end` sentinel.
 * A truncated stream (EOF without the sentinel) throws; the write is
 * deduplicated by the server's `(runId, resumeId)` constraint, so retrying
 * the whole request is safe and converges on the same canonical event.
 */
export async function createHookReceivedPreloadEventV4(
  input: CreateEventV4InputBase,
  config?: APIConfig
): Promise<HookReceivedPreloadV4Result> {
  const response = await postWorkflowRunEventV4(
    { ...input, eventType: 'hook_received' },
    'event-stream',
    config
  );

  const contentType = response.headers.get('content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    return {
      kind: 'materialized',
      result: await decodeCreateEventResponse(response, 'hook_received'),
    };
  }

  const events: Event[] = [];
  const page = await consumeEventFrameStream(response, 'createEvent', events);
  const maxEvents = MaxEventsHeaderSchema.safeParse(
    response.headers.get(MAX_EVENTS_HEADER)
  );
  return {
    kind: 'stream',
    events,
    ...page,
    canonicalEventId: response.headers.get(EVENT_ID_HEADER) ?? undefined,
    maxEvents: maxEvents.success ? maxEvents.data : undefined,
  };
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
 * Returns one validated event. The wire format is identical to a single LIST
 * frame so the server can stream the payload back without buffering.
 */
export async function getEventV4(
  runId: string,
  eventId: string,
  remoteRefBehavior: 'resolve' | 'lazy',
  config?: APIConfig
): Promise<Event> {
  const { baseUrl, headers } = await getHttpConfig(config);

  const url =
    `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventId)}` +
    `?remoteRefBehavior=${remoteRefBehavior}`;
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
    return decodeEventFrame(frame);
  }
  throw new Error(`v4 getEvent: empty frame stream for ${eventId}`);
}

export interface ListEventsV4Params extends PaginationOptions {
  /**
   * Whether the backend resolves payload bytes into each frame body.
   * `resolve` (default) streams the bytes; `lazy` emits empty-body frames
   * (the ref descriptor stays in the frame meta) — for metadata-only
   * listings that would otherwise download every payload just to discard
   * it.
   */
  remoteRefBehavior?: 'resolve' | 'lazy';
}

type ListWorkflowRunEventsV4Params = ListEventsV4Params &
  Pick<ListEventsParams, 'returnAll'>;

export interface ListEventsV4Result {
  events: Event[];
  /** Trailing event-log cursor, or null when the stream contained no events. */
  cursor: string | null;
  /** Explicit "another page of results exists" flag from the sentinel. */
  hasMore: boolean;
}

async function consumeEventFrameStream(
  response: Response,
  opName: string,
  events: Event[]
): Promise<Pick<ListEventsV4Result, 'cursor' | 'hasMore'>> {
  const contentType = response.headers.get('content-type');
  if (!contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error(
      `v4 ${opName}: expected ${V4_FRAME_CONTENT_TYPE}, got ${contentType ?? '(none)'}`
    );
  }

  const chunks = response.body as unknown as AsyncIterable<Uint8Array>;

  for await (const frame of decodeFrames(chunks)) {
    if (frame.meta._end === 1) {
      const end = EventStreamEndSchema.parse(frame.meta);
      return { cursor: end.next ?? null, hasMore: end.hasMore };
    }
    if (Object.keys(frame.meta).some((key) => key.startsWith('_'))) {
      throw new Error(`v4 ${opName}: unexpected control frame`);
    }
    events.push(decodeEventFrame(frame));
  }

  throw new Error(
    `v4 ${opName}: frame stream ended without the end-of-stream sentinel ` +
      `(${events.length} events read) — truncated response?`
  );
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
  opName: string,
  events: Event[]
): Promise<Pick<ListEventsV4Result, 'cursor' | 'hasMore'>> {
  const response = await fetchV4(
    url,
    { method: 'GET', headers },
    config,
    opName
  );
  return consumeEventFrameStream(response, opName, events);
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

function paginationToQuery(params: ListWorkflowRunEventsV4Params): string {
  const sp = new URLSearchParams();
  appendListParams(sp, params);
  if (params.returnAll) sp.set('returnAll', 'true');
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * GET /api/v4/runs/:runId/events
 *
 * Parses the binary-frame stream into validated events plus the pagination
 * cursor from the sentinel frame.
 *
 * Eagerly drains the stream into memory to match the existing
 * `getWorkflowRunEvents` contract. A truncated `returnAll` response resumes
 * after its last validated event instead of downloading accepted frames again.
 */
export async function getWorkflowRunEventsV4(
  runId: string,
  params: ListWorkflowRunEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl, headers } = await getHttpConfig(config);
  const events: Event[] = [];
  let cursor = params.cursor;

  while (true) {
    const url =
      `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events` +
      paginationToQuery({ ...params, cursor });
    try {
      const page = await consumeListFrameStream(
        url,
        headers,
        config,
        'listEvents',
        events
      );
      return { events, ...page };
    } catch (error) {
      const lastEvent = events.at(-1);
      if (
        !params.returnAll ||
        !lastEvent ||
        `eid:${lastEvent.eventId}` === cursor
      ) {
        throw error;
      }
      cursor = `eid:${lastEvent.eventId}`;
    }
  }
}

/**
 * GET /api/v4/events?correlationId=...&runId=...
 *
 * Same frame stream as getWorkflowRunEventsV4 but selected by correlation id
 * instead of run id alone. Used by the storage adapter's
 * `events.listByCorrelationId` path — the v3 client used
 * `/v2/events?correlationId=...` for the equivalent query.
 *
 * `runId` scopes the lookup. A correlation id names a step, hook or wait
 * within *its* run, so the same one can appear in many runs; sending the run
 * is what lets the backend answer for one. A backend that predates the
 * parameter ignores it and answers across runs, so the caller still filters
 * the page by run id.
 */
export async function getEventsByCorrelationIdV4(
  correlationId: string,
  runId: string,
  params: ListEventsV4Params = {},
  config?: APIConfig
): Promise<ListEventsV4Result> {
  const { baseUrl, headers } = await getHttpConfig(config);
  const sp = new URLSearchParams();
  sp.set('correlationId', correlationId);
  sp.set('runId', runId);
  appendListParams(sp, params);
  const url = `${baseUrl}/v4/events?${sp.toString()}`;
  const events: Event[] = [];
  const page = await consumeListFrameStream(
    url,
    headers,
    config,
    'listEventsByCorrelationId',
    events
  );
  return { events, ...page };
}
