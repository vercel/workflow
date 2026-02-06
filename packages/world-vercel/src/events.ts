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
import { cancelWorkflowRunV1, createWorkflowRunV1 } from './runs.js';
import { deserializeStep, StepWireSchema } from './steps.js';
import type { APIConfig } from './utils.js';
import { DEFAULT_RESOLVE_DATA_OPTION, makeRequest } from './utils.js';

// Helper to filter event data based on resolveData setting
function filterEventData(event: any, resolveData: 'none' | 'all'): Event {
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = event;
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

// Would usually "EventSchema.omit({ eventData: true })" but that doesn't work
// on zod unions. Re-creating the schema manually.
// specVersion defaults to 1 (legacy) when parsing responses from storage
const EventWithRefsSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
  eventDataRef: z.any().optional(),
  createdAt: z.coerce.date(),
  specVersion: z.number().default(1),
});

// Events where the client uses the response entity data need 'resolve' (default).
// Events where the client discards the response can use 'lazy' to skip expensive
// S3 ref resolution on the server, saving ~200-460ms per event.
const eventsNeedingResolve = new Set([
  'run_created', // client reads result.run.runId
  'run_started', // client reads result.run (checks startedAt, status)
  'step_started', // client reads result.step (checks attempt, state)
]);

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
  const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
  searchParams.set('remoteRefBehavior', remoteRefBehavior);

  const queryString = searchParams.toString();
  const query = queryString ? `?${queryString}` : '';
  const endpoint = correlationId
    ? `/v2/events${query}`
    : `/v2/runs/${runId}/events${query}`;

  const response = (await makeRequest({
    endpoint,
    options: { method: 'GET' },
    config,
    schema: PaginatedResponseSchema(
      remoteRefBehavior === 'lazy' ? EventWithRefsSchema : EventSchema
    ),
  })) as PaginatedResponse<Event>;

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
