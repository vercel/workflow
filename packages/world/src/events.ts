import { z } from 'zod';
import type { PaginationOptions, ResolveData } from './shared.js';

// Event type enum
export const EventTypeSchema = z.enum([
  // Run lifecycle events
  'run_created',
  'run_started',
  'run_completed',
  'run_failed',
  'run_cancelled',
  // Step lifecycle events
  'step_created',
  'step_completed',
  'step_failed',
  'step_retrying',
  'step_started',
  // Hook lifecycle events
  'hook_created',
  'hook_received',
  'hook_disposed',
  'hook_conflict', // Created by world when hook token already exists
  // Wait lifecycle events
  'wait_created',
  'wait_completed',
  // Legacy workflow events (deprecated, use run_* instead)
  'workflow_completed',
  'workflow_failed',
  'workflow_started',
]);

// Base event schema with common properties
// TODO: Event data on all specific event schemas can actually be undefined,
// as the world may omit eventData when resolveData is set to 'none'.
// Changing the type here will mainly improve type safety for o11y consumers.
export const BaseEventSchema = z.object({
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
});

// Event schemas (shared between creation requests and server responses)
const StepCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_completed'),
  correlationId: z.string(),
  eventData: z.object({
    result: z.any(),
  }),
});

const StepFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_failed'),
  correlationId: z.string(),
  eventData: z.object({
    error: z.any(),
    stack: z.string().optional(),
  }),
});

/**
 * Event created when a step fails and will be retried.
 * Sets the step status back to 'pending' and records the error.
 * The error is stored in step.error for debugging.
 */
const StepRetryingEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_retrying'),
  correlationId: z.string(),
  eventData: z.object({
    error: z.any(),
    stack: z.string().optional(),
    retryAfter: z.coerce.date().optional(),
  }),
});

const StepStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_started'),
  correlationId: z.string(),
  eventData: z
    .object({
      attempt: z.number().optional(),
    })
    .optional(),
});

/**
 * Event created when a step is first invoked. The World implementation
 * atomically creates both the event and the step entity.
 */
const StepCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_created'),
  correlationId: z.string(),
  eventData: z.object({
    stepName: z.string(),
    input: z.any(), // SerializedData
  }),
});

/**
 * Event created when a hook is first invoked. The World implementation
 * atomically creates both the event and the hook entity.
 */
const HookCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_created'),
  correlationId: z.string(),
  eventData: z.object({
    token: z.string(),
    metadata: z.any().optional(), // SerializedData
  }),
});

const HookReceivedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_received'),
  correlationId: z.string(),
  eventData: z.object({
    payload: z.any(), // Serialized payload
  }),
});

const HookDisposedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_disposed'),
  correlationId: z.string(),
});

/**
 * Event created by World implementations when a hook_created request
 * conflicts with an existing hook token. This event is NOT user-creatable -
 * it is only returned by the World when a token conflict is detected.
 *
 * When the hook consumer sees this event, it should reject any awaited
 * promises with a HookTokenConflictError.
 */
const HookConflictEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_conflict'),
  correlationId: z.string(),
  eventData: z.object({
    token: z.string(),
  }),
});

const WaitCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('wait_created'),
  correlationId: z.string(),
  eventData: z.object({
    resumeAt: z.coerce.date(),
  }),
});

const WaitCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('wait_completed'),
  correlationId: z.string(),
});

// =============================================================================
// Run lifecycle events
// =============================================================================

/**
 * Event created when a workflow run is first created. The World implementation
 * atomically creates both the event and the run entity with status 'pending'.
 */
const RunCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_created'),
  eventData: z.object({
    deploymentId: z.string(),
    workflowName: z.string(),
    input: z.array(z.any()), // SerializedData[]
    executionContext: z.record(z.string(), z.any()).optional(),
    specVersion: z.string().optional(), // World spec version for backwards compatibility
  }),
});

/**
 * Event created when a workflow run starts executing.
 * Updates the run entity to status 'running'.
 */
const RunStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_started'),
});

/**
 * Event created when a workflow run completes successfully.
 * Updates the run entity to status 'completed' with output.
 */
const RunCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_completed'),
  eventData: z.object({
    output: z.any().optional(), // SerializedData
  }),
});

/**
 * Event created when a workflow run fails.
 * Updates the run entity to status 'failed' with error.
 */
const RunFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_failed'),
  eventData: z.object({
    error: z.any(),
    errorCode: z.string().optional(),
  }),
});

/**
 * Event created when a workflow run is cancelled.
 * Updates the run entity to status 'cancelled'.
 */
const RunCancelledEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_cancelled'),
});

// =============================================================================
// Legacy workflow events (deprecated, use run_* events instead)
// =============================================================================

/** @deprecated Use run_completed instead */
const WorkflowCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('workflow_completed'),
});

/** @deprecated Use run_failed instead */
const WorkflowFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('workflow_failed'),
  eventData: z.object({
    error: z.any(),
  }),
});

/** @deprecated Use run_started instead */
const WorkflowStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('workflow_started'),
});

// Discriminated union for user-creatable events (requests to world.events.create)
// Note: hook_conflict is NOT included here - it can only be created by World implementations
export const CreateEventSchema = z.discriminatedUnion('eventType', [
  // Run lifecycle events
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  // Step lifecycle events
  StepCreatedEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  StepRetryingEventSchema,
  StepStartedEventSchema,
  // Hook lifecycle events
  HookCreatedEventSchema,
  HookReceivedEventSchema,
  HookDisposedEventSchema,
  // Wait lifecycle events
  WaitCreatedEventSchema,
  WaitCompletedEventSchema,
  // Legacy workflow events (deprecated)
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  WorkflowStartedEventSchema,
]);

// Discriminated union for ALL events (includes World-only events like hook_conflict)
// This is used for reading events from the event log
const AllEventsSchema = z.discriminatedUnion('eventType', [
  // Run lifecycle events
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  // Step lifecycle events
  StepCreatedEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  StepRetryingEventSchema,
  StepStartedEventSchema,
  // Hook lifecycle events
  HookCreatedEventSchema,
  HookReceivedEventSchema,
  HookDisposedEventSchema,
  HookConflictEventSchema, // World-only: created when hook token conflicts
  // Wait lifecycle events
  WaitCreatedEventSchema,
  WaitCompletedEventSchema,
  // Legacy workflow events (deprecated)
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  WorkflowStartedEventSchema,
]);

// Server response includes runId, eventId, and createdAt
export const EventSchema = AllEventsSchema.and(
  z.object({
    runId: z.string(),
    eventId: z.string(),
    createdAt: z.coerce.date(),
  })
);

// Inferred types
export type Event = z.infer<typeof EventSchema>;
export type HookReceivedEvent = z.infer<typeof HookReceivedEventSchema>;
export type HookConflictEvent = z.infer<typeof HookConflictEventSchema>;

/**
 * Union of all possible event request types.
 * @internal Use CreateEventRequest or RunCreatedEventRequest instead.
 */
export type AnyEventRequest = z.infer<typeof CreateEventSchema>;

/**
 * Event request for creating a new workflow run.
 * Must be used with runId: null since the server generates the runId.
 */
export type RunCreatedEventRequest = z.infer<typeof RunCreatedEventSchema>;

/**
 * Event request types that require an existing runId.
 * This is the common case for all events except run_created.
 */
export type CreateEventRequest = Exclude<
  AnyEventRequest,
  RunCreatedEventRequest
>;

export interface CreateEventParams {
  resolveData?: ResolveData;
}

/**
 * Result of creating an event. Includes the created event and optionally
 * the entity that was created or updated as a result of the event, with any updates applied to it.
 *
 * Note: `event` is optional to support legacy runs where event storage is skipped.
 */
export interface EventResult {
  /** The created event (optional for legacy compatibility) */
  event?: Event;
  /** The workflow run entity (for run_* events) */
  run?: import('./runs.js').WorkflowRun;
  /** The step entity (for step_* events) */
  step?: import('./steps.js').Step;
  /** The hook entity (for hook_created events) */
  hook?: import('./hooks.js').Hook;
}

export interface ListEventsParams {
  runId: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}

export interface ListEventsByCorrelationIdParams {
  correlationId: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
