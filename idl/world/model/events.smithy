$version: "2"

namespace vercel.workflow.world

/// Client-measured latency telemetry carried on a step's terminal event.
///
/// Populated only on the terminal event of a qualifying first-attempt step
/// execution. Implementations may consume these for metrics and are never
/// required to persist them.
structure StepLatencyTelemetry {
    /// Milliseconds from run creation until the run's first step body began.
    ttfs: Integer

    /// Milliseconds between the previous step's terminal event and this
    /// step's body beginning.
    stso: Integer

    /// Step count when the step-to-step gap began.
    stepCount: Integer

    /// Event count when the step-to-step gap began.
    eventCount: Integer

    /// Milliseconds from `run_started` landing until this step's start was
    /// issued. A sub-window of `ttfs`.
    rsfs: Integer

    /// Synchronous replay duration of the final scheduling pass within the
    /// `rsfs` window.
    finalSchedulingReplay: Integer

    /// Names of the runtime startup optimizations active for this
    /// measurement, e.g. `turbo` or `lazyStepStart`.
    optimizations: StringList
}

list StringList {
    member: String
}

/// Starts a new run. Materializes the run entity with status `pending`.
structure RunCreatedEvent {
    @required
    deploymentId: DeploymentId

    @required
    workflowName: WorkflowName

    @required
    input: SerializedData

    executionContext: Document

    attributes: AttributeMap

    allowReservedAttributes: Boolean

    /// Base64 X25519 public key, stamped by SDKs that support sealed
    /// envelopes.
    encryptionPublicKey: String
}

/// Transitions a run to `running`.
///
/// The optional creation fields carry the resilient-start path: when the
/// `run_created` write did not commit, the implementation creates the run
/// from this event instead.
structure RunStartedEvent {
    input: SerializedData

    deploymentId: DeploymentId

    workflowName: WorkflowName

    executionContext: Document

    attributes: AttributeMap

    allowReservedAttributes: Boolean

    encryptionPublicKey: String
}

/// Transitions a run to `completed`.
structure RunCompletedEvent {
    output: SerializedData
}

/// Transitions a run to `failed`.
structure RunFailedEvent {
    @required
    error: SerializedData

    /// Plaintext failure category kept readable without decryption.
    errorCode: String
}

/// Transitions a run to `cancelled`.
structure RunCancelledEvent {
    @length(max: 512)
    cancelReason: String
}

/// Identifies which writer produced an attribute change.
union AttributeWriter {
    workflow: WorkflowAttributeWriter
    step: StepAttributeWriter
}

/// The workflow function itself wrote the attributes.
structure WorkflowAttributeWriter {}

structure StepAttributeWriter {
    @required
    stepId: StepId

    @required
    attempt: Integer
}

/// Merges plaintext attribute changes into the run.
structure AttributesSetEvent {
    @required
    changes: AttributeChangeList

    @required
    writer: AttributeWriter

    /// Permits keys in the reserved `$` namespace. Framework callers only.
    allowReservedAttributes: Boolean
}

/// Creates a step entity.
structure StepCreatedEvent {
    @required
    stepName: StepName

    /// Carried so a backend keying payload refs by workflow name avoids a run
    /// lookup on this hot write.
    workflowName: WorkflowName

    @required
    input: SerializedData
}

/// Begins a step attempt, transitioning the step to `running`.
///
/// When `stepName` and `input` are present, this is the lazy-start path: the
/// implementation atomically creates the step (writing a synthetic
/// `step_created` so replay still observes it) before starting it. Without
/// `input`, a prior `step_created` is required.
structure StepStartedEvent {
    stepName: StepName

    attempt: Integer

    workflowName: WorkflowName

    input: SerializedData

    /// Queue message ID of the invocation executing this step inline. Doubles
    /// as the ownership liveness lease, so it requires a queue whose message
    /// ID is stable across redeliveries.
    ownerMessageId: String
}

/// Completes a step successfully.
structure StepCompletedEvent {
    stepName: StepName

    workflowName: WorkflowName

    @required
    result: SerializedData

    telemetry: StepLatencyTelemetry
}

/// Fails a step terminally.
structure StepFailedEvent {
    stepName: StepName

    @required
    error: SerializedData

    telemetry: StepLatencyTelemetry
}

/// Returns a failed step to `pending` for another attempt.
structure StepRetryingEvent {
    stepName: StepName

    @required
    error: SerializedData

    retryAfter: Timestamp
}

/// Creates a hook and claims its token.
structure HookCreatedEvent {
    @required
    token: String

    /// Requests minimum token retention past the run's end. Requires the
    /// `hookRetention` capability.
    tokenRetentionUntil: Timestamp

    metadata: SerializedData

    isWebhook: Boolean

    isSystem: Boolean
}

/// Delivers a payload to an active hook.
structure HookReceivedEvent {
    token: String

    @required
    payload: SerializedData
}

/// Disposes a hook and releases its token immediately.
structure HookDisposedEvent {
    token: String
}

/// Records that a `hook_created` lost a token race.
///
/// Implementations write this; callers cannot. Consumers reject the awaited
/// hook with a token-conflict error.
structure HookConflictEvent {
    @required
    token: String

    /// Run that currently owns the token.
    conflictingRunId: RunId
}

/// Creates a wait that resumes at a wall-clock time.
structure WaitCreatedEvent {
    @required
    resumeAt: Timestamp
}

/// Completes a wait. Intended to be atomic and exactly once.
structure WaitCompletedEvent {
    resumeAt: Timestamp
}

/// Every event a caller may write to an existing run.
///
/// `run_created` is absent because it creates the run and is modeled as
/// `CreateRun`. `hook_conflict` is absent because only implementations
/// produce it.
union CreatableEvent {
    runStarted: RunStartedEvent
    runCompleted: RunCompletedEvent
    runFailed: RunFailedEvent
    runCancelled: RunCancelledEvent
    attributesSet: AttributesSetEvent
    stepCreated: StepCreatedEvent
    stepStarted: StepStartedEvent
    stepCompleted: StepCompletedEvent
    stepFailed: StepFailedEvent
    stepRetrying: StepRetryingEvent
    hookCreated: HookCreatedEvent
    hookReceived: HookReceivedEvent
    hookDisposed: HookDisposedEvent
    waitCreated: WaitCreatedEvent
    waitCompleted: WaitCompletedEvent
}

/// Every event readable from a run's log.
union EventPayload {
    runCreated: RunCreatedEvent
    runStarted: RunStartedEvent
    runCompleted: RunCompletedEvent
    runFailed: RunFailedEvent
    runCancelled: RunCancelledEvent
    attributesSet: AttributesSetEvent
    stepCreated: StepCreatedEvent
    stepStarted: StepStartedEvent
    stepCompleted: StepCompletedEvent
    stepFailed: StepFailedEvent
    stepRetrying: StepRetryingEvent
    hookCreated: HookCreatedEvent
    hookReceived: HookReceivedEvent
    hookDisposed: HookDisposedEvent
    hookConflict: HookConflictEvent
    waitCreated: WaitCreatedEvent
    waitCompleted: WaitCompletedEvent
}

/// One committed entry in a run's event log.
structure Event {
    @required
    eventId: EventId

    @required
    runId: RunId

    /// Entity this event affects. Absent on run-level events.
    correlationId: CorrelationId

    @required
    payload: EventPayload

    specVersion: Integer

    /// When the implementation accepted the event.
    @required
    createdAt: Timestamp

    /// When the client observed the event, when it reported one.
    occurredAt: Timestamp

    /// Idempotency key persisted on a lazy `hook_received`.
    resumeId: String
}

list EventList {
    member: Event
}

/// Advisory and idempotency parameters for an event write.
///
/// Everything here is optional. An implementation that ignores all of it
/// stays correct; the runtime falls back to explicit reads.
structure CreateEventOptions {
    /// Legacy spec-version-1 compatibility mode.
    v1Compat: Boolean

    resolveData: ResolveData

    /// Lazy hook resume idempotency key. The implementation routes it to a
    /// `(runId, resumeId)` constraint so a producer's direct write and the
    /// queue consumer's re-ensure converge on exactly one event. Only
    /// meaningful for `hookReceived`.
    resumeId: String

    /// Digest of the serialized resume payload, sent identically by both
    /// writers of a deduplicated resume.
    resumePayloadDigest: String

    /// Marks a `stepCreated` write as the queue consumer's re-ensure of a
    /// resilient step dispatch.
    viaStepDispatch: Boolean

    /// Platform request ID, for correlating logs with events.
    requestId: String

    /// Compute instance whose handler is writing this event.
    computeInstanceId: String

    /// How many events the writer held when it decided to write this one.
    ///
    /// Only meaningful against an implementation advertising `slotEventIds`,
    /// where slots are dense and 1-based. Contention never rejects the write:
    /// the implementation bumps to the next free slot, commits, and returns
    /// the skipped events on the response. Understating is safe; overstating
    /// hides events from the writer.
    eventCount: Integer

    /// Client-side occurrence time, stored separately from the accept time.
    occurredAt: Timestamp

    /// Telemetry only: consecutive replay divergences resolved by this write.
    /// Never persisted into the log.
    replayDivergenceCount: Integer

    /// Inline-delta opt-in. The implementation may return the events written
    /// strictly after this cursor, matching `ListEvents` semantics.
    sinceCursor: Cursor

    /// Asks the implementation to skip the `runStarted` preload it would
    /// otherwise compute. Honored only for `runStarted`.
    skipPreload: Boolean

    /// Asks for the run's full replay log alongside a `hookReceived`
    /// re-ensure. The runtime trusts it only when the log is complete,
    /// `hasMore` is false, and the run and event ceiling are present.
    preloadEvents: Boolean
}

/// Result of an event write.
///
/// The event and the entity it affects are materialized atomically. The
/// delta members are populated when the caller opted into an inline delta or
/// preload, and by a slot-numbering implementation reporting the slots it
/// bumped past.
structure EventMutationResult {
    /// The committed event. Absent only for legacy runs that skip event
    /// storage.
    event: Event

    run: WorkflowRun

    step: Step

    hook: Hook

    wait: Wait

    /// True only when a lazy `stepStarted` created the step on this call.
    /// The caller that sees it owns inline execution of that step.
    stepCreated: Boolean

    /// Server-owned event ceiling for the run, enforced by the runtime.
    maxEvents: Integer

    /// Events the caller had not seen, in log order.
    events: EventList

    /// Cursor past the last returned event.
    cursor: Cursor

    /// Whether more event pages follow `events`.
    hasMore: Boolean
}

/// Creates a run.
///
/// The caller may mint the run ID or leave it absent for the implementation
/// to generate one.
operation CreateRun {
    input := {
        runId: RunId

        @required
        event: RunCreatedEvent

        options: CreateEventOptions
    }

    output: EventMutationResult

    errors: [
        BadRequestError
        ConflictError
        ThrottledError
        InternalError
    ]
}

/// Appends an event to a run's log and materializes its effect atomically.
///
/// This is the only way to change run, step, hook, or wait state.
operation CreateEvent {
    input := {
        @required
        runId: RunId

        @required
        event: CreatableEvent

        options: CreateEventOptions
    }

    output: EventMutationResult

    errors: [
        BadRequestError
        RunNotFoundError
        ConflictError
        ExpiredError
        PreconditionFailedError
        TooEarlyError
        ThrottledError
        InternalError
    ]
}

/// Reads one event.
@readonly
operation GetEvent {
    input := {
        @required
        runId: RunId

        @required
        eventId: EventId

        resolveData: ResolveData
    }

    output := {
        @required
        event: Event
    }

    errors: [
        RunNotFoundError
        EventNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Lists a run's event log.
///
/// Omitting `limit` requests every remaining event.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "events")
operation ListEvents {
    input := {
        @required
        runId: RunId

        resolveData: ResolveData

        @range(min: 1, max: 1000)
        limit: Integer

        cursor: Cursor

        sortOrder: SortOrder
    }

    output := {
        @required
        events: EventList

        cursor: Cursor

        @required
        hasMore: Boolean
    }

    errors: [
        RunNotFoundError
        BadRequestError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Lists the events of one run that share a correlation ID.
///
/// Correlation IDs are unique within a run, not globally, so the run is part
/// of the query.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "events")
operation ListEventsByCorrelationId {
    input := {
        @required
        runId: RunId

        @required
        correlationId: CorrelationId

        resolveData: ResolveData

        @range(min: 1, max: 1000)
        limit: Integer

        cursor: Cursor

        sortOrder: SortOrder
    }

    output := {
        @required
        events: EventList

        cursor: Cursor

        @required
        hasMore: Boolean
    }

    errors: [
        RunNotFoundError
        BadRequestError
        ExpiredError
        ThrottledError
        InternalError
    ]
}
