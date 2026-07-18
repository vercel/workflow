/**
 * world-vercel event functions — v4 wire format throughout.
 *
 * This module replaces the previous v2/v3 implementation. The v4 wire
 * format uses a single length-prefixed binary frame layout in both
 * directions:
 *
 *   frame := [u32_be meta_len][cbor_meta][u32_be body_len][body_bytes]
 *
 * `cbor_meta` is the structured event metadata; `body_bytes` is the
 * opaque user payload, never CBOR-decoded by the server. See the
 * world-vercel backend's v4 handlers for the matching server-side
 * encoding and ../events-v4.ts for the wire-level client.
 *
 * Key shape changes vs. v2/v3:
 *
 *   - POST request body is one v4 frame (meta + payload). The response
 *     surfaces eventId/runId/createdAt as `x-wf-*` headers and carries
 *     the materialized EventResult (event/run/step/hook/wait/events/
 *     cursor/hasMore) as a CBOR body — `remoteRefBehavior` in the frame
 *     meta still controls server-side ref resolution.
 *   - GET single event returns one v4 frame: the event entity in the
 *     frame meta, the user payload bytes in the frame body.
 *   - LIST events returns a stream of v4 frames terminated by a sentinel
 *     frame whose meta carries `{_end: 1, next?: cursor, hasMore?: boolean}`.
 *     The old
 *     per-event `/refs` round-trip is eliminated.
 *
 * Public function signatures are unchanged: storage.ts continues to
 * wire these as `Storage['events']` and the workflow runtime sees the
 * same EventResult / Event / PaginatedResponse<Event> shapes it did on
 * the v3 path.
 */

import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';
import {
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventDataPayloadField,
  type EventResult,
  EventSchema,
  EventTypeSchema,
  type GetEventParams,
  getEventDataPayloadField,
  isHookEventRequiringExistence,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type PaginatedResponse,
  StructuredErrorSchema,
  stripEventDataRefs,
  validateUlidTimestamp,
  type WorkflowRun,
} from '@workflow/world';
import { decode } from 'cbor-x';
import { withEventPostRetry } from './event-retry.js';
import {
  createWorkflowRunEventV4,
  type DecodedV4Event,
  getEventsByCorrelationIdV4,
  getEventV4,
  getWorkflowRunEventsV4,
} from './events-v4.js';
import { decode as decodeRunId } from './run-id/index.js';
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import {
  hasSerializedDataFormatPrefix,
  normalizeEventData,
  normalizeSerializedData,
} from './serialized-data.js';
import { deserializeStep } from './steps.js';
import {
  type APIConfig,
  DEFAULT_RESOLVE_DATA_OPTION,
  deserializeError,
  makeRequest,
} from './utils.js';

function validateWorkflowRunIdTimestamp(id: string): string | null {
  const raw = id.startsWith('wrun_') ? id.slice('wrun_'.length) : id;
  try {
    // world-vercel run IDs may carry region metadata in tagged form; the
    // shared @workflow/world validator intentionally knows nothing about
    // that encoding. `decode()` clears the tag bit (the top bit of the
    // 48-bit timestamp field) so the timestamp validator reads the true
    // timestamp; the region/version metadata bits remain in the
    // randomness section, which the validator doesn't inspect.
    return validateUlidTimestamp(`wrun_${decodeRunId(raw).ulid}`, 'wrun_');
  } catch {
    return validateUlidTimestamp(id, 'wrun_');
  }
}

/**
 * Union of every field a user-creatable event can carry in `eventData`,
 * derived from the @workflow/world `CreateEventSchema` discriminated union
 * (via `AnyEventRequest`). Adding a field to any event schema there widens
 * this union automatically, which is what drives the exhaustiveness guard
 * below. Event types with no `eventData` (run_cancelled) and with optional
 * `eventData` (run_started, step_started, …) both contribute correctly.
 */
type EventDataField<E = AnyEventRequest> = E extends { eventData?: infer D }
  ? keyof NonNullable<D> & string
  : never;

// Events whose POST response the workflow runtime reads immediately
// (so the materialized entity must come back fully resolved).
const eventsNeedingResolve = new Set<string>([
  'run_created', // runtime reads result.run.runId
  'run_started', // runtime reads result.run (checks startedAt, status)
  'step_started', // runtime reads result.step (checks attempt, state)
]);

// Stable runtimes stored these errors as backend-materialized
// StructuredError objects. Their resolved v4 frame bodies are CBOR rather
// than the format-prefixed serialized data emitted by current runtimes.
const legacyStructuredErrorEventTypes = new Set<string>([
  'run_failed',
  'step_failed',
  'step_retrying',
]);

// =============================================================================
// Helpers
// =============================================================================

interface SplitEventData {
  /** Encoded payload bytes (undefined when the event has no user payload). */
  payload?: Uint8Array;
  /** Metadata fields that ride in the v4 POST frame's CBOR meta block. */
  meta: {
    deploymentId?: string;
    workflowName?: string;
    stepName?: string;
    attempt?: number;
    resumeAt?: Date;
    retryAfter?: Date;
    hookToken?: string;
    hookIsWebhook?: boolean;
    hookIsSystem?: boolean;
    errorCode?: string;
    cancelReason?: string;
    /** Inline-ownership stamp on step_started (owning queue message ID). */
    ownerMessageId?: string;
    /** Structured executionContext, included verbatim in frame meta. */
    executionContext?: Record<string, unknown>;
    /** Initial run attributes (run_created / resilient-start run_started). */
    attributes?: Record<string, string>;
    /** attr_set change list, included verbatim in frame meta. */
    changes?: Array<Record<string, unknown>>;
    /** attr_set writer provenance, included verbatim in frame meta. */
    writer?: Record<string, unknown>;
    /** Reserved-attribute-key opt-in (attr_set / run_created / run_started). */
    allowReservedAttributes?: boolean;
    /** Client-measured time-to-first-step ms (step_completed / step_failed). */
    ttfs?: number;
    /** Client-measured step-to-step overhead ms (step_completed / step_failed). */
    stso?: number;
    /** Progress counters taken when the STSO gap began. */
    stepCount?: number;
    eventCount?: number;
    /** Client-measured run_started-to-first-step ms (step_completed / step_failed). */
    rsfs?: number;
    /** Client-measured synchronous replay-compute ms of only the FINAL replay
     *  pass within the rsfs window — not accumulated across earlier
     *  pre-first-step passes, so it is not "the replay portion of rsfs". */
    finalSchedulingReplay?: number;
    /** Runtime optimizations active for the ttfs/stso measurement. */
    optimizations?: string[];
  };
}

/**
 * Source field names in `eventData` that `splitEventDataForV4` lifts into
 * the frame meta (some are renamed on the wire, e.g. `token` → `hookToken`).
 * This is the metadata half of the v4 `eventData` allowlist; the payload
 * half is `EventDataPayloadField`. The exhaustiveness guard below keeps this in sync
 * with the @workflow/world schema in both directions; the per-field
 * extraction in `splitEventDataForV4` is bespoke, so it must read each field
 * listed here.
 */
type MetaSourceField =
  | 'deploymentId'
  | 'workflowName'
  | 'stepName'
  | 'attempt'
  | 'resumeAt'
  | 'retryAfter'
  | 'token'
  | 'isWebhook'
  | 'isSystem'
  | 'errorCode'
  | 'cancelReason'
  | 'ownerMessageId'
  | 'executionContext'
  | 'attributes'
  | 'changes'
  | 'writer'
  | 'allowReservedAttributes'
  | 'ttfs'
  | 'stso'
  | 'stepCount'
  | 'eventCount'
  | 'rsfs'
  | 'finalSchedulingReplay'
  | 'optimizations';

/**
 * Compile-time guard that the v4 `eventData` wire allowlist is exhaustive
 * against the @workflow/world event schemas.
 *
 * - `Unhandled`: schema fields routed to neither the payload body
 *   (`EventDataPayloadField`) nor the frame meta (`MetaSourceField`).
 * - `Stale`: allowlisted meta fields that no longer exist on any schema.
 *
 * Both must be `never`. Add a field to a @workflow/world event schema
 * without routing it here and the `assertEventDataWireContractExhaustive`
 * call fails to compile with `Type '["theField", never]' does not satisfy
 * the constraint '[never, never]'` — the historical "silently dropped"
 * footgun, now a build break that names the field.
 */
type Unhandled = Exclude<
  EventDataField,
  EventDataPayloadField | MetaSourceField
>;
type Stale = Exclude<MetaSourceField, EventDataField>;
function assertEventDataWireContractExhaustive<
  _Check extends [never, never],
>(): void {
  // Type-level assertion only; the empty body is never relied on.
}
assertEventDataWireContractExhaustive<[Unhandled, Stale]>();

/**
 * Split an AnyEventRequest's `eventData` into (a) the payload bytes that
 * become the v4 frame body and (b) the metadata fields that become the
 * CBOR-encoded meta block of the same frame.
 *
 * Exported for unit tests (the meta allowlist is the eventData wire
 * contract — see the warning on EVENT_DATA_PAYLOAD_FIELD_BY_EVENT_TYPE in
 * @workflow/world).
 */
export function splitEventDataForV4(data: AnyEventRequest): SplitEventData {
  // Some event types in the AnyEventRequest discriminated union (e.g.
  // run_cancelled) have no eventData. Cast through unknown so this
  // helper can read it defensively without TS narrowing per branch.
  const eventData = ((
    data as unknown as { eventData?: Record<string, unknown> }
  ).eventData ?? {}) as Record<string, unknown>;
  const payloadField = getEventDataPayloadField(data.eventType);
  const meta: SplitEventData['meta'] = {};

  if (typeof eventData.deploymentId === 'string') {
    meta.deploymentId = eventData.deploymentId;
  }
  if (typeof eventData.workflowName === 'string') {
    meta.workflowName = eventData.workflowName;
  }
  if (typeof eventData.stepName === 'string') {
    meta.stepName = eventData.stepName;
  }
  if (typeof eventData.attempt === 'number') {
    meta.attempt = eventData.attempt;
  }
  // wait_created passes resumeAt as a Date. cbor-x encodes Date natively
  // (tag 1) and round-trips back to a Date on the server, so the runtime
  // sees a real Date instance when it reads the event back. ISO strings
  // are accepted as a fallback for non-runtime callers.
  if (eventData.resumeAt instanceof Date) {
    meta.resumeAt = eventData.resumeAt;
  } else if (typeof eventData.resumeAt === 'string') {
    const parsed = new Date(eventData.resumeAt);
    if (!Number.isNaN(parsed.getTime())) meta.resumeAt = parsed;
  }
  // step_retrying carries the RetryableError backoff timestamp. The queue
  // enforces the actual retry delay, but the server persists this on the
  // step entity (premature-delivery pacing + observability) — dropping it
  // here would silently disable both.
  if (eventData.retryAfter instanceof Date) {
    meta.retryAfter = eventData.retryAfter;
  } else if (typeof eventData.retryAfter === 'string') {
    const parsed = new Date(eventData.retryAfter);
    if (!Number.isNaN(parsed.getTime())) meta.retryAfter = parsed;
  }
  // Runtime emits hook_created / hook_received / hook_disposed with the
  // hook token in `eventData.token` (matches the world contract in
  // packages/world/src/events.ts). The v4 wire encoding still calls it
  // `hookToken` in the frame meta, so do the rename here.
  if (typeof eventData.token === 'string') {
    meta.hookToken = eventData.token;
  }
  if (typeof eventData.isWebhook === 'boolean') {
    meta.hookIsWebhook = eventData.isWebhook;
  }
  if (typeof eventData.isSystem === 'boolean') {
    meta.hookIsSystem = eventData.isSystem;
  }
  if (typeof eventData.errorCode === 'string') {
    meta.errorCode = eventData.errorCode;
  }
  // run_cancelled optionally carries a free-text cancellation reason. Small
  // plaintext metadata, so it rides in the frame meta like errorCode.
  if (typeof eventData.cancelReason === 'string') {
    meta.cancelReason = eventData.cancelReason;
  }
  // step_started's inline-ownership stamp: the queue message ID of the
  // invocation running this step's body inline. The backend persists it on
  // the step_started event row and re-emits it on event lists so wake
  // replays can observe the active owner — dropping it here would silently
  // disable ownership (replays would requeue in-flight inline steps again).
  if (typeof eventData.ownerMessageId === 'string') {
    meta.ownerMessageId = eventData.ownerMessageId;
  }
  if (
    eventData.executionContext !== undefined &&
    eventData.executionContext !== null &&
    typeof eventData.executionContext === 'object'
  ) {
    meta.executionContext = eventData.executionContext as Record<
      string,
      unknown
    >;
  }
  // Native run attributes (spec v4): initial attributes ride on
  // run_created (and run_started for resilient start); attr_set carries
  // the change list + writer provenance. All of these are structured
  // metadata, not user payloads — they ride in the frame meta and the
  // server validates them against the attribute caps before
  // materializing run.attributes.
  if (
    eventData.attributes !== undefined &&
    eventData.attributes !== null &&
    typeof eventData.attributes === 'object'
  ) {
    meta.attributes = eventData.attributes as Record<string, string>;
  }
  if (Array.isArray(eventData.changes)) {
    meta.changes = eventData.changes as Array<Record<string, unknown>>;
  }
  if (
    eventData.writer !== undefined &&
    eventData.writer !== null &&
    typeof eventData.writer === 'object'
  ) {
    meta.writer = eventData.writer as Record<string, unknown>;
  }
  if (typeof eventData.allowReservedAttributes === 'boolean') {
    meta.allowReservedAttributes = eventData.allowReservedAttributes;
  }
  // Client-measured latency telemetry on step terminal events (TTFS / STSO).
  // The server consumes these for metrics; they are not read back.
  if (typeof eventData.ttfs === 'number') {
    meta.ttfs = eventData.ttfs;
  }
  if (typeof eventData.stso === 'number') {
    meta.stso = eventData.stso;
  }
  if (
    typeof eventData.stepCount === 'number' &&
    Number.isSafeInteger(eventData.stepCount) &&
    eventData.stepCount > 0
  ) {
    meta.stepCount = eventData.stepCount;
  }
  if (
    typeof eventData.eventCount === 'number' &&
    Number.isSafeInteger(eventData.eventCount) &&
    eventData.eventCount > 0
  ) {
    meta.eventCount = eventData.eventCount;
  }
  if (typeof eventData.rsfs === 'number') {
    meta.rsfs = eventData.rsfs;
  }
  if (typeof eventData.finalSchedulingReplay === 'number') {
    meta.finalSchedulingReplay = eventData.finalSchedulingReplay;
  }
  if (
    Array.isArray(eventData.optimizations) &&
    eventData.optimizations.every((o) => typeof o === 'string')
  ) {
    meta.optimizations = eventData.optimizations as string[];
  }

  let payload: Uint8Array | undefined;
  if (payloadField && payloadField in eventData) {
    const value = eventData[payloadField];
    if (value !== undefined) {
      // Payload fields (input / output / result / error / payload /
      // metadata) reach this layer already serialized as Uint8Array — the
      // runtime calls dehydrateRunError / dehydrateStepReturnValue / etc.
      // before invoking events.create. Pass the bytes through unchanged
      // so runs.get and the events stream return the same raw form that
      // hydrateRunError / hydrateStepIO expect. CBOR-encoding here would
      // double-wrap on write and (since runs.get bypasses the v4 frame
      // decode) leave the consumer with cbor(Uint8Array) rather than the
      // devalue blob it was looking for.
      if (!(value instanceof Uint8Array)) {
        // Surface non-Uint8Array values loudly — current SDK callers go
        // through the dehydrate helpers, so anything else is either a
        // legacy caller or a bug.
        throw new TypeError(
          `world-vercel v4: eventData.${payloadField} for ${data.eventType} ` +
            `must be a Uint8Array (the runtime's dehydrated wire form); ` +
            `got ${typeof value === 'object' ? (value === null ? 'null' : ((value as object).constructor?.name ?? typeof value)) : typeof value}.`
        );
      }
      payload = value;
    }
  }

  return { payload, meta };
}

/**
 * Run an assembled event through EventSchema so per-event-type
 * z.coerce.date() (wait_created.resumeAt, wait_completed.resumeAt,
 * step_retrying.retryAfter) converts the ISO strings the backing store
 * returns back into Date instances — the workflow runtime calls .getTime() on
 * these and would otherwise crash. safeParse: pass the event through
 * unchanged if it doesn't match a known shape (legacy / mid-rollout).
 *
 * Used by every path that hands events to the runtime: GET/LIST frames
 * (via buildEventFromV4) and the POST response's `event` / preloaded
 * `events` bag — all of these can carry events read back from the
 * backing store, where nested eventData dates are stored as ISO strings.
 */
function coerceEventDates(raw: Record<string, unknown>): Event {
  const parsed = EventSchema.safeParse(raw);
  if (parsed.success) return parsed.data as unknown as Event;
  if (EventTypeSchema.safeParse(raw.eventType).success) {
    // The raw-event fallback is for unknown/future event types. A parse
    // failure on a *known* type means a schema/coercion regression that
    // would otherwise only surface later as a crash deep in the runtime
    // (e.g. .getTime() on a resumeAt that stayed a string) — leave a
    // breadcrumb at the actual failure point.
    console.debug(
      `[workflow:world-vercel] v4 event ${raw.eventId} failed ` +
        `EventSchema parse for known eventType '${raw.eventType}'; ` +
        `passing through unparsed: ${parsed.error.message}`
    );
  }
  return raw as unknown as Event;
}

function coerceNormalizedEvent(raw: Record<string, unknown>): Event {
  return coerceEventDates(normalizeEventData(raw));
}

function decodeLegacyStructuredError(payload: Uint8Array): unknown {
  if (hasSerializedDataFormatPrefix(payload)) {
    return payload;
  }

  try {
    // cbor-x caches decode state on its input, so decode a copy to keep the
    // raw-byte fallback byte-for-byte and property-for-property unchanged.
    const parsed = StructuredErrorSchema.safeParse(decode(payload.slice()));
    return parsed.success ? parsed.data : payload;
  } catch {
    return payload;
  }
}

/**
 * Turn a v4 event (frame meta + frame body) into the Event shape the
 * workflow runtime expects.
 *
 * Both GET single-event and LIST use the same frame format: meta is the
 * full event entity with the payload field as a RefDescriptor, body is
 * the resolved payload bytes (possibly empty). This helper splices the
 * body bytes into `eventData[fieldName]`, normalizing any zstd wrapper
 * back to the raw devalue-with-format-prefix Uint8Array the runtime's
 * hydrate helpers (hydrateStepIO, hydrateRunError, …) consume. Stable-line
 * structured errors are the exception: the backend stored those as CBOR,
 * so they are decoded after checking that the payload is not a current
 * format-prefixed serialized value.
 */
function buildEventFromV4(
  decoded: DecodedV4Event,
  payloadBody: Uint8Array,
  resolveData: 'none' | 'all'
): Event {
  const eventData = (decoded.eventData ?? {}) as Record<string, unknown>;

  if (payloadBody.byteLength > 0) {
    const payloadField = getEventDataPayloadField(decoded.eventType);
    const normalizedPayload = normalizeSerializedData(payloadBody);
    if (payloadField && normalizedPayload instanceof Uint8Array) {
      eventData[payloadField] = legacyStructuredErrorEventTypes.has(
        decoded.eventType
      )
        ? decodeLegacyStructuredError(normalizedPayload)
        : normalizedPayload;
    }
  }

  const raw = {
    eventId: decoded.eventId,
    runId: decoded.runId,
    eventType: decoded.eventType,
    createdAt:
      decoded.createdAt instanceof Date
        ? decoded.createdAt
        : new Date(decoded.createdAt),
    ...(decoded.occurredAt !== undefined
      ? {
          occurredAt:
            decoded.occurredAt instanceof Date
              ? decoded.occurredAt
              : new Date(decoded.occurredAt),
        }
      : {}),
    ...(decoded.correlationId ? { correlationId: decoded.correlationId } : {}),
    eventData,
    ...(decoded.specVersion !== undefined
      ? { specVersion: decoded.specVersion }
      : {}),
  };

  const event = coerceNormalizedEvent(raw);

  // For resolveData='none', strip eventData entirely. Reuse the world-
  // side helper so behavior stays in sync with other backends.
  return resolveData === 'none' ? stripEventDataRefs(event, 'none') : event;
}

// =============================================================================
// Public API
// =============================================================================

export async function getEvent(
  runId: string,
  eventId: string,
  params?: GetEventParams,
  config?: APIConfig
): Promise<Event> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const { event, body } = await getEventV4(runId, eventId, config);
  // Same shape as a LIST frame — splice the body bytes into
  // eventData[payloadField] in buildEventFromV4.
  return buildEventFromV4(event, body, resolveData);
}

export async function getWorkflowRunEvents(
  params: ListEventsParams | ListEventsByCorrelationIdParams,
  config?: APIConfig
): Promise<PaginatedResponse<Event>> {
  const { pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION } = params;
  // `resolveData: 'none'` means the caller only wants metadata — it discards
  // payloads in buildEventFromV4 below. Tell the backend not to stream them
  // in the first place (lazy → empty frame bodies). On `'all'` we resolve
  // (the default). A backend that predates this flag ignores it and streams
  // full bodies regardless; buildEventFromV4 still strips them when
  // resolveData is 'none', so this is purely a bandwidth optimization and is
  // safe against an older backend.
  const wirePagination = {
    cursor: pagination?.cursor ?? undefined,
    limit: pagination?.limit,
    sortOrder: pagination?.sortOrder,
    remoteRefBehavior: (resolveData === 'none' ? 'lazy' : 'resolve') as
      | 'lazy'
      | 'resolve',
  };

  const result = await ('correlationId' in params
    ? getEventsByCorrelationIdV4(params.correlationId, wirePagination, config)
    : getWorkflowRunEventsV4(params.runId, wirePagination, config));

  const events = result.events.map((listed) =>
    buildEventFromV4(listed.event, listed.body, resolveData)
  );

  return {
    data: events,
    // `next` is present even on the final page (it's the incremental-load
    // resume cursor), so prefer the server's explicit `hasMore`. The
    // `Boolean(next)` fallback covers older servers that don't emit it —
    // at the cost of one extra empty-page request per load.
    cursor: result.next ?? null,
    hasMore:
      typeof result.hasMore === 'boolean'
        ? result.hasMore
        : Boolean(result.next),
  } as PaginatedResponse<Event>;
}

export async function createWorkflowRunEvent(
  id: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams,
  config?: APIConfig
): Promise<EventResult> {
  try {
    // Retry transient transport failures (UND_ERR_REQ_RETRY, ECONNRESET,
    // socket/headers timeouts, transient 5xx) in-process for event types that
    // are idempotent-on-retry. A write that landed but whose response was lost
    // re-surfaces as a 409 (or plain success for run_started/attr_set) the
    // callers already handle, so this avoids a needless step re-execution on
    // the next queue delivery. Non-retryable
    // types (step_started, step_retrying, hook_received) run once. See
    // ./event-retry for the validated per-event classification.
    return await withEventPostRetry(
      () => createWorkflowRunEventInner(id, data, params, config),
      data.eventType
    );
  } catch (err) {
    // 404 on hook_disposed / hook_received → already-disposed hook.
    if (
      isHookEventRequiringExistence(data.eventType) &&
      WorkflowWorldError.is(err) &&
      err.status === 404 &&
      data.correlationId
    ) {
      throw new HookNotFoundError(data.correlationId);
    }
    throw err;
  }
}

async function createWorkflowRunEventInner(
  id: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams,
  config?: APIConfig
): Promise<EventResult> {
  // v1Compat: caller wants the legacy entity-mutation endpoints (used
  // for legacy spec-version runs that predate event sourcing). Keep all
  // of this on v1 routes — the v4 protocol does not cover legacy runs.
  if (params?.v1Compat) {
    if (data.eventType === 'run_cancelled' && id) {
      const run = await cancelWorkflowRunV1(id, params, config);
      return { run: run as WorkflowRun };
    }
    if (data.eventType === 'run_created') {
      const run = await createWorkflowRunV1(data.eventData, config);
      return { run };
    }
    if (id === null) {
      throw new WorkflowWorldError(
        `world-vercel: v1Compat=true requires a runId for ${data.eventType}`,
        { status: 400 }
      );
    }
    // Catch-all for the remaining event types the runtime still emits
    // against legacy runs (hook_received via resumeHook, wait_completed
    // via wakeUpRun): POST to the legacy v1 events endpoint, same as the
    // pre-v4 client did.
    const wireResult = await makeRequest({
      endpoint: `/v1/runs/${encodeURIComponent(id)}/events`,
      options: { method: 'POST' },
      data,
      config,
      schema: EventSchema,
    });
    return { event: wireResult };
  }

  if (id === null) {
    throw new WorkflowWorldError(
      'world-vercel v4: createWorkflowRunEvent requires a client-generated ' +
        'runId for run_created (the runId is part of the payload storage ' +
        'ref key). Generate a wrun_ ULID before calling.',
      { status: 400 }
    );
  }

  // Defensive check for client-generated run_created IDs that ride too
  // far ahead of wall-clock time — same threshold the v3 path enforced.
  if (data.eventType === 'run_created') {
    const validationError = validateWorkflowRunIdTimestamp(id);
    if (validationError) {
      throw new WorkflowWorldError(validationError, { status: 400 });
    }
  }

  const remoteRefBehavior = eventsNeedingResolve.has(data.eventType)
    ? 'resolve'
    : 'lazy';

  const { payload, meta } = splitEventDataForV4(data);

  const result = await createWorkflowRunEventV4(
    {
      runId: id,
      eventType: data.eventType,
      specVersion: data.specVersion ?? 2,
      ...(data.correlationId ? { correlationId: data.correlationId } : {}),
      ...(params?.requestId ? { vercelId: params.requestId } : {}),
      ...(params?.stateUpdatedAt !== undefined
        ? { stateUpdatedAt: params.stateUpdatedAt }
        : {}),
      occurredAt: params?.occurredAt ?? new Date(),
      // Opt-in inline-delta: forward the cursor the runtime held before
      // this write so the server can return the authoritative event-log
      // delta on the response (events/cursor/hasMore), letting the inline
      // loop skip a follow-up events.list. The server only acts on it for
      // step_completed/step_failed; older servers ignore it and the runtime
      // falls back to events.list.
      ...(params?.sinceCursor ? { sinceCursor: params.sinceCursor } : {}),
      // Run-started preload opt-out: turbo backgrounds run_started as a write
      // barrier only and never reads the preloaded log, so tell the server to
      // skip the list+resolve. The server only acts on it for run_started;
      // older servers ignore it and simply preload as before.
      ...(params?.skipPreload ? { skipPreload: true } : {}),
      remoteRefBehavior,
      payload,
      ...meta,
    },
    config
  );

  // The server already CBOR-decoded into result.body — just thread the
  // fields through. This is the runtime's event-append path (world.events
  // .create is only ever called from the workflow runtime, never from
  // o11y), and the runtime re-hydrates every payload it consumes through
  // the decompress-aware helpers (hydrateStepReturnValue, hydrateRunError,
  // …). So we deliberately do NOT decompress here: doing so would be
  // redundant work on the TTFB-sensitive run_started/inline-delta path and
  // would make the runtime's deserialize compression telemetry report
  // `codec: none` for payloads that were compressed at rest. gzip/zstd
  // normalization for o11y/display lives on the read paths (getEvent,
  // getWorkflowRunEvents, getStep, getRun, getHook).
  //
  // `event`/`events` go through coerceEventDates only: they can be read
  // back from the backing store server-side (e.g. the run_started TTFB
  // preload queries the event log), where nested eventData dates are ISO
  // strings — same coercion the GET/LIST path applies. The returned event
  // honors the caller's resolveData: 'none' strips payload fields,
  // matching the v3 path's stripEventAndLegacyRefs behavior.
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
  const body = result.body;
  return {
    event: body.event
      ? stripEventDataRefs(
          coerceEventDates(body.event as Record<string, unknown>),
          resolveData
        )
      : undefined,
    run: body.run
      ? deserializeError<WorkflowRun>(body.run as Record<string, unknown>)
      : undefined,
    step: body.step
      ? deserializeStep(body.step as Parameters<typeof deserializeStep>[0])
      : undefined,
    hook: body.hook as EventResult['hook'],
    wait: body.wait as EventResult['wait'],
    events: body.events
      ? (body.events as Record<string, unknown>[]).map(coerceEventDates)
      : undefined,
    cursor: body.cursor ?? undefined,
    hasMore: body.hasMore,
    // Lazy step start: thread the server's "I created the step on this call"
    // signal through so the owned-inline runtime path can gate body execution
    // on it. Absent from older servers → undefined → safe default.
    ...(body.stepCreated ? { stepCreated: true } : {}),
  };
}
