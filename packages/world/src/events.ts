import { z } from 'zod';
import { AttributeChangesSchema } from './attributes.js';
import { getEventDataRefFields } from './event-metadata.js';
import type { Hook } from './hooks.js';
import type { StartedWorkflowRun, WorkflowRun } from './runs.js';
import { SerializedDataSchema } from './serialization.js';
import type { PaginationOptions, ResolveData } from './shared.js';
import type { StartedStep, Step } from './steps.js';
import type { Wait } from './waits.js';

export * from './event-metadata.js';

// Event type enum
export const EventTypeSchema = z.enum([
  // Run lifecycle events
  'run_created',
  'run_started',
  'run_completed',
  'run_failed',
  'run_cancelled',
  // Run attribute events
  'attr_set',
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
  // Sealed-log filler (specVersion >= 7): written ONLY by the World's backend
  // to occupy a slot whose writer allocated it and died. Carries no workflow
  // meaning; replay skips it (see EventsConsumer). Never user-creatable.
  'noop',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

const RunEventTypeSchema = EventTypeSchema.extract([
  'run_created',
  'run_started',
  'run_completed',
  'run_failed',
  'run_cancelled',
] as const);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;
export const RUN_EVENT_TYPES = RunEventTypeSchema.options;

export function isRunEventType(eventType: string): eventType is RunEventType {
  return RUN_EVENT_TYPES.includes(eventType as RunEventType);
}

export const TerminalRunEventTypeSchema = EventTypeSchema.extract([
  'run_completed',
  'run_failed',
  'run_cancelled',
] as const);
export type TerminalRunEventType = z.infer<typeof TerminalRunEventTypeSchema>;
export const TERMINAL_RUN_EVENT_TYPES = TerminalRunEventTypeSchema.options;

export function isTerminalRunEventType(
  eventType: string
): eventType is TerminalRunEventType {
  return TERMINAL_RUN_EVENT_TYPES.includes(eventType as TerminalRunEventType);
}

const StepEventTypeSchema = EventTypeSchema.extract([
  'step_created',
  'step_completed',
  'step_failed',
  'step_retrying',
  'step_started',
] as const);
export type StepEventType = z.infer<typeof StepEventTypeSchema>;
export const STEP_EVENT_TYPES = StepEventTypeSchema.options;

export function isStepEventType(eventType: string): eventType is StepEventType {
  return STEP_EVENT_TYPES.includes(eventType as StepEventType);
}

const TerminalStepEventTypeSchema = EventTypeSchema.extract([
  'step_completed',
  'step_failed',
] as const);
export type TerminalStepEventType = z.infer<typeof TerminalStepEventTypeSchema>;
export const TERMINAL_STEP_EVENT_TYPES = TerminalStepEventTypeSchema.options;

export function isTerminalStepEventType(
  eventType: string
): eventType is TerminalStepEventType {
  return TERMINAL_STEP_EVENT_TYPES.includes(eventType as TerminalStepEventType);
}

const HookLifecycleEventTypeSchema = EventTypeSchema.extract([
  'hook_created',
  'hook_received',
  'hook_disposed',
] as const);
export type HookLifecycleEventType = z.infer<
  typeof HookLifecycleEventTypeSchema
>;
export const HOOK_LIFECYCLE_EVENT_TYPES = HookLifecycleEventTypeSchema.options;

export function isHookLifecycleEventType(
  eventType: string
): eventType is HookLifecycleEventType {
  return HOOK_LIFECYCLE_EVENT_TYPES.includes(
    eventType as HookLifecycleEventType
  );
}

const HookEventRequiringExistenceTypeSchema = EventTypeSchema.extract([
  'hook_disposed',
  'hook_received',
] as const);
export type HookEventRequiringExistenceType = z.infer<
  typeof HookEventRequiringExistenceTypeSchema
>;
export const HOOK_EVENTS_REQUIRING_EXISTENCE =
  HookEventRequiringExistenceTypeSchema.options;

export function isHookEventRequiringExistence(
  eventType: string
): eventType is HookEventRequiringExistenceType {
  return HOOK_EVENTS_REQUIRING_EXISTENCE.includes(
    eventType as HookEventRequiringExistenceType
  );
}

const WaitEventTypeSchema = EventTypeSchema.extract([
  'wait_created',
  'wait_completed',
] as const);
export type WaitEventType = z.infer<typeof WaitEventTypeSchema>;
export const WAIT_EVENT_TYPES = WaitEventTypeSchema.options;

export function isWaitEventType(eventType: string): eventType is WaitEventType {
  return WAIT_EVENT_TYPES.includes(eventType as WaitEventType);
}

/**
 * Whether an event is a sealed-log filler occupying an abandoned slot.
 *
 * The single home for this test, deliberately: a noop is invisible to the run
 * but it is a real row of the log, so *every* pass over a log has to decide
 * whether it is walking positions (count it) or reconstructing what happened
 * (skip it). The two replay engines and the observability trace builder each
 * make that decision independently, and the one thing they must agree on is
 * that a noop's `createdAt`, the sealer's wall clock, can postdate every real
 * event around it but never becomes a time the run observed.
 */
export function isSealedNoopEvent(
  event: Pick<Event, 'eventType'> | { eventType: string }
): boolean {
  return event.eventType === 'noop';
}

const ChildEntityCreationEventTypeSchema = EventTypeSchema.extract([
  'step_created',
  'hook_created',
  'wait_created',
] as const);
export type ChildEntityCreationEventType = z.infer<
  typeof ChildEntityCreationEventTypeSchema
>;
export const CHILD_ENTITY_CREATION_EVENT_TYPES =
  ChildEntityCreationEventTypeSchema.options;

export function isChildEntityCreationEventType(
  eventType: string
): eventType is ChildEntityCreationEventType {
  return CHILD_ENTITY_CREATION_EVENT_TYPES.includes(
    eventType as ChildEntityCreationEventType
  );
}

/**
 * Strip ref/payload fields from eventData based on resolveData setting.
 * When resolveData is 'none', removes only large data fields (refs) from
 * eventData while preserving metadata like stepName, workflowName, etc.
 */
export function stripEventDataRefs(
  event: Event,
  resolveData: ResolveData
): Event {
  if (resolveData !== 'none') return event;
  if (!('eventData' in event)) return event;

  const eventData = (event as any).eventData;
  if (!eventData || typeof eventData !== 'object') {
    const { eventData: _, ...rest } = event as any;
    return rest;
  }

  const refFields = getEventDataRefFields(event.eventType);
  if (refFields.length === 0) return event;

  const stripped = { ...eventData };
  for (const field of refFields) {
    delete stripped[field];
  }

  const { eventData: _, ...rest } = event as any;
  return {
    ...rest,
    ...(Object.keys(stripped).length > 0 ? { eventData: stripped } : {}),
  };
}

// Base event schema with common properties
// TODO: Event data on all specific event schemas can actually be undefined,
// as the world may omit eventData when resolveData is set to 'none'.
// Changing the type here will mainly improve type safety for o11y consumers.
// Note: specVersion is optional for backward compatibility with legacy data in storage,
// but is always sent by the runtime on new events.
export const BaseEventSchema = z.object({
  eventType: EventTypeSchema,
  correlationId: z.string().optional(),
  specVersion: z.number().optional(),
});

// Event schemas (shared between creation requests and server responses)
// Note: Serialized data fields use SerializedDataSchema to support both:
// - specVersion >= 2: Uint8Array (binary devalue format)
// - specVersion 1: any (legacy JSON format)
// Client-measured latency telemetry carried on a step's terminal event so a
// backend can emit latency metrics without extra event-log queries. Fields
// are populated as applicable by the runtime, only on the terminal event of
// a first-attempt step execution that qualified for measurement (see
// `@workflow/core` runtime/step-latency.ts). Backends may consume these for
// metrics and are not required to persist them.
const stepLatencyTelemetryFields = {
  // Time-to-first-step: milliseconds from run creation until the run's first
  // step body began executing, minus time spent committing hook_created
  // events. Only reported when nothing else (hooks received, waits,
  // attributes, other steps) happened before the first step.
  ttfs: z.number().optional(),
  // Step-to-step overhead: milliseconds between the previous step's terminal
  // event and this step's body beginning to execute. Only reported when the
  // two steps ran back-to-back (the previous event-log entry is a
  // step_completed/step_failed).
  stso: z.number().optional(),
  // Progress counters taken when the STSO gap began. Only present alongside
  // stso.
  stepCount: z.number().int().positive().optional(),
  eventCount: z.number().int().positive().optional(),
  // Run-started-to-first-step: milliseconds from the `run_started` response
  // landing (or, under turbo, the local run synthesis instant) until this
  // step's start POST was issued. A sub-window of ttfs. Only reported
  // alongside the same eligibility as ttfs.
  rsfs: z.number().optional(),
  // Synchronous workflow-function replay duration of only the FINAL replay
  // pass within the rsfs window (the pass that scheduled the first step),
  // excluding awaited network I/O. Not accumulated across earlier
  // pre-first-step passes, so it is not "the replay portion of rsfs". Only
  // present alongside rsfs, and only for the run's first step.
  finalSchedulingReplay: z.number().optional(),
  // Names of the runtime's optional startup-latency optimizations that were
  // active for this measurement (e.g. 'turbo', 'lazyStepStart',
  // 'optimisticStart'), so latency metrics can be segmented by them.
  optimizations: z.array(z.string()).optional(),
};

const StepCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_completed'),
  correlationId: z.string(),
  eventData: z.object({
    stepName: z.string().optional(),
    // Carried so a backend that keys payload refs by workflow name can build
    // the key without an extra run lookup on this hot per-step write.
    // Optional: older runtimes omit it and the backend falls back to a read.
    workflowName: z.string().optional(),
    result: SerializedDataSchema,
    ...stepLatencyTelemetryFields,
  }),
});

const StepFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_failed'),
  correlationId: z.string(),
  eventData: z.object({
    stepName: z.string().optional(),
    // The thrown value, serialized via the workflow serialization pipeline.
    // Can be any JavaScript value (string, number, object, Error, etc.)
    error: SerializedDataSchema,
    ...stepLatencyTelemetryFields,
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
    stepName: z.string().optional(),
    // The thrown value, serialized via the workflow serialization pipeline.
    // Can be any JavaScript value (string, number, object, Error, etc.)
    error: SerializedDataSchema,
    retryAfter: z.coerce.date().optional(),
  }),
});

/**
 * Event created when a step begins executing.
 * Transitions the step entity to status 'running' and increments its attempt.
 *
 * The optional `stepName` + `input` carry step creation data for the lazy-start
 * path: when a handler owns a step it is about to run inline (the owned-inline
 * path in the runtime), it can skip the separate `step_created` round-trip and
 * send only `step_started` carrying the step input. The World implementation
 * then atomically creates the step (materializing the step entity and writing a
 * synthetic `step_created` event so replay still observes it) before starting
 * it. This mirrors the resilient `run_started` start path above. When `input`
 * is absent the World requires a prior `step_created` (the legacy contract).
 */
const StepStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('step_started'),
  correlationId: z.string(),
  eventData: z
    .object({
      stepName: z.string().optional(),
      attempt: z.number().optional(),
      // Carried on the lazy-start path (where `input` is present) so the
      // backend can build the payload ref key without re-reading the run.
      workflowName: z.string().optional(),
      // Lazy-start: the dehydrated step input, present only when this
      // step_started is also responsible for creating the step.
      input: SerializedDataSchema.optional(),
      // Inline step ownership: the queue message ID of the invocation whose
      // handler is executing this step's body inline. Stamped on the lazy
      // step_started (and re-stamped on an owner-recovery bare start) so
      // that a wake replay can tell "this attempt is in flight in a live
      // invocation" apart from "this attempt died with its process": the
      // owner's queue message doubles as the liveness lease (a crash means
      // the queue redelivers that same messageId, which is allowed to
      // re-execute). Ownership derives from the step's LATEST step_started:
      // an unstamped bare start (a retry attempt driven by a queued step
      // message) clears it. Absent on eager steps and from older runtimes.
      // Requires the queue's messageId to be stable across redeliveries of
      // one message (see the Queue.createQueueHandler meta contract).
      ownerMessageId: z.string().optional(),
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
    workflowName: z.string().optional(),
    input: SerializedDataSchema,
  }),
});

/**
 * Event created when a hook is first invoked. The World implementation
 * atomically creates both the event and the hook entity.
 */
export const HookCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_created'),
  correlationId: z.string(),
  eventData: z.object({
    token: z.string(),
    tokenRetentionUntil: z.coerce.date().optional(),
    metadata: SerializedDataSchema.optional(),
    isWebhook: z.boolean().optional(),
    isSystem: z.boolean().optional(),
  }),
});

const HookReceivedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_received'),
  correlationId: z.string(),
  eventData: z.object({
    token: z.string().optional(),
    payload: SerializedDataSchema,
  }),
});

const HookDisposedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('hook_disposed'),
  correlationId: z.string(),
  eventData: z
    .object({
      token: z.string().optional(),
    })
    .optional(),
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
    // TODO: Make this required once all persisted hook_conflict events and
    // remote World implementations always include the active hook owner's run ID.
    conflictingRunId: z.string().optional(),
  }),
});

/**
 * Sealed-log filler event (specVersion >= 7). Written ONLY by the World's
 * backend when it seals a slot whose writer allocated the position and died
 * before committing (see `SPEC_VERSION_SUPPORTS_SEALED_LOG`). It occupies its
 * slot, so density arithmetic and cursors count it, but carries no workflow
 * meaning: replay steps over it without delivering it to any consumer and
 * without advancing the deterministic clock. NOT user-creatable, and absent
 * from `CreateEventSchema` for that reason.
 */
const NoopEventSchema = BaseEventSchema.extend({
  eventType: z.literal('noop'),
  eventData: z
    .object({
      sealed: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
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
  eventData: z
    .object({
      resumeAt: z.coerce.date().optional(),
    })
    .optional(),
});

const AttributeWriterSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow'),
  }),
  z.object({
    type: z.literal('step'),
    stepId: z.string(),
    attempt: z.number(),
  }),
]);

/**
 * Event created when workflow or step code changes the run's plaintext
 * attributes. The World materializes changes into `run.attributes`.
 */
const AttrSetEventSchema = BaseEventSchema.extend({
  eventType: z.literal('attr_set'),
  correlationId: z.string().optional(),
  eventData: z.object({
    changes: AttributeChangesSchema,
    writer: AttributeWriterSchema,
    allowReservedAttributes: z.literal(true).optional(),
  }),
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
    input: SerializedDataSchema,
    executionContext: z.record(z.string(), z.any()).optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    allowReservedAttributes: z.literal(true).optional(),
    /**
     * The run's X25519 public key (base64), stamped by SDKs that support
     * sealed (`encp`) envelopes. Persisted onto the run entity so that
     * cross-run writers can seal payloads to this run without holding its
     * symmetric key. Not secret. See `WorkflowRunBaseSchema`.
     */
    encryptionPublicKey: z.string().optional(),
  }),
});

/**
 * Event created when a workflow run starts executing.
 * Updates the run entity to status 'running'.
 *
 * The optional eventData carries run creation data for the resilient start path:
 * when the run_created event failed (e.g., storage outage during start()), the
 * runtime passes the run input through the queue so the server can create the run
 * on the run_started call if it doesn't exist yet.
 */
const RunStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_started'),
  eventData: z
    .object({
      input: SerializedDataSchema.optional(),
      deploymentId: z.string().optional(),
      workflowName: z.string().optional(),
      executionContext: z.record(z.string(), z.any()).optional(),
      attributes: z.record(z.string(), z.string()).optional(),
      allowReservedAttributes: z.literal(true).optional(),
      /**
       * Mirrors `run_created.eventData.encryptionPublicKey`. Carried here for
       * the resilient-start path: when the `run_created` write failed, the
       * server creates the run from this event instead, and without the key
       * the run would silently lose its ability to receive sealed writes.
       */
      encryptionPublicKey: z.string().optional(),
    })
    .optional(),
});

/**
 * Event created when a workflow run completes successfully.
 * Updates the run entity to status 'completed' with output.
 */
const RunCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_completed'),
  eventData: z.object({
    output: SerializedDataSchema.optional(),
  }),
});

/**
 * Event created when a workflow run fails.
 * Updates the run entity to status 'failed' with error.
 */
const RunFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_failed'),
  eventData: z.object({
    // The thrown value, serialized via the workflow serialization pipeline.
    // Can be any JavaScript value (string, number, object, Error, etc.)
    error: SerializedDataSchema,
    // The high-level error category (USER_ERROR, RUNTIME_ERROR, etc.) used
    // for routing and classification. Kept as plaintext metadata so
    // observability tools can filter/categorize without needing to decrypt
    // the full error payload.
    errorCode: z.string().optional(),
  }),
});

/**
 * Event created when a workflow run is cancelled.
 * Updates the run entity to status 'cancelled'.
 */
const RunCancelledEventSchema = BaseEventSchema.extend({
  eventType: z.literal('run_cancelled'),
  eventData: z
    .object({
      // Optional free-text reason for the cancellation. Kept as small
      // plaintext metadata (like run_failed's errorCode) so it survives
      // resolveData: 'none' and can be displayed without decryption.
      cancelReason: z.string().max(512).optional(),
    })
    .optional(),
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
  AttrSetEventSchema,
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
  AttrSetEventSchema,
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
  NoopEventSchema, // World-only: sealed-log filler for an abandoned slot
]);

// Server response includes runId, eventId, and createdAt
// specVersion is optional in database for backward compatibility
export const EventSchema = AllEventsSchema.and(
  z.object({
    runId: z.string(),
    eventId: z.string(),
    createdAt: z.coerce.date(),
    occurredAt: z.coerce.date().optional(),
    specVersion: z.number().optional(),
    /**
     * Lazy hook resume idempotency key, persisted on `hook_received` events so
     * the queue consumer can detect that the producer's concurrent direct write
     * already landed in the run_started preload and skip its own re-ensure.
     * Mirrors {@link CreateEventParams.resumeId}; absent on all other events and
     * on legacy (non-lazy) resumes.
     */
    resumeId: z.string().optional(),
  })
);

// Inferred types
export type Event = z.infer<typeof EventSchema>;
export type EventOfType<T extends EventType> = Extract<Event, { eventType: T }>;
export type EventRequestOfType<T extends EventType> = Extract<
  AnyEventRequest,
  { eventType: T }
>;
export type HookCreatedEvent = EventOfType<'hook_created'>;
export type HookCreatedEventRequest = EventRequestOfType<'hook_created'>;
export type HookReceivedEvent = z.infer<typeof HookReceivedEventSchema>;
export type HookConflictEvent = z.infer<typeof HookConflictEventSchema>;

/**
 * Union of all possible event request types.
 * @internal Use CreateEventRequest or RunCreatedEventRequest instead.
 */
export type AnyEventRequest = z.infer<typeof CreateEventSchema>;

type ChildEntityCreationEventRequest =
  | EventRequestOfType<ChildEntityCreationEventType>
  | (EventRequestOfType<'step_started'> & {
      eventData: {
        stepName: string;
        input: unknown;
      };
    });

/** Includes lazy step_started requests that create their step on demand. */
export function isChildEntityCreationEvent(
  event: AnyEventRequest
): event is ChildEntityCreationEventRequest {
  if (isChildEntityCreationEventType(event.eventType)) return true;
  return (
    event.eventType === 'step_started' &&
    typeof event.eventData?.stepName === 'string' &&
    event.eventData.input !== undefined
  );
}

/**
 * Event request for creating a new workflow run.
 * Can be used with a client-generated runId or null for server-generated.
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
  v1Compat?: boolean;
  resolveData?: ResolveData;
  /**
   * Lazy hook resume idempotency key. Set only by `resumeHook()` when it
   * persists a `hook_received` event whose creation must be deduplicated
   * against a concurrent re-ensure from the queue consumer. The World routes
   * it to the backend's `(runId, resumeId)` constraint so both writers
   * converge on exactly one event. Only meaningful for `hook_received`.
   */
  resumeId?: string;
  /**
   * Content digest of the serialized resume payload, computed once by
   * `resumeHook()` and forwarded identically on the direct write and the queue
   * re-ensure. The World routes it to the backend so both writers record the
   * same digest on the `(runId, resumeId)` constraint. Only meaningful
   * alongside {@link resumeId}.
   */
  resumePayloadDigest?: string;
  /**
   * Marks a `step_created` create as the queue consumer's re-ensure of a
   * resilient step dispatch (a step message carrying `stepInput`, see
   * `WorkflowInvokePayload.stepInput`): the producer's direct write was
   * parallelized with the queue publish and may have failed. Only meaningful
   * for `step_created`.
   *
   * Advisory. Parallelizing a create with its publish is opt-in and off by
   * default (`WORKFLOW_RESILIENT_STEP_DISPATCH`), precisely because a create
   * can come back refused while the message carrying its payload is already
   * out. A deployment that opts in accepts that window, and a backend MAY use
   * this flag to narrow it: refuse the re-ensure (world-vercel surfaces the
   * backend's 410 as `RunExpiredError`, which the consumer treats as "nothing
   * left to execute" and acks the message) when it has recorded a refusal for
   * this correlation id and no step entity exists. Best-effort by nature (a
   * marker written at refusal time cannot be ordered before the redelivery it
   * is meant to stop), so it hardens, and does not close, the window. Worlds
   * may ignore this flag entirely.
   */
  viaStepDispatch?: boolean;
  /** Request ID (x-vercel-id when on Vercel) for correlating request logs with workflow events. */
  requestId?: string;
  /**
   * Compute instance whose handler is writing this event (`COMPUTE_INSTANCE_ID`
   * in @workflow/core). Ambient per-event identity like {@link requestId},
   * which distinguishes invocations *within* an instance. Read back via
   * `AnalyticsEventSchema` / `AnalyticsStepSchema`.
   */
  computeInstanceId?: string;
  /**
   * How many events the writer held in its loaded log when it decided to write
   * this one: equivalently, the slot it expects to land on minus one. Sent by
   * every replay-context create; omitted by callers with no loaded log to be
   * stale against.
   *
   * A World's slots are dense and 1-based (see `Storage.events`), so a count
   * and a position are the same number. An id that is not a position does not
   * produce a count here: it throws, since the runtime cannot state a
   * snapshot for a log it cannot place. Such a World attempts
   * `eventCount + 1`, and on contention **bumps** to the next free slot and
   * commits there anyway: a stale count never rejects a write. What it does
   * instead is report: when the committed slot is higher than the one asked
   * for, the events occupying the skipped slots come back on the success
   * response in {@link EventResult.events} / `cursor` / `hasMore`, so the
   * writer learns exactly what it had not seen.
   *
   * Understating is safe and overstating is not. A count below the writer's
   * true position only widens the reported span, and the client discards what
   * its log already holds. A count above it makes the World report less than
   * the writer is missing, which is a hole the writer never learns about.
   *
   * A batch of writes issued from one snapshot starts from the same
   * `eventCount`; they land on consecutive slots in whatever order the World
   * serializes them, which is why they can stay a parallel fan-out instead of
   * a chain of round-trips. The count a given write sends is the writer's
   * position *at that moment*, so it advances mid-batch as reported events are
   * folded back into the loaded log: a write issued after a sibling's
   * bump-and-report already holds the slots that report named, and asks for a
   * slot above them.
   */
  eventCount?: number;
  /**
   * Timestamp for when the event occurred on the client side. Worlds that
   * support this can persist it separately from `createdAt`, which represents
   * when the backing service accepted or stored the event.
   */
  occurredAt?: Date;
  /**
   * Number of consecutive replay divergences resolved by this event write.
   *
   * This is request telemetry, not workflow state. Worlds may use it for
   * metrics and diagnostics, but must not require it for event
   * materialization or persist it into the event log.
   */
  replayDivergenceCount?: number;
  /**
   * Inline-delta optimization (opt-in). When set, the World MAY return,
   * on the resulting {@link EventResult}, the first page of events written
   * strictly after this cursor (via `events`/`cursor`/`hasMore`): the
   * same page an `events.list({ cursor: sinceCursor, sortOrder: 'asc' })`
   * call would return immediately after this write. Outside turbo mode the
   * runtime sets this on every write it makes from the orchestrator loop
   * and folds any returned delta into its in-memory log, so each write
   * carries the log forward and the loop reads it back for free: instead of
   * re-reading its own just-written events (and any events interleaved
   * in-band, such as `hook_received`), it consumes the authoritative delta
   * the write already had to compute. Turbo mode does not set it: the
   * point there is to keep the first invocation's writes as cheap as
   * possible, and it has no loaded log to extend.
   *
   * The cursor MUST share `events.list` semantics: the returned `events`
   * are everything sorted strictly after `sinceCursor`, `cursor` is the
   * position past the last returned event, and `hasMore` indicates a
   * further page exists. A World MAY return a single page and set
   * `hasMore: true` rather than paginating to exhaustion. The runtime
   * consumes that page and continues from its cursor, so it never reads the
   * returned prefix again.
   * Returning these fields at all is OPTIONAL: a World that omits them is
   * fully supported; the runtime falls back to `events.list`. This
   * preserves the same divergence guarantees as the fetch path because the
   * delta is computed atomically against the same log the fetch would read.
   */
  sinceCursor?: string;
  /**
   * Run-started preload opt-out (advisory). On a `run_started` write a World
   * MAY preload the run's event log onto the {@link EventResult}
   * (`events`/`cursor`/`hasMore`) so the runtime can skip its initial
   * `events.list`. The turbo first invocation backgrounds `run_started`
   * purely as a write barrier and never reads that preload, so it sets this
   * to tell the World to skip the wasted list+resolve, trimming the
   * `run_started` round-trip that the chained first `step_started` waits on.
   * A World that ignores it (or doesn't preload) remains fully correct: the
   * runtime falls back to `events.list` whenever it actually needs the log.
   * Only honored for `run_started`; ignored for other event types.
   *
   * Named to match the World boundary, the wire frame meta, and the backend
   * option end-to-end (cf. {@link sinceCursor}) so the single name greps
   * across the SDK and the backend.
   */
  skipPreload?: true;
  /**
   * Replay-log preload opt-in (advisory): the `hook_received` dual of
   * {@link skipPreload}. Set only by the queue consumer's idempotent
   * `hook_received` re-ensure on a lazy hook resume (alongside
   * {@link resumeId} + {@link resumePayloadDigest}). A World MAY return the
   * run's current replay event log with the event creation
   * (`events`/`cursor`/`hasMore`, plus `run` and `maxEvents`) so the runtime
   * can initialize replay from this one request and skip both the
   * `run_started` write and the initial `events.list`.
   *
   * The runtime trusts a returned preload as replay input ONLY when all of
   * the following hold (a World that cannot guarantee them should return
   * its normal {@link EventResult} instead):
   *
   * - `events` is the COMPLETE log with `hasMore: false` (the runtime has no
   *   cursor-continuation machinery on this path; a bounded page is
   *   rejected).
   * - `cursor` is a valid non-null resume point matching `events.list`
   *   semantics (present even on the final page).
   * - `run` (with `run.startedAt`) and `maxEvents` are present: this
   *   response plays `run_started`'s role, including the event-ceiling
   *   handshake.
   * - The log contains `run_created`, `run_started`, and the canonical
   *   `hook_received` carrying the requested {@link resumeId}.
   * - `events` uses the same ascending ordering semantics as `events.list`.
   * - The log is read atomically/consistently WITH (i.e. no earlier than)
   *   the `hook_received` write, so no concurrently committed event can be
   *   omitted from the replay input.
   *
   * Anything less and the runtime observes that no usable replay preload
   * came back and falls back to the existing `run_started` setup. A World
   * that ignores the param entirely remains fully correct. Only meaningful
   * for `hook_received`; ignored for other event types. Producer-side
   * `resumeHook()` must not set it.
   */
  preloadEvents?: true;
}

/**
 * Result of creating an event. Includes the created event and optionally
 * the entity that was created or updated as a result of the event, with any updates applied to it.
 *
 * Note: `event` is optional to support legacy runs where event storage is skipped.
 */
export type EventResult<T extends EventType = EventType> = {
  /** The created event (optional for legacy compatibility) */
  event?: Event;
  /** The workflow run entity (for run_* events) */
  run?: WorkflowRun;
  /** The step entity (for step_* events) */
  step?: Step;
  /** The hook entity (for hook_created events) */
  hook?: Hook;
  /** The wait entity (for wait_created/wait_completed events) */
  wait?: Wait;
  /**
   * Lazy step start: set to `true` only when a `step_started` event with
   * step-creation data atomically *created* the step on this call (the
   * caller won the create-claim), as opposed to transitioning a step that
   * already existed. The owned-inline runtime path uses this as the
   * exactly-once ownership signal: it runs the step body inline only when
   * it created the step, so a concurrent handler that lost the create race
   * (and gets `EntityConflictError`/skipped) never double-executes. Absent
   * (undefined) on the legacy path and from older servers/worlds, which is
   * the safe default (treated as "not the lazy creator").
   */
  stepCreated?: true;
  /** Server-owned max event count for the run (run-lifecycle responses); the runtime enforces it. */
  maxEvents?: number;
} & (
  | {
      /**
       * Events with data resolved. Four producers populate this:
       *
       * - On a `run_started` response: all events up to this point, so the
       *   runtime can skip the initial `events.list` call and reduce TTFB.
       * - On a step-terminal write (`step_completed` / `step_failed`) when
       *   the caller passed {@link CreateEventParams.sinceCursor}: the delta
       *   of events written strictly after that cursor, so the inline loop
       *   can skip the per-step incremental `events.list` round-trip.
       * - On a `hook_received` response when the caller passed
       *   {@link CreateEventParams.preloadEvents}: the run's current replay
       *   log through the canonical `hook_received`, so the lazy hook queue
       *   consumer can skip both the `run_started` write and the initial
       *   `events.list`.
       * - On any response whose committed slot came out higher than the one
       *   {@link CreateEventParams.eventCount} asked for:
       *   the events occupying the slots that were skipped over, in slot
       *   order. This is the "report" half of bump-and-report: the write
       *   succeeded, and these are the events the writer had not seen when it
       *   decided to make it.
       */
      events: Event[];
      /** Pagination cursor for `events`, matching events.list semantics. */
      cursor: string | null;
      /** Whether additional event pages are available for `events`. */
      hasMore: boolean;
    }
  | {
      events?: undefined;
      cursor?: undefined;
      hasMore?: undefined;
    }
) &
  (T extends 'run_created'
    ? { run: WorkflowRun }
    : T extends 'run_started'
      ? { run: StartedWorkflowRun }
      : T extends 'step_started'
        ? { step: StartedStep }
        : unknown);

/**
 * One event of a batch write ({@link Storage.events.createBatch}), in request
 * order, which is the order the events land in the run's log.
 */
export interface BatchEventRequest {
  /** The event, same discriminated union the single `create` takes. */
  event: CreateEventRequest;
  /**
   * Client event time for this event. Under slot identity this is the source
   * of the durable event's `createdAt` (a slot id carries no time), so the
   * timestamp a replay observes is the one the writer chose: set it to the
   * instant the event logically occurred.
   */
  occurredAt?: Date;
  /**
   * Compute-instance attribution for this event, same as the single create's
   * {@link CreateEventParams.computeInstanceId}. Set on the `step_started`
   * half of a pre-claimed inline pair so a batched claim attributes the
   * executing instance exactly like the lazy claim it replaces.
   */
  computeInstanceId?: string;
}

/** Per-batch parameters for {@link Storage.events.createBatch}. */
export interface CreateEventBatchParams {
  resolveData?: ResolveData;
  /**
   * Request id for per-write attribution, same as the single create's
   * {@link CreateEventParams.requestId}: stamped on every event in the batch
   * so a batched write's usage facts and telemetry carry the same request
   * attribution its single-path twin would.
   */
  requestId?: string;
}

/**
 * One event's outcome in a batch response, index-aligned with the submitted
 * events. `error === undefined` discriminates success.
 *
 * A batch is processed as a whole (HTTP 200 whenever the World evaluated it);
 * each event reports the outcome its OWN single `create` would have had:
 *
 * - success → `status: 200` plus the committed event and the same
 *   materialized entity the single create returns (`step` for step events,
 *   `wait` for wait events, `run` for run terminals);
 * - rejection → the status code and error code the single create would have
 *   failed with, so callers reuse their single-path conflict handling per
 *   event. A `409`/`conflict` means the entity was not in the prior state
 *   the event requires, most commonly because an earlier delivery already
 *   applied the same event, but possibly because the entity reached a
 *   DIFFERENT state (e.g. `step_completed` conflicting because the step
 *   failed). A 409 alone does not prove the equivalent effect was applied;
 *   a caller that needs effect-equivalence consults the entity (returned on
 *   sibling successes, or reloaded).
 *
 * The batch is atomic per attempt, not all-or-nothing across the submitted
 * set: a World may drop rejected events and commit the survivors, so a batch
 * can return a mix of 200s and 409s from one call.
 *
 * Retry semantics: a transport retry of a committed batch converges to
 * per-event 409s ONLY for entity-conditioned events: creates and terminal
 * transitions. A standalone bare `step_started` or a `step_retrying`
 * re-patches its step on every attempt and does NOT converge, and
 * `hook_received` appends a new row per attempt, so `world-vercel` rejects
 * `hook_received` in a batch outright and only auto-retries batches whose
 * every event is retry-convergent.
 *
 * The born-running `step_created`+`step_started` pair converges (the pair's
 * create fences it) but is still excluded from auto-retry, because
 * convergence alone is not enough for the caller: a pair 409 means "this step
 * already exists", and on a retry that is indistinguishable from "my own
 * previous attempt committed it". A caller that reads the 409 as a lost claim
 * would skip a body it actually owns, so a batch carrying a `step_started`
 * runs single-attempt and leaves transient-failure recovery to queue
 * redelivery.
 */
export type BatchEventItemResult =
  | {
      status: 200;
      error?: undefined;
      message?: undefined;
      event: Event;
      run?: WorkflowRun;
      step?: Step;
      wait?: Wait;
    }
  | {
      status: number;
      error: string;
      message: string;
      event?: undefined;
      run?: undefined;
      step?: undefined;
      wait?: undefined;
    };

/** Result of {@link Storage.events.createBatch}. */
export interface EventBatchResult {
  /** One entry per submitted event, in request order. */
  results: BatchEventItemResult[];
}

export interface GetEventParams {
  resolveData?: ResolveData;
}

export interface ListEventsParams {
  runId: string;
  /** Omit `limit` to return every remaining event. */
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}

export interface ListEventsByCorrelationIdParams {
  correlationId: string;
  /**
   * The run the correlation id belongs to. A correlation id is unique per
   * run, not globally: a slot-numbered run counts its own steps and waits, so
   * `step_…001` names the first step of *every* such run. Naming the run is
   * what makes the answer that run's events, and it is what makes the
   * pagination cursor unambiguous: `(runId, eventId)` is a key where an
   * event id alone is not.
   */
  runId: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
