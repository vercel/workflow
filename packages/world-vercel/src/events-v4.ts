/**
 * v4 event endpoints: fully framed wire protocol.
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
 * bytes. This module stays at the wire-bytes layer.
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
  headersToRecord,
  httpLog,
  instrumentedFetch,
  parseRetryAfter,
  recordClientSpanStatus,
  withHttpClientSpan,
} from './http-core.js';
import { hasSerializedDataFormatPrefix } from './serialized-data.js';
import { deserializeStep, StepWireSchema } from './steps.js';
import {
  ErrorType,
  NetworkProtocolName,
  StepLatencyOptimizations,
  StepStsoMs,
  WorkflowClientVersion,
  WorkflowEventsTransport,
  WorkflowEventType,
  WorkflowWsRequestId,
  WorkflowWsUrl,
} from './telemetry.js';
import { type APIConfig, getHttpConfig, getHttpUrl } from './utils.js';
import { version } from './version.js';
import type { WsFrameReply } from './ws-transport.js';
import { isWsEventsTransportEnabled } from './ws-transport-enabled.js';

/**
 * Issue an instrumented v4 request through the global `fetch`, NOT undici's
 * `request`.
 *
 * Vercel's observability "outgoing requests" view instruments the global
 * `fetch`. Calling `undici.request()` directly bypasses that instrumentation,
 * so v4 event traffic disappeared from the log viewer while queue traffic
 * (which uses `fetch`) kept showing. `instrumentedFetch` routes through the
 * global `fetch` with the custom dispatcher, restoring visibility while also
 * opening the OpenTelemetry client span, injecting trace context, setting the
 * cache-bust header (see #618), and emitting `DEBUG` logs. This is the same
 * envelope the v3 `makeRequest` path has always had.
 *
 * The events API uses its own HTTP/2-enabled dispatcher
 * (`getEventsDispatcher`): these reads/writes are plain request/response (or a
 * streamed LIST response) and benefit from multiplexing. The default dispatcher
 * stays on HTTP/1.1 because H2 deadlocks the queue's webhook respondWith
 * mechanism. See http-client.ts.
 *
 * No per-request timeout: a LIST response streams the full event-log page, which
 * for a large run can legitimately take a while to drain, so a whole-request
 * deadline would abort it mid-stream.
 */
async function fetchV4(
  url: string,
  init: { method: string; headers: Headers; body?: Uint8Array },
  config: APIConfig | undefined,
  opName: string,
  attributes?: Record<string, string | number | string[]>
): Promise<Response> {
  const dispatcher = getEventsDispatcher(config);
  return instrumentedFetch({
    method: init.method,
    url,
    headers: init.headers,
    body: init.body,
    dispatcher,
    attributes,
    // Repeated transport failures retire the shared events pool and the next
    // request builds a fresh one. undici keeps a black-holed HTTP/2 session in
    // service indefinitely, so without this every request routed onto it fails
    // until the compute instance is recycled. See noteEventsTransportOutcome.
    onTransportOutcome: (error) =>
      noteEventsTransportOutcome(dispatcher, error),
    timeoutMs: null,
    logLabel: opName,
    // Read the body as bytes, not text: a CBOR error body (the fence 412
    // carries event payloads back) does not survive a UTF-8 decode.
    buildError: async (response) =>
      errorFromV4Response(
        response.status,
        headersToRecord(response.headers),
        new Uint8Array(await response.arrayBuffer()),
        opName,
        url
      ),
  });
}

const EVENT_ID_HEADER = 'x-wf-event-id';
const MAX_EVENTS_HEADER = 'x-wf-max-events';

/**
 * The v4 endpoint one event write targets.
 *
 * Shared with the WS path, which never requests it but reports it as the
 * `url.full` of its synthetic client span: the server forwards a frame into
 * this exact route, so naming it is what lets a trace or a dashboard compare
 * the two transports write-for-write. Drift between the two would silently
 * split that comparison in half.
 */
function eventsV4Url(
  baseUrl: string,
  runId: string,
  eventType: string
): string {
  return `${baseUrl}/v4/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventType)}`;
}

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
   *  back to a Date. The round-trip is symmetric, so wait_created /
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
   *  excluding awaited network I/O, not accumulated across earlier
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
   * Highest event slot the writer had loaded, i.e. the length of its loaded
   * log under slot identity. Named `maxSlot` on the wire because the meta
   * already carries an unrelated telemetry `eventCount`.
   *
   * Sent by every replay-context create on a slot-identity run. The server
   * allocates from the tail regardless, and uses this only to report which
   * slots the write skipped over (returned on the success response as
   * `events`/`cursor`/`hasMore`). Older servers ignore it.
   */
  maxSlot?: number;
  /** Number of consecutive replay divergences resolved by this write. */
  replayDivergenceCount?: number;
  /** Content digest of the serialized resume payload. Forwarded alongside
   *  `resumeId` so the direct write and the queue re-ensure record an identical
   *  digest on the server's `(runId, resumeId)` constraint (the v4 payload ref
   *  is not content-stable server-side). Older servers ignore it. */
  resumePayloadDigest?: string;
  /** Marks a `step_created` as the queue consumer's re-ensure of a resilient
   *  step dispatch (`stepInput`-carrying step message). Advisory. See
   *  CreateEventParams.viaStepDispatch in @workflow/world: the server MAY
   *  refuse it with 410 (`step-dispatch-revoked` → RunExpiredError) as
   *  defense-in-depth when it recorded a 412 rejection for this correlation
   *  id and no step entity exists. Older servers ignore it. */
  viaStepDispatch?: boolean;
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
 * consumers narrow structurally; this interface is the contract they narrow
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
  // Never POSTed by the SDK (server-originated sealed-log filler); present
  // only because the map is exhaustive over EventType.
  noop: CreateEventV4BodySchema,
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
  if (input.maxSlot !== undefined) meta.maxSlot = input.maxSlot;
  if (input.replayDivergenceCount !== undefined) {
    meta.replayDivergenceCount = input.replayDivergenceCount;
  }
  if (input.resumePayloadDigest !== undefined) {
    meta.resumePayloadDigest = input.resumePayloadDigest;
  }
  if (input.viaStepDispatch !== undefined) {
    meta.viaStepDispatch = input.viaStepDispatch;
  }
  return meta;
}

/**
 * Build the typed error for a non-2xx v4 response. Reuses the shared
 * `errorForResponse` status → error-type contract (409→EntityConflictError,
 * 410→RunExpiredError, 412→PreconditionFailedError, 425→TooEarlyError,
 * 429→ThrottleError, else →WorkflowWorldError) so v3 and v4 stay in lockstep.
 * only the message *string* is v4-specific (`v4 {opName} failed: HTTP …`,
 * which the runtime and log tooling key on; the hook 404 →
 * HookNotFoundError translation in events.ts keys off status === 404).
 */
function errorFromV4Response(
  statusCode: number,
  responseHeaders: Record<string, string | string[] | undefined>,
  errorBody: string | Uint8Array,
  opName: string,
  url: string
): Error {
  let message = `v4 ${opName} failed: HTTP ${statusCode}`;
  let code: string | undefined;
  let details: unknown;
  const { record, text } = parseV4ErrorBody(
    errorBody,
    readHeader(responseHeaders, 'content-type')
  );
  if (record) {
    if (typeof record.message === 'string') message = record.message;
    if (typeof record.code === 'string') code = record.code;
    if (statusCode === 412) details = decodePreconditionDetails(record);
  } else if (text) {
    // body wasn't a structured object, so keep the default message and append
    // whatever the server did send
    message += ` ${text}`;
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

/** The fields `errorFromV4Response` reads off a structured error body. */
interface V4ErrorBody {
  message?: unknown;
  code?: unknown;
  events?: unknown;
  cursor?: unknown;
}

/**
 * Decode an error body into the record the error builder reads, or into the
 * raw text to append when it is not structured.
 *
 * Two encodings reach this. The default is JSON: the v4 request sends no
 * `Accept: application/cbor`, so the server's generic error responder
 * negotiates JSON. Responses that need to carry event payloads back are
 * hand-encoded as CBOR by the server and say so in `content-type`, because
 * JSON cannot round-trip a `Uint8Array` (see `hasUnusablePayload`). Reading
 * the body as bytes and branching on the header serves both; decoding bytes as
 * text first would corrupt CBOR beyond recovery.
 */
function parseV4ErrorBody(
  body: string | Uint8Array,
  contentType: string | undefined
): { record?: V4ErrorBody; text?: string } {
  if (typeof body !== 'string' && contentType?.includes('application/cbor')) {
    try {
      // cbor-x caches decode state on its input; decode a copy so a shared
      // buffer is never mutated under an unrelated reader.
      const decoded = decode(body.slice()) as unknown;
      if (typeof decoded === 'object' && decoded !== null) {
        return { record: decoded as V4ErrorBody };
      }
    } catch {
      // undecodable CBOR: appending its bytes as text would be noise
    }
    return {};
  }
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json === 'object' && json !== null) {
      return { record: json as V4ErrorBody };
    }
  } catch {
    // not JSON either; fall through to the raw text
  }
  return { text };
}

/**
 * Pick the inline event delta off a 412 body.
 *
 * A rejecting server MAY attach the events the client's snapshot was missing,
 * so the runtime can correct its event log without a follow-up events.list.
 * The *presence* of `events` is the server's completeness signal: it omits
 * them entirely when it cannot prove the set accounts for the whole
 * discrepancy, which also means an older or non-supporting server produces
 * the same "no delta" shape as one that declined to prove it, and the client
 * needs a single fallback path for both.
 *
 * Anything unexpected in the payload is dropped rather than repaired: this is
 * untrusted-shaped data on a failure path, and the fallback (a full reload) is
 * always correct.
 */
function decodePreconditionDetails(
  json: V4ErrorBody
): PreconditionFailureDetails | undefined {
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
 * `Uint8Array` everywhere else in this client. The runtime dehydrates before
 * writing and rehydrates after reading, and the write path throws on anything
 * else. A JSON 412 body cannot hold that: resolved bytes serialize to
 * `{"type":"Buffer","data":[…]}` or an index-keyed object depending on the
 * backend's serializer. `EventSchema` accepts either. Its payload fields are
 * unions that bottom out in `z.any()`, so nothing downstream would flag the
 * mangled value; the runtime would hydrate garbage from it instead. A CBOR
 * body round-trips the bytes intact and passes this check on its own merits,
 * which is why a backend that attaches an event delta to a 412 encodes it that
 * way.
 *
 * Refusing the delta is one-sided safe: the fallback full reload goes over a
 * frame-encoded path that returns real bytes. Deltas made only of
 * payload-less events (waits, hook disposal, attribute writes) keep the fast
 * path whatever the encoding.
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
  errorBody: string | Uint8Array,
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
 * The frame meta's `eventType` remains authoritative, and the backend
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

  const url = eventsV4Url(baseUrl, input.runId, input.eventType);
  return fetchV4(
    url,
    { method: 'POST', headers, body: frame },
    config,
    'createEvent',
    {
      ...WorkflowEventsTransport('http'),
      ...WorkflowEventType(input.eventType),
      ...WorkflowClientVersion(`@workflow/world-vercel/${version}`),
      ...(input.stso !== undefined ? StepStsoMs(input.stso) : {}),
      ...(input.optimizations !== undefined
        ? StepLatencyOptimizations(input.optimizations)
        : {}),
    }
  );
}

/**
 * The WS transport carries this materialized POST and only this one. The
 * `event-stream` writes below answer with a sentinel-terminated sequence of
 * frames, which has no representation in a protocol that pairs one reply frame
 * with one request frame.
 */
export async function createWorkflowRunEventV4<T extends EventType>(
  input: CreateEventV4Input & { eventType: T },
  config?: APIConfig
): Promise<EventResult<T> & { event: Event }> {
  if (isWsEventsTransportEnabled()) {
    // Absent means no socket was resolvable for this run, not that the write
    // failed, so fall through to HTTP.
    const reply = await postEventFrameOverWs(input, config);
    if (reply) return decodeCreateEventResponse(reply, input.eventType);
  }

  const response = await postWorkflowRunEventV4(input, 'materialized', config);

  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith(V4_FRAME_CONTENT_TYPE)) {
    throw new Error('v4 createEvent: unexpected event page');
  }

  return decodeCreateEventResponse(response, input.eventType);
}

/** Takes `FrameResponseLike` rather than `Response` because the WS branch has
 *  none to hand over; it synthesizes one. A real `Response` satisfies the
 *  interface, so the HTTP callers are unaffected. */
async function decodeCreateEventResponse<T extends EventType>(
  response: FrameResponseLike,
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

/** One event of a v4 batch POST, index-aligned with the response results. */
export type CreateEventBatchV4Event = CreateEventV4InputBase & {
  eventType: EventType;
};

export interface CreateEventBatchV4Input {
  runId: string;
  /** Events in request order: the order they land in the run's log. */
  events: CreateEventBatchV4Event[];
}

/**
 * One event's outcome in a batch response. `error === undefined`
 * discriminates success; a success item carries the same materialized body
 * its single-event POST would have returned (validated against the same
 * per-type schema).
 */
export type CreateEventBatchV4ItemResult =
  | ({ status: 200; error?: undefined; message?: undefined } & EventResult &
      Record<'event', Event>)
  | { status: number; error: string; message: string; event?: undefined };

export interface CreateEventBatchV4Result {
  results: CreateEventBatchV4ItemResult[];
}

const BatchItemFailureSchema = z.object({
  status: z.number().int(),
  error: z.string(),
  message: z.string(),
});

/**
 * POST /api/v4/runs/:runId/events/batch
 *
 * Appends an ordered batch of events to one run's log in a single durable
 * write with per-event outcomes. The body is the events' single-POST frames
 * back-to-back (byte-identical framing, no batch-level meta); the response is
 * HTTP 200 CBOR `{ results }` whenever the batch was processed, one entry per
 * frame in request order.
 *
 * Slot-identity runs only: an older server 404s the route and a pre-slot
 * run is rejected with a 400. There is NO automatic fallback to single-event
 * posts on either: the runtime never sends a batch for a pre-slot run (it
 * gates on the run's spec version), and against a backend without the route
 * the batch fails and the suspension redelivers until the operator disables
 * batching via `WORKFLOW_BATCH_TRANSITIONS=0`. Ambiguous failures (timeouts,
 * resets, 5xx, malformed responses) never convert to single posts either;
 * the wrapper either re-sends the SAME batch (only when its shape is
 * retry-convergent; see `createWorkflowRunEventBatch`) or surfaces the error
 * for queue redelivery, whose replay re-derives an idempotent batch.
 *
 * HTTP-only by design: the WS event transport streams one frame per message
 * and has no batch framing, so a WS-configured deployment still sends
 * batches over HTTP (single-event writes keep their configured transport).
 */
export async function createWorkflowRunEventsBatchV4(
  input: CreateEventBatchV4Input,
  config?: APIConfig
): Promise<CreateEventBatchV4Result> {
  assert(input.events.length > 0, 'v4 createEventBatch: empty batch');
  const { baseUrl, headers: baseHeaders } = await getHttpConfig(config);
  const headers = new Headers(baseHeaders);
  // Match the single-event POST content type: the batch route runs on the
  // same authed + v4 middleware chain and the frame bytes are identical.
  headers.set('Content-Type', 'application/octet-stream');

  const frames = input.events.map((event) =>
    encodeFrame(buildPostFrameMeta(event), event.payload ?? new Uint8Array(0))
  );
  let total = 0;
  for (const frame of frames) total += frame.byteLength;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    body.set(frame, offset);
    offset += frame.byteLength;
  }

  const url = `${baseUrl}/v4/runs/${encodeURIComponent(input.runId)}/events/batch`;
  // Batch identity attributes (size, per-type shape) live on the
  // world.events.createBatch span (see instrumentObject); this transport
  // span carries only wire-level facts. workflow.event.type is deliberately
  // absent, since it names a single event write, and tagging a batch with its
  // first event's type misclassifies the traffic.
  const response = await fetchV4(
    url,
    { method: 'POST', headers, body },
    config,
    'createEventBatch',
    {
      ...WorkflowEventsTransport('http'),
      'workflow.batch.bytes': body.byteLength,
    }
  );

  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const decoded =
    bodyBytes.byteLength > 0
      ? (decode(bodyBytes) as { results?: unknown[] })
      : {};
  // A 200 MUST carry exactly one outcome per submitted frame, in request
  // order: callers index `results` positionally. A missing / non-array /
  // short `results` is a server protocol violation; silently coercing it
  // would masquerade as per-event failures and hide the server bug. The
  // batch POST is idempotent-on-retry (per-event entity conditions), so
  // failing loudly here is safe for the retry wrapper to re-send.
  if (
    !Array.isArray(decoded.results) ||
    decoded.results.length !== input.events.length
  ) {
    throw new WorkflowWorldError(
      `v4 createEventBatch: response \`results\` length ` +
        `(${Array.isArray(decoded.results) ? decoded.results.length : 'non-array'}) ` +
        `!= ${input.events.length} submitted frames`,
      { code: 'SCHEMA_VALIDATION' }
    );
  }

  const results = decoded.results.map(
    (raw, index): CreateEventBatchV4ItemResult => {
      const failure = BatchItemFailureSchema.safeParse(raw);
      if (failure.success && failure.data.status !== 200) {
        return failure.data;
      }
      // Success requires the LITERAL 200: an item with a non-200 status that
      // failed the failure schema (e.g. missing error/message) must not fall
      // through and be re-labeled a success by the body parse below.
      if ((raw as { status?: unknown } | null)?.status !== 200) {
        throw new WorkflowWorldError(
          `v4 createEventBatch: result at index ${index} is neither a ` +
            'success (status 200) nor a well-formed failure',
          { code: 'SCHEMA_VALIDATION' }
        );
      }
      // Success items validate against the SAME per-type schema the single
      // POST uses, so a batched write and its single-path twin return
      // byte-equivalent bodies to the caller.
      const eventType = input.events[index].eventType;
      const parsed = CreateEventV4BodySchemas[eventType].safeParse(raw);
      if (!parsed.success) {
        throw new WorkflowWorldError(
          `v4 createEventBatch: invalid result body at index ${index} (${eventType})`,
          { code: 'SCHEMA_VALIDATION', cause: parsed.error }
        );
      }
      // Results are consumed positionally; an item whose committed event is
      // of a different type than the frame submitted at this index is a
      // server protocol violation, same as a wrong-length results array.
      if (parsed.data.event.eventType !== eventType) {
        throw new WorkflowWorldError(
          `v4 createEventBatch: result at index ${index} carries a ` +
            `${parsed.data.event.eventType} event, expected ${eventType}`,
          { code: 'SCHEMA_VALIDATION' }
        );
      }
      return { status: 200, ...parsed.data };
    }
  );

  return { results };
}

/** The only two members a decoded transport result is read for. `fetch`'s
 *  `Response` satisfies it structurally, so the HTTP branch returns one
 *  unchanged and the WS branch synthesizes the same shape. */
interface FrameResponseLike {
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Flatten a reply frame's meta into the header record `errorFromV4Response`
 *  already reads (retry-after, x-vercel-mitigated), so the WS path reuses the
 *  HTTP error mapping rather than growing its own. The materialized ids come
 *  out of the CBOR body, so no `x-wf-*` name is mapped here.
 *
 *  Left unmapped, deliberately: `meta.deprecated`, which the server copies from
 *  `X-API-Deprecated`. Inert while the v4 route's middleware chain has no
 *  deprecation middleware to set it, but this record is the only header source
 *  a WS reply has, so an unmapped key is gone rather than merely unread, which
 *  is not true of the real `Response` the HTTP path returns. */
function replyMetaToHeaderRecord(
  meta: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof meta.eventId === 'string') out[EVENT_ID_HEADER] = meta.eventId;
  if (typeof meta.retryAfter === 'string') out['retry-after'] = meta.retryAfter;
  if (typeof meta.mitigated === 'string')
    out['x-vercel-mitigated'] = meta.mitigated;
  return out;
}

/**
 * Retry is owned by `withEventPostRetry` (event-retry.ts) for both transports,
 * so there is deliberately no retry loop here: one would sit *inside*
 * `EVENT_RETRY_ELIGIBILITY` and replay the event types whose handlers have no
 * duplicate guard (a second `step_started` double-increments `attempt`), and
 * would multiply that policy's backoff. Note undici's `RetryAgent`
 * (http-client.ts) retries POSTs on neither transport; `RetryHandler`
 * defaults `methods` to GET/HEAD/OPTIONS/PUT/DELETE/TRACE, which is why
 * event-retry.ts exists at all. So `postEventFrameOverWs` makes exactly one
 * attempt and reports in that policy's vocabulary; a retry from it re-enters
 * `transport.request()`, which reconnects on the way through.
 */

/**
 * Read the status off a reply frame, failing closed when there isn't one:
 * defaulting to 200 would report success for any frame this client doesn't
 * understand, and the protocol is designed to grow new response variants (see
 * the server's docs/ws-protocol.md). `PARSE_ERROR` is the code `utils.ts` uses
 * for an unreadable HTTP body (the same situation), and unlike a bare `Error`
 * it satisfies `WorkflowWorldError.is()` instead of surfacing as a USER_ERROR.
 */
function wsReplyStatus(reply: WsFrameReply, endpoint: string): number {
  const { status } = reply.meta;
  if (typeof status !== 'number') {
    throw new WorkflowWorldError(
      `Failed to parse response body for POST ${endpoint}: reply frame ` +
        `carried no numeric status (type: ` +
        `${String(reply.meta.type ?? 'absent')}). Refusing to treat an ` +
        `unrecognized reply as success — the write may or may not have been ` +
        `applied.`,
      { url: endpoint, code: 'PARSE_ERROR' }
    );
  }
  return status;
}

/**
 * Synthesize the per-write client span the WS path would otherwise not have.
 *
 * On HTTP every event write goes through `fetchV4` → `instrumentedFetch`, which
 * opens an `http POST` CLIENT span, times it, and stamps the response status on
 * it. A frame multiplexed onto a shared socket makes no `fetch` call and
 * produces no `Response`, so that span disappeared when the transport
 * flipped, and with it the per-event view of a run's writes, which is the
 * thing a trace of a step execution is mostly made of.
 *
 * Nothing about the request/response *semantics* changed, though: one frame out,
 * one correlated reply back, one status. So the span is synthesized here with
 * the same name, kind and attributes the fetch path emits, over the v4 REST
 * endpoint the server forwards the frame into. Two consequences that are the
 * point rather than a side effect:
 *
 *   - a trace looks the same either side of `WORKFLOW_EVENTS_TRANSPORT`, so the
 *     A/B the flag exists for compares like with like, and
 *   - dashboards keyed on `http POST` + `url.full` keep working unchanged.
 *
 * What is *not* elided: `workflow.events.transport: 'ws'`,
 * `network.protocol.name: 'websocket'` and `workflow.events.ws.url` say plainly
 * that no HTTP request was issued, and `workflow.events.ws.req_id` is the join
 * key to the server's log line for the same frame. A synthetic span that hid
 * which transport produced it would be a trap, not a convenience.
 *
 * Two things the HTTP envelope has that this one deliberately does not: the
 * cache-bust header (a frame is memoized by nothing) and a per-frame
 * `traceparent` (frames carry no headers; trace context rides the upgrade
 * instead, so the server parents to the connection's span, not to this one).
 *
 * One gap this cannot close: Vercel's observability *outgoing requests* view is
 * built by instrumenting the global `fetch`, not by reading OpenTelemetry spans,
 * so WS event writes stay absent from it however faithful the span is. Traces
 * get the writes back; that view needs a real request, which is the transport's
 * whole point to avoid.
 */
async function postEventFrameOverWs(
  input: CreateEventV4InputBase & {
    eventType: EventType;
    skipPreload?: true;
  },
  config: APIConfig | undefined
): Promise<FrameResponseLike | undefined> {
  // Dynamic so `ws` initializes only on a deployment that opted in. The gate
  // at the call site lives in its own import-free module for exactly this
  // reason. The module is cached after the first write, and on the queue path
  // the pre-warm has already paid for it.
  const { resolveWsTransport } = await import('./ws-transport.js');
  const { runId } = input;
  const resolved = resolveWsTransport(runId, config);
  // No span: resolving nothing means no write was attempted here at all. The
  // caller falls through to HTTP, which opens its own.
  if (!resolved) return undefined;
  const { transport, wsUrl } = resolved;
  const endpoint = `${wsUrl}#runs/${encodeURIComponent(runId)}/events`;
  // Same helper the HTTP path builds its URL with. `resolveWsTransport` already
  // returned null for the proxy World, so this is always the direct
  // workflow-server origin the socket itself points at.
  const restUrl = eventsV4Url(
    getHttpUrl(config).baseUrl,
    runId,
    input.eventType
  );

  return withHttpClientSpan(
    {
      method: 'POST',
      url: restUrl,
      attributes: {
        ...WorkflowEventsTransport('ws'),
        ...WorkflowEventType(input.eventType),
        ...WorkflowClientVersion(`@workflow/world-vercel/${version}`),
        ...(input.stso !== undefined ? StepStsoMs(input.stso) : {}),
        ...(input.optimizations !== undefined
          ? StepLatencyOptimizations(input.optimizations)
          : {}),
        ...NetworkProtocolName('websocket'),
        ...WorkflowWsUrl(wsUrl),
      },
    },
    async (span) => {
      const start = Date.now();
      let reply: WsFrameReply;
      try {
        // `runId` isn't repeated here, since it's already in `wsUrl`, one
        // connection per run. The server's request-frame schema is a
        // discriminated union on
        // `type` with each type's payload nested under its own name, so a future
        // request type is a new variant rather than a reshape of this one.
        reply = await transport.request((reqId) => {
          // Recorded before the frame is sent so a request that fails, or one
          // that never gets a reply, still carries the id the server logged it
          // under. Assigned per attempt and per connection, so a retry or a
          // reconnect legitimately re-uses low numbers.
          span?.setAttributes({ ...WorkflowWsRequestId(reqId) });
          return encodeFrame(
            { reqId, type: 'event', event: buildPostFrameMeta(input) },
            input.payload ?? new Uint8Array(0)
          );
        });
      } catch (err) {
        // Anything `transport.request()` throws means the frame was never acked.
        // `code: 'TRANSPORT'` is the shape `utils.ts` gives a failed `fetch`, so
        // one classification drives both transports, with in-process retry
        // gated by event type, then queue redelivery. An unwrapped
        // `WsTransportError`
        // would fail `WorkflowWorldError.is()` and classify as a USER_ERROR.
        // Application errors are raised below, outside this try.
        const error = new WorkflowWorldError(
          `POST ${endpoint} transport failure: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { url: wsUrl, code: 'TRANSPORT', cause: err }
        );
        // `error.type: TRANSPORT` rather than an `HTTP <status>` value: there is
        // no status, and the fetch path marks its own no-response failures the
        // same way (`TIMEOUT`) instead of inventing one.
        span?.setAttributes({ ...ErrorType('TRANSPORT') });
        span?.recordException?.(error);
        throw error;
      }
      const ms = Date.now() - start;

      const status = wsReplyStatus(reply, endpoint);
      const headerRecord = replyMetaToHeaderRecord(reply.meta);
      const headers = {
        get: (name: string) => headerRecord[name.toLowerCase()] ?? null,
      };

      // The same one-line `DEBUG` record the HTTP path emits, so a log grepped
      // for event writes reads identically on either transport.
      httpLog('POST', 'createEvent', { status, headers }, ms);
      recordClientSpanStatus(span, status);

      if (status < 200 || status >= 300) {
        const error = errorFromV4Response(
          status,
          headerRecord,
          new TextDecoder().decode(reply.body),
          'createEvent',
          endpoint
        );
        span?.recordException?.(error);
        throw error;
      }

      return {
        headers,
        arrayBuffer: async () => reply.body.slice().buffer as ArrayBuffer,
      };
    }
  );
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
       * claim winner's (ours or the producer's), named by the
       * event-id response header. Undefined when the server did not send it.
       */
      canonicalEventId: string | undefined;
      /** Per-run event ceiling from the response header, when present. */
      maxEvents: number | undefined;
    })
  /**
   * The server answered with the normal materialized CBOR body instead:
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
 * idempotent re-ensure with the run's complete replay log as v4 frames:
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
  // on Node (readableStream async iteration, since v16.5.0), so feed it straight
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
   * (the ref descriptor stays in the frame meta), for metadata-only
   * listings that would otherwise download and discard every payload.
   */
  remoteRefBehavior?: 'resolve' | 'lazy';
}

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
 * both the by-runId and by-correlationId list endpoints. The wire
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

function paginationToQuery(params: ListEventsV4Params): string {
  const sp = new URLSearchParams();
  // The World API uses an omitted limit for a complete event log.
  if (params.limit === undefined) sp.set('returnAll', 'true');
  appendListParams(sp, params);
  return `?${sp.toString()}`;
}

/**
 * GET /api/v4/runs/:runId/events
 *
 * Parses the binary-frame stream into validated events plus the pagination
 * cursor from the sentinel frame.
 *
 * Eagerly drains the stream into memory to match the existing
 * `getWorkflowRunEvents` contract. A truncated full response resumes
 * after its last validated event instead of downloading accepted frames again.
 */
export async function getWorkflowRunEventsV4(
  runId: string,
  params: ListEventsV4Params = {},
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
        params.limit !== undefined ||
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
 * `events.listByCorrelationId` path. The v3 client used
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
