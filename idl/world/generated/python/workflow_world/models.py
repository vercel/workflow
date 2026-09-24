"""Generated from the Smithy model. Do not edit by hand.

Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, AsyncIterable, Optional, Union

from ._base import WorldError


"""An unbounded byte stream."""
ByteStream = AsyncIterable[bytes]

"""Correlation identifier tying an event to the entity it affects."""
CorrelationId = str

"""Opaque, implementation-defined pagination cursor."""
Cursor = str

"""Identifier of a deployment a run is pinned to."""
DeploymentId = str

"""A ready-to-use AES-256 key."""
EncryptionKey = bytes

"""Identifier of an event within a run's log."""
EventId = str

"""Identifier of a hook."""
HookId = str

"""Queue message identifier.

Should be stable across redeliveries of one enqueued message: the
runtime's inline step ownership uses it as a liveness lease. An
implementation that mints a fresh ID per delivery still works, but owner
redeliveries fall back to the slower backstop path.
"""
MessageId = str

"""Logical queue name, e.g. a flow or step topic."""
QueueName = str

"""Opaque queue payload.

The runtime's invoke and health-check payload schemas are deliberately
not modeled yet: they are producer-and-consumer-private, versioned by
run spec version, and encoded as CBOR or JSON depending on that version.
Modeling them belongs in a follow-up once the transport story is
settled.
"""
QueuePayload = bytes

"""Identifier of a workflow run."""
RunId = str

"""Opaque serialized workflow data.

Payload bytes are produced by the SDK serialization pipeline and may be
compressed and/or encrypted. The World never interprets them. Runs
created by spec version 1 carried unserialized JSON instead; those
records are not representable here and must be converted by a
compatibility adapter.
"""
SerializedData = bytes

"""Identifier of a step within a run."""
StepId = str

"""Machine-readable step function name."""
StepName = str

"""Name of a stream within a run."""
StreamName = str

"""Identifier of a wait."""
WaitId = str

"""Machine-readable workflow function name, e.g.
`workflow//./src/workflows/order//processOrder`.
"""
WorkflowName = str


class ResolveData(str, Enum):
    """Controls whether payload-bearing fields are resolved in a response.

    Smithy cannot vary an output shape by an input value, so payload members
    stay optional and `NONE` simply leaves them absent.
    """
    """Omit payload fields such as input, output, error, and metadata."""
    NONE = "none"
    """Resolve all payload fields."""
    ALL = "all"


class RunStatus(str, Enum):
    """Lifecycle status of a run."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SortOrder(str, Enum):
    """Sort direction for list operations, ordered by creation time."""
    ASC = "asc"
    DESC = "desc"


class StepStatus(str, Enum):
    """Lifecycle status of a step."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

AttributeChangeList = list["AttributeChange"]

BulkCancelResultList = list["BulkCancelResult"]

CapabilityNameList = list["str"]

ChunkDataList = list["bytes"]

EventList = list["Event"]

HookList = list["Hook"]

RunIdList = list["RunId"]

SparseWorkflowRunList = list["Optional[WorkflowRun]"]

StepList = list["Step"]

StreamChunkList = list["StreamChunk"]

StreamNameList = list["StreamName"]

StringList = list["str"]

WorkflowRunList = list["WorkflowRun"]

AttributeMap = dict["str", "str"]

QueueHeaders = dict["str", "str"]

RunDisplayFields = dict["str", "Optional[str]"]

TraceCarrier = dict["str", "str"]


@dataclass
class AlreadyCancelledOutcome:
    pass


@dataclass
class AttributeChange:
    """A single attribute mutation. Keys absent from a change set are
    untouched.
    """

    key: "str"
    change: "AttributeChangeValue"


@dataclass
class AttributesSetEvent:
    """Merges plaintext attribute changes into the run."""

    changes: "AttributeChangeList"
    writer: "AttributeWriter"
    allow_reserved_attributes: "Optional[bool]" = None
    """Permits keys in the reserved `$` namespace. Framework callers only."""


@dataclass
class BatchGetRunsInput:
    run_ids: "RunIdList"
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class BatchGetRunsOutput:
    runs: "SparseWorkflowRunList"


@dataclass
class BulkCancelFailure:
    code: "str"
    retryable: "bool"


@dataclass
class BulkCancelResult:
    run_id: "RunId"
    outcome: "BulkCancelOutcome"


@dataclass
class BulkCancelRunsInput:
    run_ids: "RunIdList"
    """1-500 unique run IDs."""
    cancel_reason: "Optional[str]" = None


@dataclass
class BulkCancelRunsOutput:
    summary: "BulkCancelSummary"
    results: "BulkCancelResultList"
    """One entry per requested ID, in request order."""


@dataclass
class BulkCancelSummary:
    requested: "int"
    cancelled: "int"
    already_cancelled: "int"
    not_cancellable: "int"
    not_found: "int"
    failed: "int"


@dataclass
class CancelledOutcome:
    pass


@dataclass
class CloseStreamInput:
    run_id: "RunId"
    name: "StreamName"


@dataclass
class CloseStreamOutput:
    pass


@dataclass
class CreateEventInput:
    run_id: "RunId"
    event: "CreatableEvent"
    options: "Optional[CreateEventOptions]" = None


@dataclass
class CreateEventOptions:
    """Advisory and idempotency parameters for an event write.

    Everything here is optional. An implementation that ignores all of it
    stays correct; the runtime falls back to explicit reads.
    """

    v1_compat: "Optional[bool]" = None
    """Legacy spec-version-1 compatibility mode."""
    resolve_data: "Optional[ResolveData]" = None
    resume_id: "Optional[str]" = None
    """Lazy hook resume idempotency key. The implementation routes it to a
    `(runId, resumeId)` constraint so a producer's direct write and the
    queue consumer's re-ensure converge on exactly one event. Only
    meaningful for `hookReceived`.
    """
    resume_payload_digest: "Optional[str]" = None
    """Digest of the serialized resume payload, sent identically by both
    writers of a deduplicated resume.
    """
    via_step_dispatch: "Optional[bool]" = None
    """Marks a `stepCreated` write as the queue consumer's re-ensure of a
    resilient step dispatch.
    """
    request_id: "Optional[str]" = None
    """Platform request ID, for correlating logs with events."""
    compute_instance_id: "Optional[str]" = None
    """Compute instance whose handler is writing this event."""
    event_count: "Optional[int]" = None
    """How many events the writer held when it decided to write this one.

    Only meaningful against an implementation advertising `slotEventIds`,
    where slots are dense and 1-based. Contention never rejects the write:
    the implementation bumps to the next free slot, commits, and returns the
    skipped events on the response. Understating is safe; overstating hides
    events from the writer.
    """
    occurred_at: "Optional[datetime]" = None
    """Client-side occurrence time, stored separately from the accept time."""
    replay_divergence_count: "Optional[int]" = None
    """Telemetry only: consecutive replay divergences resolved by this write.
    Never persisted into the log.
    """
    since_cursor: "Optional[Cursor]" = None
    """Inline-delta opt-in. The implementation may return the events written
    strictly after this cursor, matching `ListEvents` semantics.
    """
    skip_preload: "Optional[bool]" = None
    """Asks the implementation to skip the `runStarted` preload it would
    otherwise compute. Honored only for `runStarted`.
    """
    preload_events: "Optional[bool]" = None
    """Asks for the run's full replay log alongside a `hookReceived` re-ensure.
    The runtime trusts it only when the log is complete, `hasMore` is false,
    and the run and event ceiling are present.
    """


@dataclass
class CreateRunIdInput:
    options: "Optional[Any]" = None
    """The full options bag passed to `start()`. Implementations read only the
    keys they recognize and ignore the rest.
    """


@dataclass
class CreateRunIdOutput:
    run_id: "RunId"


@dataclass
class CreateRunInput:
    event: "RunCreatedEvent"
    run_id: "Optional[RunId]" = None
    options: "Optional[CreateEventOptions]" = None


@dataclass
class DeliverQueueMessageInput:
    queue_name: "QueueName"
    message: "QueuePayload"
    attempt: "int"
    """1-based delivery attempt."""
    message_id: "MessageId"
    request_id: "Optional[str]" = None


@dataclass
class DeliverQueueMessageOutput:
    retry: "Optional[RetryDirective]" = None
    """Present when the runtime wants the message redelivered instead of
    acknowledged.
    """


@dataclass
class DescribeRunInput:
    run: "Any"
    """The run entity as the caller holds it, which may be a lean observability
    row rather than a full record.
    """


@dataclass
class DescribeRunOutput:
    fields: "Optional[RunDisplayFields]" = None


@dataclass
class EnqueueInput:
    queue_name: "QueueName"
    message: "QueuePayload"
    options: "Optional[EnqueueOptions]" = None


@dataclass
class EnqueueOptions:
    deployment_id: "Optional[DeploymentId]" = None
    """Target a specific deployment rather than the current one."""
    idempotency_key: "Optional[str]" = None
    headers: "Optional[QueueHeaders]" = None
    delay_seconds: "Optional[int]" = None
    """Delay delivery by this many seconds."""
    spec_version: "Optional[int]" = None
    """Spec version of the target run, which selects the transport format."""
    region: "Optional[str]" = None
    """Routing hint naming the region the message should be sent to."""


@dataclass
class EnqueueOutput:
    message_id: "Optional[MessageId]" = None
    """Assigned message ID, when the queue reports one."""


@dataclass
class Event:
    """One committed entry in a run's event log."""

    event_id: "EventId"
    run_id: "RunId"
    payload: "EventPayload"
    created_at: "datetime"
    """When the implementation accepted the event."""
    correlation_id: "Optional[CorrelationId]" = None
    """Entity this event affects. Absent on run-level events."""
    spec_version: "Optional[int]" = None
    occurred_at: "Optional[datetime]" = None
    """When the client observed the event, when it reported one."""
    resume_id: "Optional[str]" = None
    """Idempotency key persisted on a lazy `hook_received`."""


@dataclass
class EventMutationResult:
    """Result of an event write.

    The event and the entity it affects are materialized atomically. The
    delta members are populated when the caller opted into an inline delta
    or preload, and by a slot-numbering implementation reporting the slots
    it bumped past.
    """

    event: "Optional[Event]" = None
    """The committed event. Absent only for legacy runs that skip event
    storage.
    """
    run: "Optional[WorkflowRun]" = None
    step: "Optional[Step]" = None
    hook: "Optional[Hook]" = None
    wait: "Optional[Wait]" = None
    step_created: "Optional[bool]" = None
    """True only when a lazy `stepStarted` created the step on this call. The
    caller that sees it owns inline execution of that step.
    """
    max_events: "Optional[int]" = None
    """Server-owned event ceiling for the run, enforced by the runtime."""
    events: "Optional[EventList]" = None
    """Events the caller had not seen, in log order."""
    cursor: "Optional[Cursor]" = None
    """Cursor past the last returned event."""
    has_more: "Optional[bool]" = None
    """Whether more event pages follow `events`."""


@dataclass
class GetDeploymentIdInput:
    pass


@dataclass
class GetDeploymentIdOutput:
    deployment_id: "DeploymentId"


@dataclass
class GetEncryptionKeyForRunInput:
    run_id: "RunId"
    context: "Optional[Any]" = None
    """Opaque world-specific context, such as a deployment ID, used when the
    run entity is not available locally.
    """


@dataclass
class GetEncryptionKeyForRunOutput:
    key: "Optional[EncryptionKey]" = None


@dataclass
class GetEnvironmentInput:
    pass


@dataclass
class GetEnvironmentOutput:
    environment: "Optional[str]" = None


@dataclass
class GetEventInput:
    run_id: "RunId"
    event_id: "EventId"
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class GetEventOutput:
    event: "Event"


@dataclass
class GetHookByTokenInput:
    token: "str"
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class GetHookByTokenOutput:
    hook: "Hook"


@dataclass
class GetHookInput:
    hook_id: "HookId"
    run_id: "Optional[RunId]" = None
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class GetHookOutput:
    hook: "Hook"


@dataclass
class GetRunInput:
    run_id: "RunId"
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class GetRunOutput:
    run: "WorkflowRun"


@dataclass
class GetRuntimeDeadlineInput:
    pass


@dataclass
class GetRuntimeDeadlineOutput:
    deadline: "Optional[datetime]" = None


@dataclass
class GetStepInput:
    run_id: "RunId"
    step_id: "StepId"
    resolve_data: "Optional[ResolveData]" = None


@dataclass
class GetStepOutput:
    step: "Step"


@dataclass
class GetStreamInfoInput:
    run_id: "RunId"
    name: "StreamName"


@dataclass
class GetStreamInfoOutput:
    tail_index: "int"
    """Index of the last known chunk, or -1 when the stream is empty."""
    done: "bool"
    """Whether the stream is closed."""


@dataclass
class GetWorldInfoInput:
    pass


@dataclass
class GetWorldInfoOutput:
    spec_version: "int"
    """Workflow protocol spec version this implementation writes. Runtimes
    require an exact match before creating or replaying runs.
    """
    capabilities: "Optional[WorldCapabilities]" = None
    optional_capabilities: "Optional[CapabilityNameList]" = None
    """Optional capability services that are available."""


@dataclass
class Hook:
    """Materialized view of a hook.

    A hook kept alive by minimum retention stays readable after its run ends
    and continues to reserve its token, but can no longer be resumed.
    """

    run_id: "RunId"
    hook_id: "HookId"
    token: "str"
    owner_id: "str"
    project_id: "str"
    environment: "str"
    created_at: "datetime"
    metadata: "Optional[SerializedData]" = None
    spec_version: "Optional[int]" = None
    is_webhook: "Optional[bool]" = None
    is_system: "Optional[bool]" = None
    token_retention_until: "Optional[datetime]" = None
    """Earliest time the token may be released after the run ends. An active
    run holds the token past this deadline.
    """
    resume_context: "Optional[HookResumeContext]" = None
    resume_capabilities: "Optional[HookResumeCapabilities]" = None


@dataclass
class HookConflictEvent:
    """Records that a `hook_created` lost a token race.

    Implementations write this; callers cannot. Consumers reject the awaited
    hook with a token-conflict error.
    """

    token: "str"
    conflicting_run_id: "Optional[RunId]" = None
    """Run that currently owns the token."""


@dataclass
class HookCreatedEvent:
    """Creates a hook and claims its token."""

    token: "str"
    token_retention_until: "Optional[datetime]" = None
    """Requests minimum token retention past the run's end. Requires the
    `hookRetention` capability.
    """
    metadata: "Optional[SerializedData]" = None
    is_webhook: "Optional[bool]" = None
    is_system: "Optional[bool]" = None


@dataclass
class HookDisposedEvent:
    """Disposes a hook and releases its token immediately."""

    token: "Optional[str]" = None


@dataclass
class HookReceivedEvent:
    """Delivers a payload to an active hook."""

    payload: "SerializedData"
    token: "Optional[str]" = None


@dataclass
class HookResumeCapabilities:
    """Backend-attested resume capabilities, recomputed on every by-token
    lookup.

    Response-only and never persisted, so a rollback or kill switch
    downgrades new resumes immediately by omitting it.
    """

    hook_resume_dedup_version: "int"
    """Present when the live backend enforces the `(runId, resumeId)` dedup
    constraint.
    """


@dataclass
class HookResumeContext:
    """Immutable slice of a hook's owning run, sufficient to resume the hook
    without reading the run entity.

    Deliberately excludes mutable run state, payloads, attributes, and any
    secret.
    """

    deployment_id: "DeploymentId"
    workflow_name: "WorkflowName"
    run_spec_version: "Optional[int]" = None
    """Spec version of the owning run, distinct from the hook's own."""
    workflow_core_version: "Optional[str]" = None
    trace_carrier: "Optional[TraceCarrier]" = None
    """W3C trace context propagated from hook creation."""
    encryption_public_key: "Optional[str]" = None
    """The run's base64 X25519 public key, mirrored from the run entity."""
    hook_resume_input_version: "Optional[int]" = None
    """Version of the lazy-hook-resume consumer protocol supported by the run's
    creating deployment. Absent means the sequential path.
    """


@dataclass
class HookRetentionCapability:
    active: "bool"


@dataclass
class ListEventsByCorrelationIdInput:
    run_id: "RunId"
    correlation_id: "CorrelationId"
    resolve_data: "Optional[ResolveData]" = None
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None
    sort_order: "Optional[SortOrder]" = None


@dataclass
class ListEventsByCorrelationIdOutput:
    events: "EventList"
    has_more: "bool"
    cursor: "Optional[Cursor]" = None


@dataclass
class ListEventsInput:
    run_id: "RunId"
    resolve_data: "Optional[ResolveData]" = None
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None
    sort_order: "Optional[SortOrder]" = None


@dataclass
class ListEventsOutput:
    events: "EventList"
    has_more: "bool"
    cursor: "Optional[Cursor]" = None


@dataclass
class ListHooksInput:
    run_id: "Optional[RunId]" = None
    resolve_data: "Optional[ResolveData]" = None
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None
    sort_order: "Optional[SortOrder]" = None


@dataclass
class ListHooksOutput:
    hooks: "HookList"
    has_more: "bool"
    cursor: "Optional[Cursor]" = None


@dataclass
class ListRunsInput:
    workflow_name: "Optional[WorkflowName]" = None
    status: "Optional[RunStatus]" = None
    resolve_data: "Optional[ResolveData]" = None
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None
    sort_order: "Optional[SortOrder]" = None


@dataclass
class ListRunsOutput:
    runs: "WorkflowRunList"
    has_more: "bool"
    cursor: "Optional[Cursor]" = None
    page_info: "Optional[PageInfo]" = None


@dataclass
class ListStepsInput:
    run_id: "RunId"
    resolve_data: "Optional[ResolveData]" = None
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None
    sort_order: "Optional[SortOrder]" = None


@dataclass
class ListStepsOutput:
    steps: "StepList"
    has_more: "bool"
    cursor: "Optional[Cursor]" = None


@dataclass
class ListStreamChunksInput:
    run_id: "RunId"
    name: "StreamName"
    limit: "Optional[int]" = None
    cursor: "Optional[Cursor]" = None


@dataclass
class ListStreamChunksOutput:
    chunks: "StreamChunkList"
    has_more: "bool"
    """Whether more already-written chunks remain."""
    done: "bool"
    """Whether the stream is closed."""
    cursor: "Optional[Cursor]" = None


@dataclass
class ListStreamsInput:
    run_id: "RunId"


@dataclass
class ListStreamsOutput:
    names: "StreamNameList"


@dataclass
class NotCancellableOutcome:
    status: "RunStatus"
    """Observed run status."""


@dataclass
class PageInfo:
    """Retention window metadata returned by plan-aware list operations."""

    current_lookback_days: "int"
    max_lookback_days: "int"
    current_window_start: "datetime"
    max_window_start: "datetime"
    upgrade_available: "bool"


@dataclass
class Pagination:
    """Cursor pagination request options."""

    limit: "Optional[int]" = None
    """Maximum number of items to return."""
    cursor: "Optional[Cursor]" = None
    """Cursor returned by a previous page."""
    sort_order: "Optional[SortOrder]" = None
    """Sort direction. Callers that depend on ordering should always set it."""


@dataclass
class ReadStreamInput:
    run_id: "RunId"
    name: "StreamName"
    start_index: "Optional[int]" = None


@dataclass
class ReadStreamOutput:
    body: "ByteStream"


@dataclass
class RemoveAttribute:
    """Removal of an attribute key.

    An empty structure rather than `Unit` so the variant can gain members
    later without a breaking change.
    """


@dataclass
class RetryDirective:
    """Instructs the caller to redeliver the message later."""

    timeout_seconds: "int"


@dataclass
class RunCancelledEvent:
    """Transitions a run to `cancelled`."""

    cancel_reason: "Optional[str]" = None


@dataclass
class RunCompletedEvent:
    """Transitions a run to `completed`."""

    output: "Optional[SerializedData]" = None


@dataclass
class RunCreatedEvent:
    """Starts a new run. Materializes the run entity with status `pending`."""

    deployment_id: "DeploymentId"
    workflow_name: "WorkflowName"
    input: "SerializedData"
    execution_context: "Optional[Any]" = None
    attributes: "Optional[AttributeMap]" = None
    allow_reserved_attributes: "Optional[bool]" = None
    encryption_public_key: "Optional[str]" = None
    """Base64 X25519 public key, stamped by SDKs that support sealed envelopes."""


@dataclass
class RunFailedEvent:
    """Transitions a run to `failed`."""

    error: "SerializedData"
    error_code: "Optional[str]" = None
    """Plaintext failure category kept readable without decryption."""


@dataclass
class RunNotFoundOutcome:
    pass


@dataclass
class RunStartedEvent:
    """Transitions a run to `running`.

    The optional creation fields carry the resilient-start path: when the
    `run_created` write did not commit, the implementation creates the run
    from this event instead.
    """

    input: "Optional[SerializedData]" = None
    deployment_id: "Optional[DeploymentId]" = None
    workflow_name: "Optional[WorkflowName]" = None
    execution_context: "Optional[Any]" = None
    attributes: "Optional[AttributeMap]" = None
    allow_reserved_attributes: "Optional[bool]" = None
    encryption_public_key: "Optional[str]" = None


@dataclass
class Step:
    """Materialized view of a step."""

    run_id: "RunId"
    step_id: "StepId"
    step_name: "StepName"
    status: "StepStatus"
    attempt: "int"
    created_at: "datetime"
    updated_at: "datetime"
    input: "Optional[SerializedData]" = None
    output: "Optional[SerializedData]" = None
    error: "Optional[SerializedData]" = None
    """Most recent serialized thrown value, from either a retry or the final
    failure.
    """
    started_at: "Optional[datetime]" = None
    """When the step first began executing. Not updated by retries."""
    completed_at: "Optional[datetime]" = None
    retry_after: "Optional[datetime]" = None
    """Earliest time a retrying step may start again."""
    spec_version: "Optional[int]" = None


@dataclass
class StepAttributeWriter:
    step_id: "StepId"
    attempt: "int"


@dataclass
class StepCompletedEvent:
    """Completes a step successfully."""

    result: "SerializedData"
    step_name: "Optional[StepName]" = None
    workflow_name: "Optional[WorkflowName]" = None
    telemetry: "Optional[StepLatencyTelemetry]" = None


@dataclass
class StepCreatedEvent:
    """Creates a step entity."""

    step_name: "StepName"
    input: "SerializedData"
    workflow_name: "Optional[WorkflowName]" = None
    """Carried so a backend keying payload refs by workflow name avoids a run
    lookup on this hot write.
    """


@dataclass
class StepFailedEvent:
    """Fails a step terminally."""

    error: "SerializedData"
    step_name: "Optional[StepName]" = None
    telemetry: "Optional[StepLatencyTelemetry]" = None


@dataclass
class StepLatencyTelemetry:
    """Client-measured latency telemetry carried on a step's terminal event.

    Populated only on the terminal event of a qualifying first-attempt step
    execution. Implementations may consume these for metrics and are never
    required to persist them.
    """

    ttfs: "Optional[int]" = None
    """Milliseconds from run creation until the run's first step body began."""
    stso: "Optional[int]" = None
    """Milliseconds between the previous step's terminal event and this step's
    body beginning.
    """
    step_count: "Optional[int]" = None
    """Step count when the step-to-step gap began."""
    event_count: "Optional[int]" = None
    """Event count when the step-to-step gap began."""
    rsfs: "Optional[int]" = None
    """Milliseconds from `run_started` landing until this step's start was
    issued. A sub-window of `ttfs`.
    """
    final_scheduling_replay: "Optional[int]" = None
    """Synchronous replay duration of the final scheduling pass within the
    `rsfs` window.
    """
    optimizations: "Optional[StringList]" = None
    """Names of the runtime startup optimizations active for this measurement,
    e.g. `turbo` or `lazyStepStart`.
    """


@dataclass
class StepRetryingEvent:
    """Returns a failed step to `pending` for another attempt."""

    error: "SerializedData"
    step_name: "Optional[StepName]" = None
    retry_after: "Optional[datetime]" = None


@dataclass
class StepStartedEvent:
    """Begins a step attempt, transitioning the step to `running`.

    When `stepName` and `input` are present, this is the lazy-start path:
    the implementation atomically creates the step (writing a synthetic
    `step_created` so replay still observes it) before starting it. Without
    `input`, a prior `step_created` is required.
    """

    step_name: "Optional[StepName]" = None
    attempt: "Optional[int]" = None
    workflow_name: "Optional[WorkflowName]" = None
    input: "Optional[SerializedData]" = None
    owner_message_id: "Optional[str]" = None
    """Queue message ID of the invocation executing this step inline. Doubles
    as the ownership liveness lease, so it requires a queue whose message ID
    is stable across redeliveries.
    """


@dataclass
class StreamChunk:
    """One chunk of a stream, with its 0-based position."""

    index: "int"
    data: "bytes"


@dataclass
class StructuredError:
    """Structured error metadata carried by run and step failures."""

    message: "str"
    stack: "Optional[str]" = None
    code: "Optional[str]" = None
    """Machine-readable error code, e.g. `USER_ERROR` or `RUNTIME_ERROR`."""


@dataclass
class Wait:
    """Materialized view of a wait."""

    run_id: "RunId"
    wait_id: "WaitId"
    resume_at: "datetime"
    created_at: "datetime"
    completed_at: "Optional[datetime]" = None


@dataclass
class WaitCompletedEvent:
    """Completes a wait. Intended to be atomic and exactly once."""

    resume_at: "Optional[datetime]" = None


@dataclass
class WaitCreatedEvent:
    """Creates a wait that resumes at a wall-clock time."""

    resume_at: "datetime"


@dataclass
class WorkflowAttributeWriter:
    """The workflow function itself wrote the attributes."""


@dataclass
class WorkflowRun:
    """Materialized view of a run.

    `input`, `output`, and `error` are absent when the caller asked for
    `ResolveData$NONE`, and `output`/`error`/`completedAt` are only
    populated once the run reaches the matching terminal status.
    """

    run_id: "RunId"
    status: "RunStatus"
    deployment_id: "DeploymentId"
    workflow_name: "WorkflowName"
    attributes: "AttributeMap"
    created_at: "datetime"
    updated_at: "datetime"
    spec_version: "Optional[int]" = None
    """Workflow protocol spec version the run was created under."""
    execution_context: "Optional[Any]" = None
    """Opaque, world-specific execution context recorded at creation."""
    input: "Optional[SerializedData]" = None
    output: "Optional[SerializedData]" = None
    error: "Optional[SerializedData]" = None
    """Serialized thrown value from `run_failed`."""
    error_code: "Optional[str]" = None
    """Plaintext failure category, readable without decryption."""
    encryption_public_key: "Optional[str]" = None
    """Base64 X25519 public key that lets other parties seal payloads to this
    run. Present only for runs created by SDKs that support sealed envelopes
    on encryption-capable implementations.
    """
    expired_at: "Optional[datetime]" = None
    started_at: "Optional[datetime]" = None
    completed_at: "Optional[datetime]" = None


@dataclass
class WorldCapabilities:
    """Feature capabilities an implementation declares.

    Every member defaults to unsupported when absent: a runtime fast path
    gated on a capability must keep its conservative behavior unless the
    capability is explicitly declared.
    """

    hook_retention: "Optional[HookRetentionCapability]" = None
    """Supports minimum token retention for hooks."""
    precondition_guard: "Optional[bool]" = None
    """Fences a stale replay-context write with `PreconditionFailedError`
    rather than committing it. Accepting a snapshot and ignoring it is not
    the same thing, and must leave this unset.
    """
    max_concurrency: "Optional[bool]" = None
    """The queue supports concurrency-limited consumption, including the
    per-run topics consumed with a limit of one.
    """
    hook_resume_dedup: "Optional[bool]" = None
    """`CreateEvent` deduplicates concurrent `hookReceived` writes carrying the
    same `(runId, resumeId)`, collapsing them onto one committed event.
    """
    deployment_affinity: "Optional[bool]" = None
    """Deployment IDs are atomic and immutable, so a run pinned to one may only
    execute there. Implementations whose deployment ID is synthetic or
    version-tagged must leave this unset.
    """
    slot_event_ids: "Optional[bool]" = None
    """Event IDs encode the event's dense, 1-based slot in its run's log.
    Implies both density and bump-and-report on contention.
    """


@dataclass
class WriteStreamChunkInput:
    run_id: "RunId"
    name: "StreamName"
    chunk: "bytes"


@dataclass
class WriteStreamChunkOutput:
    pass


@dataclass
class WriteStreamChunksInput:
    run_id: "RunId"
    name: "StreamName"
    chunks: "ChunkDataList"
    """Chunks to append, in order."""


@dataclass
class WriteStreamChunksOutput:
    pass


@dataclass
class callback:
    """Marks an operation that is invoked in the reverse direction: the World
    (or its queue adapter) calls the workflow runtime rather than the other
    way around.
    """


@dataclass
class localOnly:
    """Marks an operation that must never be exposed over a network transport.

    Operations carrying this trait exist so that in-process implementations
    share one cross-language contract (TypeScript, Python) for behavior that
    is resolved locally: ID minting, environment attribution, deadlines,
    display enrichment, and encryption-key resolution. Any future transport
    projection is expected to remove these operations from its closure and
    to fail the build if one survives.
    """


@dataclass
class optionalCapability:
    """Marks an operation as part of an optional World capability.

    Smithy services have no notion of an optional operation, so optional
    behavior lives in its own service closure. This trait records which
    capability an operation belongs to so wrappers and conformance tooling
    can tie a generated service to the capability an implementation
    advertises in `WorldInfo`.
    """

    name: "str"
    """Capability name as advertised by `WorldInfo$capabilities`."""


@dataclass
class AttributeChangeValueSet:
    """Upsert the key with this value."""

    value: "str"


@dataclass
class AttributeChangeValueRemove:
    """Remove the key."""

    value: "RemoveAttribute"

"""Upsert or removal of one attribute key."""
AttributeChangeValue = Union["AttributeChangeValueSet", "AttributeChangeValueRemove"]


@dataclass
class AttributeWriterWorkflow:
    value: "WorkflowAttributeWriter"


@dataclass
class AttributeWriterStep:
    value: "StepAttributeWriter"

"""Identifies which writer produced an attribute change."""
AttributeWriter = Union["AttributeWriterWorkflow", "AttributeWriterStep"]


@dataclass
class BulkCancelOutcomeCancelled:
    """This request transitioned the run to cancelled."""

    value: "CancelledOutcome"


@dataclass
class BulkCancelOutcomeAlreadyCancelled:
    """The run was already cancelled. Idempotent success."""

    value: "AlreadyCancelledOutcome"


@dataclass
class BulkCancelOutcomeNotCancellable:
    """The run is in a terminal, non-cancellable state."""

    value: "NotCancellableOutcome"


@dataclass
class BulkCancelOutcomeNotFound:
    """No run exists for this ID."""

    value: "RunNotFoundOutcome"


@dataclass
class BulkCancelOutcomeFailed:
    """Cancellation failed for this run."""

    value: "BulkCancelFailure"

"""Per-run outcome of a bulk cancellation."""
BulkCancelOutcome = Union["BulkCancelOutcomeCancelled", "BulkCancelOutcomeAlreadyCancelled", "BulkCancelOutcomeNotCancellable", "BulkCancelOutcomeNotFound", "BulkCancelOutcomeFailed"]


@dataclass
class CreatableEventRunStarted:
    value: "RunStartedEvent"


@dataclass
class CreatableEventRunCompleted:
    value: "RunCompletedEvent"


@dataclass
class CreatableEventRunFailed:
    value: "RunFailedEvent"


@dataclass
class CreatableEventRunCancelled:
    value: "RunCancelledEvent"


@dataclass
class CreatableEventAttributesSet:
    value: "AttributesSetEvent"


@dataclass
class CreatableEventStepCreated:
    value: "StepCreatedEvent"


@dataclass
class CreatableEventStepStarted:
    value: "StepStartedEvent"


@dataclass
class CreatableEventStepCompleted:
    value: "StepCompletedEvent"


@dataclass
class CreatableEventStepFailed:
    value: "StepFailedEvent"


@dataclass
class CreatableEventStepRetrying:
    value: "StepRetryingEvent"


@dataclass
class CreatableEventHookCreated:
    value: "HookCreatedEvent"


@dataclass
class CreatableEventHookReceived:
    value: "HookReceivedEvent"


@dataclass
class CreatableEventHookDisposed:
    value: "HookDisposedEvent"


@dataclass
class CreatableEventWaitCreated:
    value: "WaitCreatedEvent"


@dataclass
class CreatableEventWaitCompleted:
    value: "WaitCompletedEvent"

"""Every event a caller may write to an existing run.

`run_created` is absent because it creates the run and is modeled as
`CreateRun`. `hook_conflict` is absent because only implementations
produce it.
"""
CreatableEvent = Union["CreatableEventRunStarted", "CreatableEventRunCompleted", "CreatableEventRunFailed", "CreatableEventRunCancelled", "CreatableEventAttributesSet", "CreatableEventStepCreated", "CreatableEventStepStarted", "CreatableEventStepCompleted", "CreatableEventStepFailed", "CreatableEventStepRetrying", "CreatableEventHookCreated", "CreatableEventHookReceived", "CreatableEventHookDisposed", "CreatableEventWaitCreated", "CreatableEventWaitCompleted"]


@dataclass
class EventPayloadRunCreated:
    value: "RunCreatedEvent"


@dataclass
class EventPayloadRunStarted:
    value: "RunStartedEvent"


@dataclass
class EventPayloadRunCompleted:
    value: "RunCompletedEvent"


@dataclass
class EventPayloadRunFailed:
    value: "RunFailedEvent"


@dataclass
class EventPayloadRunCancelled:
    value: "RunCancelledEvent"


@dataclass
class EventPayloadAttributesSet:
    value: "AttributesSetEvent"


@dataclass
class EventPayloadStepCreated:
    value: "StepCreatedEvent"


@dataclass
class EventPayloadStepStarted:
    value: "StepStartedEvent"


@dataclass
class EventPayloadStepCompleted:
    value: "StepCompletedEvent"


@dataclass
class EventPayloadStepFailed:
    value: "StepFailedEvent"


@dataclass
class EventPayloadStepRetrying:
    value: "StepRetryingEvent"


@dataclass
class EventPayloadHookCreated:
    value: "HookCreatedEvent"


@dataclass
class EventPayloadHookReceived:
    value: "HookReceivedEvent"


@dataclass
class EventPayloadHookDisposed:
    value: "HookDisposedEvent"


@dataclass
class EventPayloadHookConflict:
    value: "HookConflictEvent"


@dataclass
class EventPayloadWaitCreated:
    value: "WaitCreatedEvent"


@dataclass
class EventPayloadWaitCompleted:
    value: "WaitCompletedEvent"

"""Every event readable from a run's log."""
EventPayload = Union["EventPayloadRunCreated", "EventPayloadRunStarted", "EventPayloadRunCompleted", "EventPayloadRunFailed", "EventPayloadRunCancelled", "EventPayloadAttributesSet", "EventPayloadStepCreated", "EventPayloadStepStarted", "EventPayloadStepCompleted", "EventPayloadStepFailed", "EventPayloadStepRetrying", "EventPayloadHookCreated", "EventPayloadHookReceived", "EventPayloadHookDisposed", "EventPayloadHookConflict", "EventPayloadWaitCreated", "EventPayloadWaitCompleted"]


@dataclass
class BadRequestError(WorldError):
    """The request was malformed or violated a validation rule."""

    message: "str"
    code: "Optional[str]" = None


@dataclass
class ConflictError(WorldError):
    """The entity already exists, or its current state forbids this write.

    The runtime commonly reads this as "another writer won the race" rather
    than as a hard failure.
    """

    message: "str"
    status: "Optional[str]" = None
    """Observed status of the entity, when the implementation reports one."""


@dataclass
class EventNotFoundError(WorldError):
    """No event exists for the requested ID."""

    message: "str"
    run_id: "Optional[RunId]" = None
    event_id: "Optional[EventId]" = None


@dataclass
class ExpiredError(WorldError):
    """The run is gone: it passed its retention window or was otherwise
    expired.
    """

    message: "str"
    run_id: "Optional[RunId]" = None


@dataclass
class HookNotFoundError(WorldError):
    """No hook exists for the requested ID or token."""

    message: "str"
    hook_id: "Optional[HookId]" = None


@dataclass
class InternalError(WorldError):
    """The implementation failed for a reason the caller cannot correct."""

    message: "str"
    code: "Optional[str]" = None


@dataclass
class PreconditionFailedError(WorldError):
    """A replay-context write was fenced because its snapshot is behind the
    run's recorded log.

    Only implementations that advertise the `preconditionGuard` capability
    raise this. It is unrelated to slot allocation: a slot-numbering World
    bumps to the next free slot and reports the events it skipped instead of
    rejecting the write.
    """

    message: "str"
    event_count: "Optional[int]" = None
    """Number of events the World held when it rejected the write."""


@dataclass
class RunNotFoundError(WorldError):
    """No run exists for the requested ID."""

    message: "str"
    run_id: "Optional[RunId]" = None


@dataclass
class StepNotFoundError(WorldError):
    """No step exists for the requested ID."""

    message: "str"
    run_id: "Optional[RunId]" = None
    step_id: "Optional[StepId]" = None


@dataclass
class StreamExpiredError(WorldError):
    """The stream is gone: it passed its retention window."""

    message: "str"
    run_id: "Optional[RunId]" = None
    stream_name: "Optional[StreamName]" = None


@dataclass
class StreamNotFoundError(WorldError):
    """No stream exists for the requested run and name."""

    message: "str"
    run_id: "Optional[RunId]" = None
    stream_name: "Optional[StreamName]" = None


@dataclass
class ThrottledError(WorldError):
    """The caller is being throttled, or lost a contention retry budget."""

    message: "str"
    retry_after: "Optional[datetime]" = None


@dataclass
class TooEarlyError(WorldError):
    """The operation was attempted before its earliest valid time."""

    message: "str"
    retry_after: "Optional[datetime]" = None
    """Earliest time at which the operation may be retried."""
