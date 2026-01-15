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
  type Step,
  StepSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import z from 'zod';
import type { APIConfig } from './utils.js';
import {
  DEFAULT_RESOLVE_DATA_OPTION,
  dateToStringReplacer,
  makeRequest,
} from './utils.js';

/**
 * Wire format schema for step in event results.
 * Handles error deserialization from wire format.
 */
const StepWireSchema = StepSchema.omit({
  error: true,
}).extend({
  // Backend returns error either as:
  // - A JSON string (legacy/lazy mode)
  // - An object {message, stack} (when errorRef is resolved)
  error: z
    .union([
      z.string(),
      z.object({
        message: z.string(),
        stack: z.string().optional(),
        code: z.string().optional(),
      }),
    ])
    .optional(),
  errorRef: z.any().optional(),
});

/**
 * Deserialize step from wire format to Step interface format.
 */
function deserializeStep(wireStep: z.infer<typeof StepWireSchema>): Step {
  const { error, errorRef, ...rest } = wireStep;

  const result: any = {
    ...rest,
  };

  // Deserialize error to StructuredError
  const errorSource = error ?? errorRef;
  if (errorSource) {
    if (typeof errorSource === 'string') {
      try {
        const parsed = JSON.parse(errorSource);
        if (typeof parsed === 'object' && parsed.message !== undefined) {
          result.error = {
            message: parsed.message,
            stack: parsed.stack,
            code: parsed.code,
          };
        } else {
          result.error = { message: String(parsed) };
        }
      } catch {
        result.error = { message: errorSource };
      }
    } else if (typeof errorSource === 'object' && errorSource !== null) {
      result.error = {
        message: errorSource.message ?? 'Unknown error',
        stack: errorSource.stack,
        code: errorSource.code,
      };
    }
  }

  return result as Step;
}

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
const EventWithRefsSchema = z.object({
  eventId: z.string(),
  runId: z.string(),
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
  eventDataRef: z.any().optional(),
  createdAt: z.coerce.date(),
});

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

  // For run_created events, runId is null - use "null" string in the URL path
  const runIdPath = id === null ? 'null' : id;

  const wireResult = await makeRequest({
    endpoint: `/v2/runs/${runIdPath}/events`,
    options: {
      method: 'POST',
      body: JSON.stringify(data, dateToStringReplacer),
    },
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
