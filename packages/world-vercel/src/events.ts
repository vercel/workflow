/**
 * world-vercel event functions — v4 wire format throughout.
 *
 * This module replaces the previous v2/v3 implementation. The v4 wire
 * format moves structured event metadata into `x-wf-*` HTTP headers and
 * treats payloads as opaque user-data bytes streamed end-to-end. See
 * workflow-server/lib/handlers/v4/ for the matching server-side handlers
 * and ../events-v4.ts for the wire-level client.
 *
 * Key shape changes vs. v2/v3:
 *
 *   - POST event response carries the materialized EventResult
 *     (event/run/step/hook/wait/events/cursor/hasMore) as a CBOR-encoded
 *     body — the server resolved-refs path is still respected via the
 *     `remoteRefBehavior` header.
 *   - GET single event returns metadata in headers + the user payload
 *     bytes in the response body.
 *   - LIST events returns a length-prefixed binary frame stream
 *     (application/vnd.workflow.v4-frames) — one frame per event with
 *     CBOR metadata + raw payload bytes. The old per-event `/refs`
 *     round-trip is eliminated.
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
import { decode, encode } from 'cbor-x';
import {
  createWorkflowRunEventV4,
  getEventV4,
  getWorkflowRunEventsV4,
  type ListedEventV4,
} from './events-v4.js';
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import { deserializeStep } from './steps.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  type APIConfig,
  deserializeError,
} from './utils.js';

/**
 * Per-event-type map of the field within `eventData` that holds the user
 * payload. Same convention used on the server side
 * (workflow-server/lib/handlers/v4/events.ts PAYLOAD_FIELD_BY_EVENT_TYPE).
 *
 * The v4 wire encoding picks this field out of `eventData`, CBOR-encodes
 * its value, and ships it as the request body. Everything else in
 * `eventData` becomes a `x-wf-*` header.
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
  /** Metadata fields that ride in v4 request headers. */
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
    /** Pre-encoded base64 CBOR of executionContext (or undefined). */
    executionContextB64?: string;
  };
}

/**
 * Split an AnyEventRequest's `eventData` into (a) the payload bytes that
 * become the v4 request body and (b) the metadata fields that become
 * v4 request headers.
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
    eventData.executionContext !== null
  ) {
    const cbor = encode(eventData.executionContext);
    meta.executionContextB64 = Buffer.from(cbor).toString('base64');
  }

  let payload: Uint8Array | undefined;
  if (payloadField && payloadField in eventData) {
    const value = eventData[payloadField];
    if (value instanceof Uint8Array) {
      payload = value;
    } else if (value !== undefined) {
      // CBOR-encode arbitrary JS values. The server treats the bytes as
      // opaque; the SDK reverses this at decode time so the wire layer
      // doesn't know about CBOR.
      payload = new Uint8Array(encode(value));
    }
  }

  return { payload, meta };
}

/**
 * Turn a v4 single-event response (metadata in headers + opaque body
 * bytes) into the Event shape the workflow runtime expects.
 *
 * Reconstructs `eventData` from header fields and places the CBOR-decoded
 * payload value (if any) under the appropriate per-event-type field.
 */
function buildEventFromV4(
  meta: Omit<ListedEventV4, 'body'>,
  body: Uint8Array,
  resolveData: 'none' | 'all'
): Event {
  const eventData: Record<string, unknown> = {};
  if (meta.workflowName) eventData.workflowName = meta.workflowName;
  if (meta.stepName) eventData.stepName = meta.stepName;
  if (meta.attempt !== undefined) eventData.attempt = meta.attempt;
  if (meta.deploymentId) eventData.deploymentId = meta.deploymentId;
  if (meta.errorCode) eventData.errorCode = meta.errorCode;

  if (resolveData === 'all' && body.byteLength > 0) {
    const payloadField = PAYLOAD_FIELD_BY_EVENT_TYPE[meta.eventType];
    if (payloadField) {
      try {
        eventData[payloadField] = decode(body);
      } catch {
        // CBOR decode failure — fall back to the raw bytes so callers
        // can still inspect the payload if they know its format.
        eventData[payloadField] = body;
      }
    }
  }

  const event = {
    eventId: meta.eventId,
    runId: meta.runId,
    eventType: meta.eventType,
    createdAt: new Date(meta.createdAt),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    eventData,
  } as unknown as Event;

  // For resolveData='none', strip eventData entirely. Use the existing
  // world-side helper so behavior stays in sync with other backends.
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
  const result = await getEventV4(runId, eventId, config);
  const { body, ...meta } = result;
  return buildEventFromV4(meta, body, resolveData);
}

export async function getWorkflowRunEvents(
  params: ListEventsParams | ListEventsByCorrelationIdParams,
  config?: APIConfig
): Promise<PaginatedResponse<Event>> {
  const { pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION } = params;
  if ('correlationId' in params) {
    // v4 has no list-by-correlation-id endpoint yet. Throw a clear error
    // until a server-side endpoint lands — callers that hit this path
    // historically used the by-correlation-id query for hook lookup and
    // can be migrated to direct hook fetches.
    throw new Error(
      'world-vercel v4: listEventsByCorrelationId is not yet implemented. ' +
        'Fetch the hook directly via storage.hooks.getByToken or use ' +
        'storage.events.list(runId) on a known run.'
    );
  }

  const result = await getWorkflowRunEventsV4(
    params.runId,
    {
      cursor: pagination?.cursor ?? undefined,
      limit: pagination?.limit,
      sortOrder: pagination?.sortOrder,
    },
    config
  );

  const events = result.events.map((listed) => {
    const { body, ...meta } = listed;
    return buildEventFromV4(meta, body, resolveData);
  });

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
