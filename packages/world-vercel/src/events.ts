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
 *     a materialized EventResult. `run_started` instead returns the current
 *     event log using the same frame stream as LIST; other events use CBOR.
 *   - GET single event returns one v4 frame: the event entity in the
 *     frame meta, the user payload bytes in the frame body.
 *   - LIST events returns a stream of v4 frames terminated by a sentinel
 *     frame whose meta carries `{_end: 1, next?: cursor, hasMore: boolean}`.
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
  applyAttributeChanges,
  type CreateEventParams,
  type Event,
  type EventDataPayloadField,
  type EventResult,
  EventSchema,
  type GetEventParams,
  getEventDataPayloadField,
  isHookEventRequiringExistence,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type PaginatedResponse,
  type StartHook,
  validateUlidTimestamp,
  type WorkflowRun,
} from '@workflow/world';
import { withEventPostRetry } from './event-retry.js';
import {
  createHookReceivedPreloadEventV4,
  createWorkflowRunEventV4,
  createWorkflowRunStartedEventV4,
  getEventsByCorrelationIdV4,
  getEventV4,
  getWorkflowRunEventsV4,
  type ListEventsV4Params,
} from './events-v4.js';
import { decode as decodeRunId } from './run-id/index.js';
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import {
  type APIConfig,
  DEFAULT_RESOLVE_DATA_OPTION,
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
    hookTokenRetentionUntil?: Date;
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
    /** Atomic start Hook admission data. */
    startHook?: StartHook;
    /** attr_set change list, included verbatim in frame meta. */
    changes?: Array<Record<string, unknown>>;
    /** attr_set writer provenance, included verbatim in frame meta. */
    writer?: Record<string, unknown>;
    /** Reserved-attribute-key opt-in (attr_set / run_created / run_started). */
    allowReservedAttributes?: boolean;
    /**
     * The run's X25519 public key, base64 (run_created / resilient-start
     * run_started). Plaintext metadata, not a payload: it is not secret, and
     * the server stores it on the run entity so cross-run writers can seal to
     * it without holding the run's symmetric key.
     */
    encryptionPublicKey?: string;
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
  | 'tokenRetentionUntil'
  | 'isWebhook'
  | 'isSystem'
  | 'errorCode'
  | 'cancelReason'
  | 'ownerMessageId'
  | 'executionContext'
  | 'attributes'
  | 'startHook'
  | 'changes'
  | 'writer'
  | 'allowReservedAttributes'
  | 'encryptionPublicKey'
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
  // This new World field is Date-only; unlike legacy date fields above, it
  // does not need an ISO string fallback.
  if (eventData.tokenRetentionUntil instanceof Date) {
    meta.hookTokenRetentionUntil = eventData.tokenRetentionUntil;
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
  if (eventData.startHook !== undefined) {
    meta.startHook = eventData.startHook as StartHook;
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
  if (typeof eventData.encryptionPublicKey === 'string') {
    meta.encryptionPublicKey = eventData.encryptionPublicKey;
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

// =============================================================================
// Public API
// =============================================================================

export async function getEvent(
  runId: string,
  eventId: string,
  params?: GetEventParams,
  config?: APIConfig
): Promise<Event> {
  return getEventV4(
    runId,
    eventId,
    params?.resolveData === 'none' ? 'lazy' : 'resolve',
    config
  );
}

export async function getWorkflowRunEvents(
  params: ListEventsParams | ListEventsByCorrelationIdParams,
  config?: APIConfig
): Promise<PaginatedResponse<Event>> {
  const { pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION } = params;
  // `resolveData: 'none'` leaves payload refs unresolved, so the backend can
  // skip reading and streaming their contents. The validated lazy descriptors
  // remain on the returned events.
  const listParams: ListEventsV4Params = {
    ...pagination,
    remoteRefBehavior: resolveData === 'none' ? 'lazy' : 'resolve',
  };

  const result = await ('correlationId' in params
    ? getEventsByCorrelationIdV4(
        params.correlationId,
        params.runId,
        listParams,
        config
      )
    : getWorkflowRunEventsV4(params.runId, listParams, config));

  // A correlation id is unique per run, not globally — a slot-numbered run
  // numbers its own steps, so `step_…001` names the first step of every such
  // run. The run id scopes the backend query; the filter also protects against
  // an older backend that ignores that parameter.
  // `hasMore`/`cursor` stay the backend's, so a page that filters down to
  // nothing is still followed by the next one.
  return {
    data:
      'correlationId' in params
        ? result.events.filter((event) => event.runId === params.runId)
        : result.events,
    // The cursor is present even on the final page because it is also the
    // incremental-load resume point. `hasMore` is the pagination signal.
    cursor: result.cursor,
    hasMore: result.hasMore,
  };
}

export async function createWorkflowRunEvent<T extends AnyEventRequest>(
  id: string | null,
  data: T,
  params?: CreateEventParams,
  config?: APIConfig
): Promise<EventResult<T['eventType']>> {
  try {
    // Retry transient transport failures (UND_ERR_REQ_RETRY, ECONNRESET,
    // socket/headers timeouts, transient 5xx) in-process for event types that
    // are idempotent-on-retry. A write that landed but whose response was lost
    // re-surfaces as a 409 (or plain success for run_started/attr_set) the
    // callers already handle, so this avoids a needless step re-execution on
    // the next queue delivery. Non-retryable
    // types (step_started, step_retrying, hook_received) run once. See
    // ./event-retry for the validated per-event classification.
    const result = await withEventPostRetry(
      () => createWorkflowRunEventInner(id, data, params, config),
      data.eventType,
      {
        // The atomic lazy-resume shape is deduplicated server-side by the
        // (runId, resumeId) claim, so its POST is idempotent-on-retry even
        // though plain hook_received is not — see EVENT_RETRY_ELIGIBILITY.
        idempotentHookResume:
          data.eventType === 'hook_received' &&
          params?.resumeId !== undefined &&
          params?.resumePayloadDigest !== undefined,
      }
    );
    if (data.eventType === 'run_created' && !result.run) {
      throw new WorkflowWorldError(
        `${data.eventType} response is missing the run entity`,
        { code: 'SCHEMA_VALIDATION' }
      );
    }
    if (data.eventType === 'run_started' && !result.run?.startedAt) {
      throw new WorkflowWorldError(
        'run_started response is missing run.startedAt',
        { code: 'SCHEMA_VALIDATION' }
      );
    }
    if (data.eventType === 'step_started' && !result.step?.startedAt) {
      throw new WorkflowWorldError(
        'step_started response is missing step.startedAt',
        { code: 'SCHEMA_VALIDATION' }
      );
    }
    return result as EventResult<T['eventType']>;
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

  const remoteRefBehavior: 'resolve' | 'lazy' = eventsNeedingResolve.has(
    data.eventType
  )
    ? 'resolve'
    : 'lazy';

  const { payload, meta } = splitEventDataForV4(data);

  const input = {
    runId: id,
    specVersion: data.specVersion ?? 2,
    ...(data.correlationId ? { correlationId: data.correlationId } : {}),
    ...(params?.requestId ? { vercelId: params.requestId } : {}),
    ...(params?.computeInstanceId
      ? { computeInstanceId: params.computeInstanceId }
      : {}),
    stateUpdatedAt: params?.stateUpdatedAt,
    stateEventCount: params?.stateEventCount,
    ...(params?.stateCursor ? { stateCursor: params.stateCursor } : {}),
    // Slot-identity snapshot. The runtime sends `eventCount` instead of the
    // watermark triple once the run's own ids are slot-shaped; it rides as
    // `maxSlot` because the v4 meta already has an unrelated telemetry
    // `eventCount`.
    ...(params?.eventCount !== undefined ? { maxSlot: params.eventCount } : {}),
    replayDivergenceCount: params?.replayDivergenceCount,
    occurredAt: params?.occurredAt ?? new Date(),
    // Opt-in inline-delta: forward the cursor the runtime held before
    // this write so the server can return the authoritative event-log
    // delta on the response (events/cursor/hasMore), letting the caller
    // skip a follow-up events.list. Outside turbo the runtime sends this on
    // every write, but a server may act on only some event types (or none);
    // a response without a delta just means the runtime keeps its cursor
    // and fetches when it next needs to.
    ...(params?.sinceCursor ? { sinceCursor: params.sinceCursor } : {}),
    ...(params?.resumeId ? { resumeId: params.resumeId } : {}),
    ...(params?.resumePayloadDigest
      ? { resumePayloadDigest: params.resumePayloadDigest }
      : {}),
    // Resilient step dispatch re-ensure marker (step_created only). Advisory
    // — the server MAY refuse it with 410 → RunExpiredError as
    // defense-in-depth when it recorded a 412 rejection for this correlation
    // id and no step entity exists.
    ...(params?.viaStepDispatch ? { viaStepDispatch: true } : {}),
    remoteRefBehavior,
    payload,
    ...meta,
  };

  if (data.eventType === 'run_started' && !params?.skipPreload) {
    const result = await createWorkflowRunStartedEventV4(input, config);
    const runCreated = result.events.find(
      (event) => event.eventType === 'run_created'
    );
    const runStarted = result.events.find(
      (event) => event.eventType === 'run_started'
    );
    if (!runCreated) {
      throw new Error(
        'v4 createEvent: run_started stream is missing run_created'
      );
    }
    if (!runStarted) {
      throw new Error(
        'v4 createEvent: run_started stream is missing run_started'
      );
    }

    let attributes = runCreated.eventData.attributes ?? {};
    let updatedAt = runStarted.createdAt;
    for (const event of result.events) {
      if (event.eventType === 'attr_set') {
        attributes = applyAttributeChanges(attributes, event.eventData.changes);
        updatedAt = event.createdAt;
      }
    }

    return {
      event: runStarted,
      run: {
        runId: runCreated.runId,
        status: 'running',
        deploymentId: runCreated.eventData.deploymentId,
        workflowName: runCreated.eventData.workflowName,
        specVersion: runCreated.specVersion,
        executionContext: runCreated.eventData.executionContext,
        input: runCreated.eventData.input,
        attributes,
        encryptionPublicKey: runCreated.eventData.encryptionPublicKey,
        startedAt: runStarted.createdAt,
        createdAt: runCreated.createdAt,
        updatedAt,
      },
      events: result.events,
      cursor: result.cursor,
      hasMore: result.hasMore,
      maxEvents: result.maxEvents,
    };
  }

  if (
    data.eventType === 'hook_received' &&
    params?.preloadEvents === true &&
    params.resumeId !== undefined &&
    params.resumePayloadDigest !== undefined
  ) {
    // Lazy hook resume: the queue consumer's idempotent re-ensure doubles
    // as the invocation's setup request. A supporting server streams the
    // complete replay log back in this response with resolved frame bodies
    // — the SERVER owns that resolution (the preload contract requires
    // replay-ready bytes; v4 has no /refs endpoint to hydrate a lazy
    // descriptor during replay), so the request keeps hook_received's lazy
    // default. Against an older server this makes the CBOR fallback
    // lightweight: it answers the mutation without resolving and echoing
    // an S3-backed hook payload the runtime would discard anyway.
    const outcome = await createHookReceivedPreloadEventV4(
      { ...input, remoteRefBehavior: 'lazy' },
      config
    );
    if (outcome.kind === 'materialized') {
      // Older server (or optimization declined): the write still succeeded
      // and this is its normal materialized result. The runtime sees no
      // replay preload on it and falls back to the run_started setup.
      return outcome.result;
    }
    const { canonicalEventId, maxEvents, events, cursor, hasMore } = outcome;
    const canonicalEvent = events.find(
      (event) => event.eventId === canonicalEventId
    );
    // Unlike lifecycle streams, a preload missing run_created/run_started is
    // not fatal here: the write has already converged, so return the page
    // without a run and let the runtime take its safe fallback.
    const run = reconstructRunFromReplayEvents(events);
    return {
      ...(canonicalEvent ? { event: canonicalEvent } : {}),
      ...(run ? { run } : {}),
      events,
      cursor,
      hasMore,
      ...(maxEvents !== undefined ? { maxEvents } : {}),
    };
  }

  return createWorkflowRunEventV4(
    data.eventType === 'run_started'
      ? { ...input, eventType: 'run_started', skipPreload: true }
      : { ...input, eventType: data.eventType },
    config
  );
}

/**
 * Reconstruct the run entity from a streamed replay log: identity and input
 * from `run_created`, start time from `run_started`, later `attr_set` events
 * folded into `attributes`/`updatedAt`. Returns undefined when the log does
 * not contain both lifecycle events (the caller decides whether that is
 * fatal). The reconstructed status is always `running` — a terminal event
 * committed concurrently still rides in the log itself, and the runtime's
 * replay-time terminal detection handles it.
 */
function reconstructRunFromReplayEvents(
  events: Event[]
): (WorkflowRun & { startedAt: Date }) | undefined {
  const runCreated = events.find((event) => event.eventType === 'run_created');
  const runStarted = events.find((event) => event.eventType === 'run_started');
  if (!runCreated || !runStarted) {
    return undefined;
  }

  let attributes = runCreated.eventData.attributes ?? {};
  let updatedAt = runStarted.createdAt;
  for (const event of events) {
    if (event.eventType === 'attr_set') {
      attributes = applyAttributeChanges(attributes, event.eventData.changes);
      updatedAt = event.createdAt;
    }
  }

  return {
    runId: runCreated.runId,
    status: 'running',
    deploymentId: runCreated.eventData.deploymentId,
    workflowName: runCreated.eventData.workflowName,
    specVersion: runCreated.specVersion,
    executionContext: runCreated.eventData.executionContext,
    input: runCreated.eventData.input,
    attributes,
    encryptionPublicKey: runCreated.eventData.encryptionPublicKey,
    startedAt: runStarted.createdAt,
    createdAt: runCreated.createdAt,
    updatedAt,
  };
}
