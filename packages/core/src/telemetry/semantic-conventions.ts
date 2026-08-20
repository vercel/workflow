/**
 * OpenTelemetry semantic conventions for Vercel Workflow telemetry.
 *
 * This module provides standardized telemetry attributes following OpenTelemetry semantic conventions
 * for instrumenting workflow execution, step processing, and related operations. Each exported function
 * creates a properly formatted attribute object that can be used with OpenTelemetry spans.
 *
 * The semantic conventions are organized into several categories:
 * - **Workflow attributes**: Track workflow lifecycle, status, and metadata
 * - **Step attributes**: Monitor individual step execution, retries, and results
 * - **Queue attributes**: Instrument message queue operations
 * - **Deployment attributes**: Capture deployment environment information
 *
 * All attribute functions are type-safe and leverage existing backend types to ensure
 * consistency between telemetry data and actual system state.
 *
 * @example
 * ```typescript
 * import * as Attribute from './telemetry/semantic-conventions.js';
 *
 * // Set workflow attributes on a span
 * span.setAttributes({
 *   ...Attribute.WorkflowName('my-workflow'),
 *   ...Attribute.WorkflowOperation('start'),
 *   ...Attribute.WorkflowRunStatus('running'),
 * });
 *
 * // Set step attributes
 * span.setAttributes({
 *   ...Attribute.StepName('process-data'),
 *   ...Attribute.StepStatus('completed'),
 *   ...Attribute.StepAttempt(1),
 * });
 * ```
 *
 * @see {@link https://opentelemetry.io/docs/specs/semconv/} OpenTelemetry Semantic Conventions
 * @packageDocumentation
 */

import type { MessageId, Step, WorkflowRun } from '@workflow/world';

/**
 * Creates a semantic convention function that returns an attribute object.
 * @param name - The attribute name following OpenTelemetry semantic conventions
 * @returns A function that takes a value and returns an attribute object
 */
function SemanticConvention<T>(...names: string[]) {
  return (value: T) =>
    Object.fromEntries(names.map((name) => [name, value] as const));
}

// Workflow attributes

/** The name of the workflow being executed */
export const WorkflowName = SemanticConvention<string>('workflow.name');

/** The operation being performed on the workflow */
export const WorkflowOperation = SemanticConvention<
  'start' | 'execute' | 'execute_v2' | 'run'
>('workflow.operation');

/** Unique identifier for a specific workflow run instance */
export const WorkflowRunId = SemanticConvention<string>('workflow.run.id');

/** Current status of the workflow run */
export const WorkflowRunStatus = SemanticConvention<
  WorkflowRun['status'] | 'workflow_suspended'
>('workflow.run.status');

/** Timestamp when the workflow execution started (Unix timestamp) */
export const WorkflowStartedAt = SemanticConvention<number>(
  'workflow.started_at'
);

/** Number of events processed during workflow execution */
export const WorkflowEventsCount = SemanticConvention<number>(
  'workflow.events.count'
);

/** Whether workflow execution starts with replay or resumes a retained VM */
export const WorkflowExecutionMode = SemanticConvention<'replay' | 'retained'>(
  'workflow.execution.mode'
);

/**
 * Events the replay walked past that no consumer claimed, still held when the
 * replay stopped.
 *
 * A non-zero count on a suspension is ordinary: an out-of-band delivery that
 * landed ahead of the code that reads it waits for the replay that gets there.
 * From inside one replay that is indistinguishable from an event no replay will
 * ever claim, because the two differ only in what the next replay does. So the
 * count goes on the span instead of failing the run, and the case worth acting
 * on is a query across a run's spans: the same
 * {@link WorkflowParkedEventId} held on suspension after suspension.
 */
export const WorkflowParkedEventsCount = SemanticConvention<number>(
  'workflow.events.parked.count'
);

/** Oldest event still held unclaimed when the replay stopped. */
export const WorkflowParkedEventId = SemanticConvention<string>(
  'workflow.events.parked.event_id'
);

/** Type of the oldest event still held unclaimed when the replay stopped. */
export const WorkflowParkedEventType = SemanticConvention<string>(
  'workflow.events.parked.event_type'
);

/** Number of arguments passed to the workflow */
export const WorkflowArgumentsCount = SemanticConvention<number>(
  'workflow.arguments.count'
);

/** Type of the workflow result */
export const WorkflowResultType = SemanticConvention<string>(
  'workflow.result.type'
);

/** Whether trace context was propagated to this workflow execution */
export const WorkflowTracePropagated = SemanticConvention<boolean>(
  'workflow.trace.propagated'
);

// QuickJS VM engine attributes

/** The VM engine executing the workflow function for this invocation */
export const WorkflowVm = SemanticConvention<'node' | 'quickjs'>('workflow.vm');

/** Outcome of a QuickJS VM workflow invocation */
export const QuickJSOutcome = SemanticConvention<
  'completed' | 'suspended' | 'failed'
>('workflow.vm.outcome');

/** Whether preloaded events from `events.create('run_started')` were used */
export const QuickJSEventsPreloaded = SemanticConvention<boolean>(
  'workflow.vm.events.preloaded'
);

/** Total number of events fetched from the world for this invocation */
export const QuickJSEventsFetchedCount = SemanticConvention<number>(
  'workflow.vm.events.fetched_count'
);

/** Number of pages required to fetch all events */
export const QuickJSEventsFetchedPages = SemanticConvention<number>(
  'workflow.vm.events.fetched_pages'
);

/** Number of pending VM operations captured at suspension */
export const QuickJSPendingOpsCount = SemanticConvention<number>(
  'workflow.vm.pending_ops_count'
);

/** Number of steps executed inline (live-VM continuation) this invocation */
export const QuickJSInlineSteps = SemanticConvention<number>(
  'quickjs.inline_steps'
);

/** Active trace-correlation mode for this invocation (linked or continuous) */
export const WorkflowTraceMode = SemanticConvention<'linked' | 'continuous'>(
  'workflow.trace.mode'
);

/** Whether this workflow invocation is using the turbo first-delivery path */
export const WorkflowTurbo = SemanticConvention<boolean>('workflow.turbo');

/** Name of the error that caused workflow failure */
export const WorkflowErrorName = SemanticConvention<string>(
  'workflow.error.name'
);

/** Error message when workflow fails */
export const WorkflowErrorMessage = SemanticConvention<string>(
  'workflow.error.message'
);

/** Error classification code (USER_ERROR, RUNTIME_ERROR, etc.) */
export const WorkflowErrorCode = SemanticConvention<string>(
  'workflow.error.code'
);

/** Number of steps created during workflow execution */
export const WorkflowStepsCreated = SemanticConvention<number>(
  'workflow.steps.created'
);

/** Number of hooks created during workflow execution */
export const WorkflowHooksCreated = SemanticConvention<number>(
  'workflow.hooks.created'
);

/** Number of waits created during workflow execution */
export const WorkflowWaitsCreated = SemanticConvention<number>(
  'workflow.waits.created'
);

/**
 * Number of steps this suspension finalized as failed because their
 * arguments refused to serialize (step_created placeholder + step_failed
 * carrying the SerializationError — see finalizeUnserializableStep).
 */
export const WorkflowStepsFailedSerialization = SemanticConvention<number>(
  'workflow.steps.failed_serialization'
);

/**
 * Number of inline-owned steps this invocation re-executed because it is a
 * redelivery of their owning queue message (crash recovery for inline
 * steps — see the inline step ownership changelog, workflow#2780).
 */
export const WorkflowOwnedRecoverySteps = SemanticConvention<number>(
  'workflow.inline_ownership.owned_recovery_steps'
);

/**
 * Number of pending steps for which this replay suppressed the immediate
 * requeue (another invocation inline-owns them under a live lease) and
 * ensured a delayed backstop wake instead.
 */
export const WorkflowBackstopWakesArmed = SemanticConvention<number>(
  'workflow.inline_ownership.backstop_wakes_armed'
);

// Route attributes

/** The workflow runtime route being handled */
export const WorkflowRouteType = SemanticConvention<'flow'>(
  'workflow.route.type'
);

/** Whether this route invocation reused an already-created request handler */
export const WorkflowRouteHandlerCached = SemanticConvention<boolean>(
  'workflow.route.handler_cached'
);

/** Number of times this in-memory route handler has been invoked */
export const WorkflowRouteInvocationCount = SemanticConvention<number>(
  'workflow.route.invocation_count'
);

/** Time since this route entrypoint was constructed, in milliseconds */
export const WorkflowRouteEntrypointAgeMs = SemanticConvention<number>(
  'workflow.route.entrypoint_age_ms'
);

/** Time spent evaluating the generated route module body before creating the entrypoint */
export const WorkflowRouteModuleBodyInitMs = SemanticConvention<number>(
  'workflow.route.module_body_init_ms'
);

/**
 * Compute instance handling this route — the synthesized `COMPUTE_INSTANCE_ID`.
 * Uses OTEL `faas.instance` (execution-environment id, reused across
 * invocations to the same function):
 * https://opentelemetry.io/docs/specs/semconv/attributes-registry/faas/
 */
export const FaasInstance = SemanticConvention<string>('faas.instance');

// Step attributes

/** Name of the step function being executed */
export const StepName = SemanticConvention<string>('step.name');

/** Unique identifier for the step instance */
export const StepId = SemanticConvention<string>('step.id');

/** Current attempt number for step execution (starts at 1) */
export const StepAttempt = SemanticConvention<number>('step.attempt');

/** Current status of the step */
export const StepStatus = SemanticConvention<Step['status']>('step.status');

/** Maximum number of retries allowed for this step */
export const StepMaxRetries = SemanticConvention<number>('step.max_retries');

/** Whether trace context was propagated to this step execution */
export const StepTracePropagated = SemanticConvention<boolean>(
  'step.trace.propagated'
);

/**
 * Client-measured time-to-first-step latency in milliseconds: run creation →
 * this step's body beginning to execute, minus pre-step hook-creation time.
 * Only present on the run's first step execution when it qualified for
 * measurement (see runtime/step-latency.ts).
 */
export const StepTtfsMs = SemanticConvention<number>('step.ttfs_ms');

/**
 * Client-measured step-to-step overhead in milliseconds: the previous step's
 * terminal event → this step's body beginning to execute. Only present when
 * the two steps ran back-to-back.
 */
export const StepStsoMs = SemanticConvention<number>('step.stso_ms');

/**
 * Client-measured run_started-to-first-step latency in milliseconds: the
 * `run_started` response landing (or, under turbo, the local run synthesis
 * instant) → this step's start POST being issued. A sub-window of ttfs that
 * isolates replay overhead from the run-creation queue hop. Only present on
 * the run's first step execution when it qualified for measurement (see
 * runtime/step-latency.ts).
 */
export const StepRsfsMs = SemanticConvention<number>('step.rsfs_ms');

/**
 * Client-measured synchronous workflow-function replay duration in
 * milliseconds, excluding awaited network I/O, of only the FINAL replay pass
 * within the rsfs window — the pass that reached and scheduled the first
 * step. Not accumulated across earlier pre-first-step passes (e.g. a
 * workflow-body `setAttributes()` detour replays more than once, and a
 * redelivery omits earlier invocations' work entirely), so this must not be
 * read as "the replay portion of rsfs" — step.rsfs_ms covers the whole
 * window. Only present alongside step.rsfs_ms and only for the run's first
 * step (see runtime/step-latency.ts).
 */
export const StepFinalSchedulingReplayMs = SemanticConvention<number>(
  'step.final_scheduling_replay_ms'
);

/**
 * Runtime startup-latency optimizations active for the ttfs/stso measurement
 * (e.g. 'turbo', 'lazyStepStart', 'optimisticStart').
 */
export const StepLatencyOptimizations = SemanticConvention<string[]>(
  'step.latency_optimizations'
);

/** Whether the step was skipped during execution */
export const StepSkipped = SemanticConvention<boolean>('step.skipped');

/** Reason why the step was skipped */
export const StepSkipReason =
  SemanticConvention<Step['status']>('step.skip_reason');

/** Number of arguments passed to the step function */
export const StepArgumentsCount = SemanticConvention<number>(
  'step.arguments.count'
);

/** Type of the step result */
export const StepResultType = SemanticConvention<string>('step.result.type');

/** Name of the error that caused step failure */
export const StepErrorName = SemanticConvention<string>('step.error.name');

/** Error message when step fails */
export const StepErrorMessage =
  SemanticConvention<string>('step.error.message');

/** Whether the step failed with a fatal error (no retries) */
export const StepFatalError = SemanticConvention<boolean>('step.fatal_error');

/** Whether all retry attempts have been exhausted */
export const StepRetryExhausted = SemanticConvention<boolean>(
  'step.retry.exhausted'
);

/** Number of seconds to wait before next retry attempt */
export const StepRetryTimeoutSeconds = SemanticConvention<number>(
  'step.retry.timeout_seconds'
);

/** Whether the step will be retried after this failure */
export const StepRetryWillRetry = SemanticConvention<boolean>(
  'step.retry.will_retry'
);

// Queue/Messaging attributes - Standard OTEL messaging conventions
// See: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/

/** Messaging system identifier (standard OTEL: messaging.system) */
export const MessagingSystem = SemanticConvention<string>('messaging.system');

/** Destination name/queue name (standard OTEL: messaging.destination.name) */
export const MessagingDestinationName = SemanticConvention<string>(
  'messaging.destination.name'
);

/** The message id being handled (standard OTEL: messaging.message.id) */
export const MessagingMessageId = SemanticConvention<MessageId>(
  'messaging.message.id'
);

/** Operation type (standard OTEL: messaging.operation.type) */
export const MessagingOperationType = SemanticConvention<
  'publish' | 'receive' | 'process'
>('messaging.operation.type');

/** Time taken to enqueue the message in milliseconds (workflow-specific) */
export const QueueOverheadMs = SemanticConvention<number>(
  'workflow.queue.overhead_ms'
);

// Deployment attributes

/** Unique identifier for the deployment environment */
export const DeploymentId = SemanticConvention<string>('deployment.id');

/** The deployment a run is pinned to, set only on a misrouted delivery. */
export const WorkflowRunPinnedDeploymentId = SemanticConvention<string>(
  'workflow.deployment.pinned_id'
);

/** Re-route attempts for this misrouted delivery, including this one. */
export const WorkflowDeploymentMismatchRetryCount = SemanticConvention<number>(
  'workflow.deployment_mismatch.retry_count'
);

/** Whether the misrouted delivery was re-routed instead of failing the run. */
export const WorkflowDeploymentMismatchRecovered = SemanticConvention<boolean>(
  'workflow.deployment_mismatch.recovered'
);

// Hook attributes

/** Token identifying a specific hook */
export const HookToken = SemanticConvention<string>('workflow.hook.token');

/** Unique identifier for a hook instance */
export const HookId = SemanticConvention<string>('workflow.hook.id');

/** Whether a hook was found by its token */
export const HookFound = SemanticConvention<boolean>('workflow.hook.found');

/**
 * Producer-side signal (on the `hook.resume` span) that the direct
 * `hook_received` write failed transiently but the queue dispatch succeeded, so
 * the resume is recovered via the consumer's re-ensure. Corresponds to
 * `ResumedHook.resilientResume === true`.
 */
export const HookResilientResume = SemanticConvention<boolean>(
  'workflow.hook.resilient_resume'
);

/**
 * Consumer-side signal (on the workflow execution span) that this replay
 * materialized the `hook_received` event from the queue message's `hookInput`
 * because the producer's direct write had not landed — the completion of the
 * recovery path {@link HookResilientResume} began.
 *
 * Legacy / non-atomic re-ensure signal only. Atomic lazy resumes
 * (resumeId + digest) go through the hoisted preload write instead, whose
 * response cannot tell whether the producer or the consumer won the
 * `(runId, resumeId)` claim — so this attribute is deliberately NOT emitted
 * for them (emitting `true` unconditionally would count every producer-won
 * resume as a recovery). The producer-begin ({@link HookResilientResume}) /
 * consumer-materialized pairing is therefore no longer complete for atomic
 * lazy resumptions; use {@link HookResumeSetupSource} to observe that path.
 */
export const HookResilientResumeMaterialized = SemanticConvention<boolean>(
  'workflow.hook.resilient_resume_materialized'
);

/**
 * Consumer-side signal (on the workflow execution span) of how a lazy hook
 * resume initialized its replay state:
 *
 * - `hook_received_stream` — the hoisted `hook_received` write returned a
 *   usable replay preload (run + complete event log), so the invocation
 *   skipped both the `run_started` write and the initial `events.list`.
 * - `hook_received_fallback` — the hoisted write succeeded but returned no
 *   usable preload (a CBOR response from an older server, a World that
 *   ignored the opt-in, a bounded `hasMore` page, or a preload that failed
 *   validation); the invocation fell back to the `run_started` setup without
 *   re-posting the hook.
 *
 * Absent on legacy hook deliveries (no resumeId/digest) and on every other
 * delivery kind, which take the `run_started` setup unconditionally.
 *
 * This is a latency/setup-path signal: it says which requests initialized
 * the invocation, NOT that this consumer created the `hook_received` event
 * (the hoisted write may equally have converged on the producer's — claim
 * ownership is not observable client-side; cf.
 * {@link HookResilientResumeMaterialized}).
 */
export const HookResumeSetupSource = SemanticConvention<string>(
  'workflow.resume_setup_source'
);

/**
 * Producer-side signal (on the suspension span) counting steps whose direct
 * `step_created` write failed transiently while their `stepInput`-carrying
 * queue publish succeeded, so step creation is recovered via the consumer's
 * re-ensure. Mirrors {@link HookResilientResume}.
 */
export const StepResilientDispatchRecovered = SemanticConvention<number>(
  'workflow.step.resilient_dispatch_recovered'
);

/**
 * Consumer-side signal (on the workflow execution span) that this delivery
 * materialized the `step_created` event from the queue message's `stepInput`
 * because the producer's direct write had not landed — the completion of the
 * recovery path {@link StepResilientDispatchRecovered} began.
 */
export const StepResilientDispatchMaterialized = SemanticConvention<boolean>(
  'workflow.step.resilient_dispatch_materialized'
);

// Hook-triggered time-to-resume (TTR) attributes
//
// Set on the `step.execute <name>` span of the FIRST durable step following a
// hook resume, and only there: one resumption produces exactly one sample, so
// a later step in the same invocation, a retry, or a redelivery never
// re-reports it. The phases are non-overlapping and sum exactly to
// {@link ResumeTotalMs} — see runtime/resume-latency.ts for the boundary
// definitions and the emission gate.
//
// Deliberately carries no `resumeId`, run ID, or token: the metric is meant to
// be aggregated across every resume, and high-cardinality keys would make that
// prohibitive. Existing trace-correlation fields on the same span are
// unchanged and still identify the individual run.

/** Total TTR: entry into `resumeHook()` → immediately before `stepFn.apply()`. */
export const ResumeTotalMs = SemanticConvention<number>(
  'workflow.resume.total_ms'
);

/** Phase: `resumeHook()` entry → the queue publish being requested. */
export const ResumeProducerPrepMs = SemanticConvention<number>(
  'workflow.resume.phase.producer_prep_ms'
);

/** Phase: queue publish requested → the final consumer's handler being entered. */
export const ResumeQueueDeliveryMs = SemanticConvention<number>(
  'workflow.resume.phase.queue_delivery_ms'
);

/** Phase: consumer entry → replay beginning. */
export const ResumeSetupMs = SemanticConvention<number>(
  'workflow.resume.phase.resume_setup_ms'
);

/** Phase: replay beginning → the next durable step being encountered. */
export const ResumeReplayMs = SemanticConvention<number>(
  'workflow.resume.phase.replay_ms'
);

/** Phase: step encountered → the `step_started` request beginning. */
export const ResumeStepDispatchMs = SemanticConvention<number>(
  'workflow.resume.phase.step_dispatch_ms'
);

/**
 * Phase: `step_started` request beginning → its response returning. Omitted
 * under optimistic inline start, where the claim is not awaited before the
 * body runs and therefore has no completion instant at that point; the time
 * is then reported entirely as {@link ResumeStepPrepareMs}.
 */
export const ResumeStepClaimMs = SemanticConvention<number>(
  'workflow.resume.phase.step_claim_ms'
);

/**
 * Phase: claim returning → immediately before `stepFn.apply()`. Deliberately
 * includes encryption-key resolution, argument hydration, and step-context
 * setup; `workflow.queue.deserialize_time_ms` still isolates hydration.
 */
export const ResumeStepPrepareMs = SemanticConvention<number>(
  'workflow.resume.phase.step_prepare_ms'
);

/** What triggered the measured resumption. */
export const ResumeTrigger = SemanticConvention<'hook'>(
  'workflow.resume.trigger'
);

/** Which `resumeHook()` dispatch path produced this resume. */
export const ResumeStrategy = SemanticConvention<'parallel' | 'sequential'>(
  'workflow.resume.strategy'
);

/**
 * How the consuming invocation initialized replay state. Distinct from the
 * pre-existing {@link HookResumeSetupSource} (`workflow.resume_setup_source`,
 * on the workflow execution span), which reports the finer-grained
 * hoisted-write outcome; this one is the TTR dimension and shares the metric's
 * three-value vocabulary.
 */
export const ResumeSetupSource = SemanticConvention<
  'hook_preload' | 'run_started' | 'event_load'
>('workflow.resume.setup_source');

/** Whether the measured step ran in the resuming invocation or a queued one. */
export const ResumeStepExecution = SemanticConvention<'inline' | 'dispatched'>(
  'workflow.resume.step_execution'
);

// Webhook attributes

/** Number of webhook handlers triggered */
export const WebhookHandlersTriggered = SemanticConvention<number>(
  'webhook.handlers.triggered'
);

// Suspension attributes

export const WorkflowSuspensionState = SemanticConvention<'suspended'>(
  'workflow.suspension.state'
);
export const WorkflowSuspensionHookCount = SemanticConvention<number>(
  'workflow.suspension.hook_count'
);
export const WorkflowSuspensionStepCount = SemanticConvention<number>(
  'workflow.suspension.step_count'
);
export const WorkflowSuspensionWaitCount = SemanticConvention<number>(
  'workflow.suspension.wait_count'
);

// World/Storage attributes - Standard OTEL HTTP conventions
// See: https://opentelemetry.io/docs/specs/semconv/http/http-spans/

/** HTTP request method (standard OTEL: http.request.method) */
export const HttpRequestMethod = SemanticConvention<string>(
  'http.request.method'
);

/** Route pattern for the request (standard OTEL: http.route) */
export const HttpRoute = SemanticConvention<string>('http.route');

/** Full URL of the request (standard OTEL: url.full) */
export const UrlFull = SemanticConvention<string>('url.full');

/** Server hostname (standard OTEL: server.address) */
export const ServerAddress = SemanticConvention<string>('server.address');

/** Server port (standard OTEL: server.port) */
export const ServerPort = SemanticConvention<number>('server.port');

/** HTTP response status code (standard OTEL: http.response.status_code) */
export const HttpResponseStatusCode = SemanticConvention<number>(
  'http.response.status_code'
);

/** Error type when request fails (standard OTEL: error.type) */
export const ErrorType = SemanticConvention<string>('error.type');

// World-specific custom attributes (for workflow-specific context)

/** Format used for parsing response body (cbor or json) */
export const WorldParseFormat = SemanticConvention<'cbor' | 'json'>(
  'workflow.world.parse.format'
);

// Event loading attributes

/** Number of pagination pages loaded when fetching workflow events */
export const WorkflowEventsPagesLoaded = SemanticConvention<number>(
  'workflow.events.pages_loaded'
);

// Queue timing breakdown attributes (workflow-specific)

/** Time spent deserializing the queue message in milliseconds */
export const QueueDeserializeTimeMs = SemanticConvention<number>(
  'workflow.queue.deserialize_time_ms'
);

/** Time spent executing the handler logic in milliseconds */
export const QueueExecutionTimeMs = SemanticConvention<number>(
  'workflow.queue.execution_time_ms'
);

/** Time spent serializing the response in milliseconds */
export const QueueSerializeTimeMs = SemanticConvention<number>(
  'workflow.queue.serialize_time_ms'
);

// Payload compression attributes (zstd preferred, gzip fallback; specVersion >= 5)
//
// Sizes are measured at the compression boundary: before encryption on the
// write path and after decryption on the read path. They therefore reflect
// compression's effect, not the at-rest size (which also includes the
// ~28-byte `encr` envelope and, on some backends, base64 expansion).

/** Whether this serialize/deserialize was a write or read. */
export const SerializationOperation = SemanticConvention<
  'serialize' | 'deserialize'
>('workflow.serialization.operation');

/** Whether a compression codec was applied (write) / present (read). */
export const SerializationCompressed = SemanticConvention<boolean>(
  'workflow.serialization.compressed'
);

/** Which compression codec applied / was present (`zstd`, `gzip`, or `none`). */
export const SerializationCodec = SemanticConvention<'zstd' | 'gzip' | 'none'>(
  'workflow.serialization.codec'
);

/** Logical (uncompressed, devalue-prefixed) payload size in bytes. */
export const SerializationUncompressedBytes = SemanticConvention<number>(
  'workflow.serialization.uncompressed_bytes'
);

/** Stored (post-compression, pre-encryption) payload size in bytes. */
export const SerializationStoredBytes = SemanticConvention<number>(
  'workflow.serialization.stored_bytes'
);

/** Fraction of bytes saved by compression (0..1); set only when compressed. */
export const SerializationCompressionRatio = SemanticConvention<number>(
  'workflow.serialization.compression_ratio'
);

/**
 * Number of workflow (guest) code executions serialization could not avoid
 * (getters, proxies, custom serializers); set only when non-zero.
 */
export const SerializationGuestCodeExecutions = SemanticConvention<number>(
  'workflow.serialization.guest_code_executions'
);

/**
 * Deduplicated `kind (detail)` descriptions of the guest-code executions;
 * set only when non-zero.
 */
export const SerializationGuestCodeDetails = SemanticConvention<string[]>(
  'workflow.serialization.guest_code_details'
);

// RPC/Peer Service attributes - For service maps and dependency tracking
// See: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/

/** The remote service name for Datadog service maps (Datadog-specific: peer.service) */
export const PeerService = SemanticConvention<string>('peer.service');

/** RPC system identifier (standard OTEL: rpc.system) */
export const RpcSystem = SemanticConvention<string>('rpc.system');

/** RPC service name (standard OTEL: rpc.service) */
export const RpcService = SemanticConvention<string>('rpc.service');

/** RPC method name (standard OTEL: rpc.method) */
export const RpcMethod = SemanticConvention<string>('rpc.method');

// Error attributes - Standard OTEL error conventions
// See: https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/

/** Whether the error is retryable (workflow-specific) */
export const ErrorRetryable = SemanticConvention<boolean>('error.retryable');

/** Error category (workflow-specific: fatal, retryable, transient) */
export const ErrorCategory = SemanticConvention<
  'fatal' | 'retryable' | 'transient'
>('error.category');
