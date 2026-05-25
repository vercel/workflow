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
 * opaque user payload, never CBOR-decoded by the server. See
 * workflow-server/lib/handlers/v4/ for the matching server-side handlers
 * and ../events-v4.ts for the wire-level client.
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
 *     frame whose meta carries `{_end: 1, next?: cursor}`. The old
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
  type EventResult,
  type GetEventParams,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type PaginatedResponse,
  stripEventDataRefs,
  validateUlidTimestamp,
  type WorkflowRun,
} from '@workflow/world';
import {
  createWorkflowRunEventV4,
  type DecodedV4Event,
  getEventsByCorrelationIdV4,
  getEventV4,
  getWorkflowRunEventsV4,
} from './events-v4.js';
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import { deserializeStep } from './steps.js';
import {
  type APIConfig,
  DEFAULT_RESOLVE_DATA_OPTION,
  deserializeError,
} from './utils.js';

/**
 * Per-event-type map of the field within `eventData` that holds the user
 * payload. Same convention used on the server side
 * (workflow-server/lib/handlers/v4/events.ts PAYLOAD_FIELD_BY_EVENT_TYPE).
 *
 * The v4 wire encoding picks this field out of `eventData`, CBOR-encodes
 * its value, and ships it as the frame body. Everything else in
 * `eventData` rides in the frame's CBOR meta block.
 */
const PAYLOAD_FIELD_BY_EVENT_TYPE: Record<string, string> = {
  run_created: 'input',
  run_completed: 'output',
  run_failed: 'error',
  step_created: 'input',
  step_completed: 'result',
  step_failed: 'error',
  step_retrying: 'error',
  hook_created: 'metadata',
  hook_received: 'payload',
};

// Events whose POST response the workflow runtime reads immediately
// (so the materialized entity must come back fully resolved).
const eventsNeedingResolve = new Set<string>([
  'run_created', // runtime reads result.run.runId
  'run_started', // runtime reads result.run (checks startedAt, status)
  'step_started', // runtime reads result.step (checks attempt, state)
]);

// Hook events that 404 when the hook is already disposed or never existed —
// translate to a typed HookNotFoundError so the runtime can branch on it.
const hookEventsRequiringExistence = new Set<string>([
  'hook_disposed',
  'hook_received',
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
    resumeAt?: string;
    hookToken?: string;
    hookIsWebhook?: boolean;
    hookIsSystem?: boolean;
    errorCode?: string;
    /** Structured executionContext, included verbatim in frame meta. */
    executionContext?: Record<string, unknown>;
  };
}

/**
 * Split an AnyEventRequest's `eventData` into (a) the payload bytes that
 * become the v4 frame body and (b) the metadata fields that become the
 * CBOR-encoded meta block of the same frame.
 */
function splitEventDataForV4(data: AnyEventRequest): SplitEventData {
  // Some event types in the AnyEventRequest discriminated union (e.g.
  // run_cancelled) have no eventData. Cast through unknown so this
  // helper can read it defensively without TS narrowing per branch.
  const eventData = ((
    data as unknown as { eventData?: Record<string, unknown> }
  ).eventData ?? {}) as Record<string, unknown>;
  const payloadField = PAYLOAD_FIELD_BY_EVENT_TYPE[data.eventType];
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
  if (typeof eventData.resumeAt === 'string') {
    meta.resumeAt = eventData.resumeAt;
  } else if (eventData.resumeAt instanceof Date) {
    meta.resumeAt = eventData.resumeAt.toISOString();
  }
  if (typeof eventData.hookToken === 'string') {
    meta.hookToken = eventData.hookToken;
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
 * Turn a v4 event (frame meta + frame body) into the Event shape the
 * workflow runtime expects.
 *
 * Both GET single-event and LIST use the same frame format: meta is the
 * full event entity with the payload field as a RefDescriptor, body is
 * the resolved payload bytes (possibly empty). This helper splices the
 * body bytes into `eventData[fieldName]` unchanged — the runtime's
 * hydrate helpers (hydrateStepIO, hydrateRunError, …) consume the raw
 * devalue-with-format-prefix Uint8Array directly. No CBOR decode here,
 * symmetric with the pass-through write in `splitEventDataForV4`.
 */
function buildEventFromV4(
  decoded: DecodedV4Event,
  payloadBody: Uint8Array,
  resolveData: 'none' | 'all'
): Event {
  const eventData = (decoded.eventData ?? {}) as Record<string, unknown>;

  if (payloadBody.byteLength > 0) {
    const payloadField = PAYLOAD_FIELD_BY_EVENT_TYPE[decoded.eventType];
    if (payloadField) eventData[payloadField] = payloadBody;
  }

  const event = {
    eventId: decoded.eventId,
    runId: decoded.runId,
    eventType: decoded.eventType,
    createdAt:
      decoded.createdAt instanceof Date
        ? decoded.createdAt
        : new Date(decoded.createdAt),
    ...(decoded.correlationId ? { correlationId: decoded.correlationId } : {}),
    eventData,
    ...(decoded.specVersion !== undefined
      ? { specVersion: decoded.specVersion }
      : {}),
  } as unknown as Event;

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
  const wirePagination = {
    cursor: pagination?.cursor ?? undefined,
    limit: pagination?.limit,
    sortOrder: pagination?.sortOrder,
  };

  const result = await ('correlationId' in params
    ? getEventsByCorrelationIdV4(params.correlationId, wirePagination, config)
    : getWorkflowRunEventsV4(params.runId, wirePagination, config));

  const events = result.events.map((listed) =>
    buildEventFromV4(listed.event, listed.body, resolveData)
  );

  return {
    data: events,
    cursor: result.next ?? null,
    hasMore: Boolean(result.next),
  } as PaginatedResponse<Event>;
}

export async function createWorkflowRunEvent(
  id: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams,
  config?: APIConfig
): Promise<EventResult> {
  try {
    return await createWorkflowRunEventInner(id, data, params, config);
  } catch (err) {
    // 404 on hook_disposed / hook_received → already-disposed hook.
    if (
      hookEventsRequiringExistence.has(data.eventType) &&
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
  // for migrating SDKs that haven't switched to event sourcing yet).
  // Keep this on v1 routes — the v4 protocol does not cover it.
  if (params?.v1Compat) {
    if (data.eventType === 'run_cancelled' && id) {
      const run = await cancelWorkflowRunV1(id, params, config);
      return { run: run as WorkflowRun };
    }
    if (data.eventType === 'run_created') {
      const run = await createWorkflowRunV1(data.eventData, config);
      return { run };
    }
    throw new Error(
      `world-vercel: v1Compat=true is only supported for run_created ` +
        `and run_cancelled, not ${data.eventType}`
    );
  }

  if (id === null) {
    throw new WorkflowWorldError(
      'world-vercel v4: createWorkflowRunEvent requires a client-generated ' +
        'runId for run_created (the runId is part of the S3 ref key). ' +
        'Generate a wrun_ ULID before calling.',
      { status: 400 }
    );
  }

  // Defensive check for client-generated run_created IDs that ride too
  // far ahead of wall-clock time — same threshold the v3 path enforced.
  if (data.eventType === 'run_created') {
    const validationError = validateUlidTimestamp(id, 'wrun_');
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
      remoteRefBehavior,
      payload,
      ...meta,
    },
    config
  );

  // The server already CBOR-decoded into result.body — just thread the
  // fields through. Step has a wire-format adapter; runs use the
  // pass-through deserializeError helper.
  const body = result.body;
  return {
    event: body.event as Event | undefined,
    run: body.run
      ? deserializeError<WorkflowRun>(body.run as Record<string, unknown>)
      : undefined,
    step: body.step
      ? deserializeStep(body.step as Parameters<typeof deserializeStep>[0])
      : undefined,
    hook: body.hook as EventResult['hook'],
    events: body.events as EventResult['events'],
    cursor: body.cursor ?? undefined,
    hasMore: body.hasMore,
  };
}
