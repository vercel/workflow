import {
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventResult,
  EventSchema,
  EventTypeSchema,
  HookSchema,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type PaginatedResponse,
  PaginatedResponseSchema,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@workflow/world';
import z from 'zod';
import {
  isRefDescriptor,
  type RefDescriptor,
  type RefWithRunId,
  resolveRefDescriptors,
} from './refs.js';
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import { deserializeStep, StepWireSchema } from './steps.js';
import { trace } from './telemetry.js';
import type { APIConfig } from './utils.js';
import { DEFAULT_RESOLVE_DATA_OPTION, makeRequest } from './utils.js';

// Helper to filter event data based on resolveData setting.
// Strips both eventData and eventDataRef since the server always returns
// lazy refs now, and callers with resolveData='none' should not see either.
function filterEventData(event: any, resolveData: 'none' | 'all'): Event {
  if (resolveData === 'none') {
    const {
      eventData: _eventData,
      eventDataRef: _eventDataRef,
      ...rest
    } = event;
    return rest;
  }
  return event;
}

// Schema for EventResult wire format returned by events.create
// Uses wire format schemas for step to handle field name mapping
const EventResultWireSchema = z.object({
  event: EventSchema,
  run: WorkflowRunSchema.optional(),
  step: StepWireSchema.optional(),
  hook: HookSchema.optional(),
});

// Schema for events returned with `remoteRefBehavior=lazy`.
// Includes both `eventDataRef` (legacy, specVersion=1) and `eventData`
// (v2, specVersion=2 — may contain nested RefDescriptor values).
// specVersion defaults to 1 (legacy) when parsing responses from storage.
const EventWithRefsSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
  eventDataRef: z.any().optional(),
  eventData: z.any().optional(),
  createdAt: z.coerce.date(),
  specVersion: z.number().default(1),
});

/**
 * Maps event types to the field name within `eventData` that may contain
 * a ref descriptor. Mirrors the server-side `resolveEventDataRefs()` mapping.
 */
const eventDataRefFieldMap: Record<string, string> = {
  run_created: 'input',
  run_completed: 'output',
  run_failed: 'error',
  step_created: 'input',
  step_completed: 'result',
  step_failed: 'error',
  step_retrying: 'error',
  hook_created: 'metadata',
};

// Events where the client uses the response entity data need 'resolve' (default).
// Events where the client discards the response can use 'lazy' to skip expensive
// S3 ref resolution on the server, saving ~200-460ms per event.
const eventsNeedingResolve = new Set([
  'run_created', // client reads result.run.runId
  'run_started', // client reads result.run (checks startedAt, status)
  'step_started', // client reads result.step (checks attempt, state)
]);

/**
 * Collect all ref descriptors from a list of lazy-loaded events.
 * Returns a flat array of { eventIndex, refType, fieldName?, descriptor }
 * entries that can be resolved in bulk.
 */
interface PendingRef {
  eventIndex: number;
  /**
   * 'entity' = top-level eventDataRef (legacy specVersion=1 events)
   * 'nested' = nested ref descriptor within eventData (v2 events)
   */
  refType: 'entity' | 'nested';
  /** The field name within eventData containing the ref (only for 'nested') */
  fieldName?: string;
  descriptor: RefDescriptor;
}

function collectPendingRefs(events: any[]): PendingRef[] {
  const pending: PendingRef[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Legacy events (specVersion=1): eventDataRef is a RefDescriptor
    if (event.eventDataRef && isRefDescriptor(event.eventDataRef)) {
      pending.push({
        eventIndex: i,
        refType: 'entity',
        descriptor: event.eventDataRef,
      });
    }

    // V2 events: eventData may contain a nested RefDescriptor
    if (event.eventData && typeof event.eventData === 'object') {
      const fieldName = eventDataRefFieldMap[event.eventType as string];
      if (fieldName) {
        const fieldValue = event.eventData[fieldName];
        if (isRefDescriptor(fieldValue)) {
          pending.push({
            eventIndex: i,
            refType: 'nested',
            fieldName,
            descriptor: fieldValue,
          });
        }
      }
    }
  }

  return pending;
}

/**
 * Hydrate lazy-loaded events by resolving all ref descriptors client-side.
 * For entity-level refs (eventDataRef), the resolved value becomes eventData.
 * For nested refs (eventData[field]), the resolved value replaces the descriptor.
 *
 * Events are shallow-cloned before mutation to avoid corrupting any upstream
 * caches (SWR, React cache, etc.) that might hold references to the originals.
 */
async function hydrateEventRefs(
  events: any[],
  config?: APIConfig,
  refResolveConcurrency?: number
): Promise<any[]> {
  const pending = collectPendingRefs(events);
  if (pending.length === 0) return events;

  return trace('world.refs.hydrate', async (span) => {
    span?.setAttribute('workflow.refs.hydrated_count', pending.length);

    // Deduplicate descriptors by _ref key to avoid redundant resolutions.
    // Multiple events may reference the same ref (e.g., shared input).
    const uniqueRefs = new Map<string, RefWithRunId>();
    for (const p of pending) {
      if (!uniqueRefs.has(p.descriptor._ref)) {
        const eventRunId = events[p.eventIndex].runId as string;
        uniqueRefs.set(p.descriptor._ref, {
          descriptor: p.descriptor,
          runId: eventRunId,
        });
      }
    }
    const deduped = Array.from(uniqueRefs.values());

    // Resolve unique descriptors in parallel with bounded concurrency
    const dedupedResults = await resolveRefDescriptors(
      deduped,
      config,
      refResolveConcurrency
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to hydrate ${pending.length} ref(s) across ${events.length} event(s): ${msg}`
      );
    });

    // Build a map from ref key → resolved value for fast lookup
    const resolvedMap = new Map<string, unknown>();
    const dedupedKeys = Array.from(uniqueRefs.keys());
    for (let i = 0; i < dedupedKeys.length; i++) {
      resolvedMap.set(dedupedKeys[i], dedupedResults[i]);
    }

    // Shallow-clone events that need modification, then apply resolved values
    const result = [...events];
    for (let i = 0; i < pending.length; i++) {
      const { eventIndex, refType, fieldName, descriptor } = pending[i];
      const resolved = resolvedMap.get(descriptor._ref);

      // Shallow-clone the event (and eventData if nested) before mutating
      if (result[eventIndex] === events[eventIndex]) {
        result[eventIndex] = { ...events[eventIndex] };
      }
      const event = result[eventIndex];

      if (refType === 'entity') {
        // Legacy: eventDataRef → eventData, remove the ref field
        event.eventData = resolved;
        delete event.eventDataRef;
      } else if (refType === 'nested' && fieldName) {
        // Shallow-clone eventData before mutating if not yet cloned
        if (event.eventData === events[eventIndex].eventData) {
          event.eventData = { ...event.eventData };
        }
        // V2: replace the nested ref descriptor with resolved value
        event.eventData[fieldName] = resolved;
      }
    }

    return result;
  });
}

// Functions
export async function getWorkflowRunEvents(
  params: ListEventsParams | ListEventsByCorrelationIdParams,
  config?: APIConfig
): Promise<PaginatedResponse<Event>> {
  const searchParams = new URLSearchParams();

  const { pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION } = params;
  let runId: string | undefined;
  let correlationId: string | undefined;
  if ('runId' in params) {
    runId = params.runId;
  } else {
    correlationId = params.correlationId;
  }

  if (!runId && !correlationId) {
    throw new Error('Either runId or correlationId must be provided');
  }

  if (pagination?.limit) searchParams.set('limit', pagination.limit.toString());
  if (pagination?.cursor) searchParams.set('cursor', pagination.cursor);
  if (pagination?.sortOrder)
    searchParams.set('sortOrder', pagination.sortOrder);
  if (correlationId) searchParams.set('correlationId', correlationId);

  // Always send 'lazy' to the server to avoid memory pressure from resolving
  // all refs in memory. When resolveData is 'all', we hydrate refs client-side
  // via individual ref resolution requests.
  searchParams.set('remoteRefBehavior', 'lazy');

  const queryString = searchParams.toString();
  const query = queryString ? `?${queryString}` : '';
  const endpoint = correlationId
    ? `/v2/events${query}`
    : `/v2/runs/${runId}/events${query}`;

  let refResolveConcurrency: number | undefined;
  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(EventWithRefsSchema),
    onResponse: (res) => {
      const header = res.headers.get('x-ref-resolve-concurrency');
      if (header) {
        const parsed = parseInt(header, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          refResolveConcurrency = parsed;
        }
      }
    },
  })) as PaginatedResponse<Event>;

  if (resolveData === 'all') {
    // Hydrate refs client-side: resolve all ref descriptors in parallel
    const hydratedEvents = await hydrateEventRefs(
      response.data,
      config,
      refResolveConcurrency
    );

    // Re-parse hydrated events through EventSchema to apply type coercions
    // (e.g., z.coerce.date() for resumeAt) that EventWithRefsSchema skips.
    // Use safeParse to gracefully handle any events that don't match a known
    // type — pass them through as-is rather than failing the entire request.
    let coercionFailures = 0;
    const validatedEvents = hydratedEvents.map((event: any) => {
      const result = EventSchema.safeParse(event);
      if (!result.success) coercionFailures++;
      return result.success ? result.data : event;
    });
    if (coercionFailures > 0) {
      console.warn(
        `[world-vercel] EventSchema coercion failed for ${coercionFailures}/${hydratedEvents.length} events`
      );
    }

    return {
      ...response,
      data: validatedEvents,
    };
  }

  // resolveData === 'none': strip eventData and eventDataRef
  return {
    ...response,
    data: response.data.map((event: any) =>
      filterEventData(event, resolveData)
    ),
  };
}

export async function createWorkflowRunEvent(
  id: string | null,
  data: AnyEventRequest,
  params?: CreateEventParams,
  config?: APIConfig
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;

  const v1Compat = params?.v1Compat ?? false;
  if (v1Compat) {
    if (data.eventType === 'run_cancelled' && id) {
      const run = await cancelWorkflowRunV1(id, params, config);
      return { run: run as WorkflowRun };
    } else if (data.eventType === 'run_created') {
      const run = await createWorkflowRunV1(data.eventData, config);
      return { run };
    }
    const wireResult = await makeRequest({
      endpoint: `/v1/runs/${id}/events`,
      options: { method: 'POST' },
      data,
      config,
      schema: EventSchema,
    });

    return { event: wireResult };
  }

  // For run_created events, runId may be client-provided or null
  const runIdPath = id === null ? 'null' : id;

  const remoteRefBehavior = eventsNeedingResolve.has(data.eventType)
    ? 'resolve'
    : 'lazy';

  const wireResult = await makeRequest({
    endpoint: `/v2/runs/${runIdPath}/events`,
    options: { method: 'POST' },
    data: { ...data, remoteRefBehavior },
    config,
    schema: EventResultWireSchema,
  });

  // Transform wire format to interface format
  return {
    event: filterEventData(wireResult.event, resolveData),
    run: wireResult.run,
    step: wireResult.step ? deserializeStep(wireResult.step) : undefined,
    hook: wireResult.hook,
  };
}
