"""Generated from the Smithy model. Do not edit by hand.

Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .models import (
    BatchGetRunsInput,
    BatchGetRunsOutput,
    BulkCancelRunsInput,
    BulkCancelRunsOutput,
    CloseStreamInput,
    CloseStreamOutput,
    CreateEventInput,
    CreateRunIdInput,
    CreateRunIdOutput,
    CreateRunInput,
    DeliverQueueMessageInput,
    DeliverQueueMessageOutput,
    DescribeRunInput,
    DescribeRunOutput,
    EnqueueInput,
    EnqueueOutput,
    EventMutationResult,
    GetDeploymentIdInput,
    GetDeploymentIdOutput,
    GetEncryptionKeyForRunInput,
    GetEncryptionKeyForRunOutput,
    GetEnvironmentInput,
    GetEnvironmentOutput,
    GetEventInput,
    GetEventOutput,
    GetHookByTokenInput,
    GetHookByTokenOutput,
    GetHookInput,
    GetHookOutput,
    GetRunInput,
    GetRunOutput,
    GetRuntimeDeadlineInput,
    GetRuntimeDeadlineOutput,
    GetStepInput,
    GetStepOutput,
    GetStreamInfoInput,
    GetStreamInfoOutput,
    GetWorldInfoInput,
    GetWorldInfoOutput,
    ListEventsByCorrelationIdInput,
    ListEventsByCorrelationIdOutput,
    ListEventsInput,
    ListEventsOutput,
    ListHooksInput,
    ListHooksOutput,
    ListRunsInput,
    ListRunsOutput,
    ListStepsInput,
    ListStepsOutput,
    ListStreamChunksInput,
    ListStreamChunksOutput,
    ListStreamsInput,
    ListStreamsOutput,
    ReadStreamInput,
    ReadStreamOutput,
    WriteStreamChunkInput,
    WriteStreamChunkOutput,
    WriteStreamChunksInput,
    WriteStreamChunksOutput,
)


class RuntimeQueueConsumerPort(Protocol):
    """The runtime's own queue-consumer interface.

    Deliberately not part of `World`, and not a second World interface: the
    implementor is the workflow runtime, and the caller is a World's queue
    adapter. Today this is the callback handed to `createQueueHandler`.
    Folding it into `World` would say that a World implements it, which is
    backwards.
    """

    async def deliver_queue_message(self, input: "DeliverQueueMessageInput") -> "DeliverQueueMessageOutput":
        """Delivers one queued message to the workflow runtime.

        This is the reverse direction: a queue adapter calls the runtime.
        Today's `createQueueHandler` becomes a thin per-language adapter that
        exposes this operation over whatever the platform hands it, rather than
        an operation in its own right.

        Callback: implemented by the runtime, called by the World. Throws:
        BadRequestError, InternalError.
        """
        ...


class WorldPort(Protocol):
    """The World interface.

    One interface, implemented by every World: local, Postgres, Vercel, and
    the simulator. This is the whole point of the model, so the surface is
    not split by concern, by optionality, or by whether an operation can
    cross a network.

    Two of those distinctions still exist, and both are traits on operations
    rather than separate interfaces:

    - `optionalCapability` marks an operation an implementation may omit. It
    is the modeled form of today's optional `World` methods (`getMany?`,
    `cancelMany?`, `writeMulti?`), and callers feature-detect it exactly as
    they do now. `GetWorldInfo` reports which ones are present. -
    `localOnly` marks an operation that is resolved in-process and must
    never be exposed over a transport. It stays on this interface because a
    World implements it; a future transport projection is what drops it.

    No protocol trait is applied anywhere in this model. The operations are
    transport-independent by construction: an in-process implementation
    satisfies the generated interface directly, and any wire format is a
    separate projection that layers protocol and binding traits on top.
    """

    async def close_stream(self, input: "CloseStreamInput") -> "CloseStreamOutput":
        """Closes a stream. No further chunks may be appended.

        Throws: InternalError, RunNotFoundError, StreamExpiredError,
        StreamNotFoundError, ThrottledError.
        """
        ...

    async def create_event(self, input: "CreateEventInput") -> "EventMutationResult":
        """Appends an event to a run's log and materializes its effect atomically.

        This is the only way to change run, step, hook, or wait state.

        Throws: BadRequestError, ConflictError, ExpiredError, InternalError,
        PreconditionFailedError, RunNotFoundError, ThrottledError,
        TooEarlyError.
        """
        ...

    async def create_run(self, input: "CreateRunInput") -> "EventMutationResult":
        """Creates a run.

        The caller may mint the run ID or leave it absent for the implementation
        to generate one.

        Throws: BadRequestError, ConflictError, InternalError, ThrottledError.
        """
        ...

    async def create_run_id(self, input: "CreateRunIdInput") -> "CreateRunIdOutput":
        """Mints a new run ID.

        Returns the bare ULID; the core attaches the `wrun_` prefix.
        Implementations may embed world-specific metadata such as a region as
        long as the result stays a valid ULID.

        Local only: never exposed over a transport.
        """
        ...

    async def describe_run(self, input: "DescribeRunInput") -> "DescribeRunOutput":
        """Returns extra display fields for a run.

        Called once per displayed run by tooling, so it must be cheap, pure, and
        non-throwing.

        Local only: never exposed over a transport.
        """
        ...

    async def enqueue(self, input: "EnqueueInput") -> "EnqueueOutput":
        """Enqueues one message. Delivery is at-least-once.

        Throws: BadRequestError, InternalError, ThrottledError.
        """
        ...

    async def get_deployment_id(self, input: "GetDeploymentIdInput") -> "GetDeploymentIdOutput":
        """Returns the deployment this World writes as.

        Throws: InternalError, ThrottledError.
        """
        ...

    async def get_encryption_key_for_run(self, input: "GetEncryptionKeyForRunInput") -> "GetEncryptionKeyForRunOutput":
        """Resolves the AES-256 key for a run.

        Local only, permanently: key material must never cross a transport
        boundary. It is modeled here so in-process implementations share one
        contract across languages, and every transport projection is expected to
        drop it. Absent support means encryption is disabled.

        Local only: never exposed over a transport.
        """
        ...

    async def get_environment(self, input: "GetEnvironmentInput") -> "GetEnvironmentOutput":
        """Returns the environment this World's writes are attributed to.

        Must match the attribution the backend will actually apply. Callers use
        it to detect cross-environment mismatches, so a plausible-looking wrong
        value is worse than none.

        Local only: never exposed over a transport.
        """
        ...

    async def get_event(self, input: "GetEventInput") -> "GetEventOutput":
        """Reads one event.

        Throws: EventNotFoundError, ExpiredError, InternalError,
        RunNotFoundError, ThrottledError.
        """
        ...

    async def get_hook(self, input: "GetHookInput") -> "GetHookOutput":
        """Reads one hook by ID.

        Throws: ExpiredError, HookNotFoundError, InternalError, ThrottledError.
        """
        ...

    async def get_hook_by_token(self, input: "GetHookByTokenInput") -> "GetHookByTokenOutput":
        """Reads the hook that currently owns a token, including a retained hook
        whose run has ended.

        Throws: ExpiredError, HookNotFoundError, InternalError, ThrottledError.
        """
        ...

    async def get_run(self, input: "GetRunInput") -> "GetRunOutput":
        """Reads one run.

        Throws: ExpiredError, InternalError, RunNotFoundError, ThrottledError.
        """
        ...

    async def get_runtime_deadline(self, input: "GetRuntimeDeadlineInput") -> "GetRuntimeDeadlineOutput":
        """Returns the wall-clock time at which the current invocation will be
        terminated by the hosting platform, when that is known.

        Local only: never exposed over a transport.
        """
        ...

    async def get_step(self, input: "GetStepInput") -> "GetStepOutput":
        """Reads one step.

        Throws: ExpiredError, InternalError, RunNotFoundError,
        StepNotFoundError, ThrottledError.
        """
        ...

    async def get_stream_info(self, input: "GetStreamInfoInput") -> "GetStreamInfoOutput":
        """Reads lightweight stream metadata.

        Useful for resolving a negative `startIndex` into an absolute position
        before opening a live read.

        Throws: InternalError, RunNotFoundError, StreamExpiredError,
        StreamNotFoundError, ThrottledError.
        """
        ...

    async def get_world_info(self, input: "GetWorldInfoInput") -> "GetWorldInfoOutput":
        """Reports the implementation's protocol version and capabilities.

        This replaces inferring support from method presence, which stops
        working as soon as calls cross a transport where every method always
        exists.

        Throws: InternalError, ThrottledError.
        """
        ...

    async def list_events(self, input: "ListEventsInput") -> "ListEventsOutput":
        """Lists a run's event log.

        Omitting `limit` requests every remaining event.

        Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
        ThrottledError.
        """
        ...

    async def list_events_by_correlation_id(self, input: "ListEventsByCorrelationIdInput") -> "ListEventsByCorrelationIdOutput":
        """Lists the events of one run that share a correlation ID.

        Correlation IDs are unique within a run, not globally, so the run is
        part of the query.

        Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
        ThrottledError.
        """
        ...

    async def list_hooks(self, input: "ListHooksInput") -> "ListHooksOutput":
        """Lists hooks, including retained hooks whose runs have ended.

        Throws: BadRequestError, InternalError, ThrottledError.
        """
        ...

    async def list_runs(self, input: "ListRunsInput") -> "ListRunsOutput":
        """Lists canonical run records.

        This is the operational, payload-bearing listing. Observability surfaces
        should prefer the analytics read path once it is modeled.

        Throws: BadRequestError, InternalError, ThrottledError.
        """
        ...

    async def list_steps(self, input: "ListStepsInput") -> "ListStepsOutput":
        """Lists the steps of one run.

        Throws: BadRequestError, ExpiredError, InternalError, RunNotFoundError,
        ThrottledError.
        """
        ...

    async def list_stream_chunks(self, input: "ListStreamChunksInput") -> "ListStreamChunksOutput":
        """Reads a point-in-time page of already-written chunks.

        Unlike `ReadStream`, this never waits. `done` reports whether the stream
        is closed: `done: false` with `hasMore: false` means nothing is
        available right now, but more chunks may still arrive.

        Throws: BadRequestError, InternalError, RunNotFoundError,
        StreamExpiredError, StreamNotFoundError, ThrottledError.
        """
        ...

    async def list_streams(self, input: "ListStreamsInput") -> "ListStreamsOutput":
        """Lists the stream names belonging to a run.

        Throws: ExpiredError, InternalError, RunNotFoundError, ThrottledError.
        """
        ...

    async def read_stream(self, input: "ReadStreamInput") -> "ReadStreamOutput":
        """Reads a stream live, waiting for chunks until the stream closes.

        A positive `startIndex` skips that many chunks from the start. A
        negative one starts that many chunks before the current end, clamped to
        zero.

        Throws: InternalError, RunNotFoundError, StreamExpiredError,
        StreamNotFoundError, ThrottledError.
        """
        ...

    async def write_stream_chunk(self, input: "WriteStreamChunkInput") -> "WriteStreamChunkOutput":
        """Appends one chunk to a stream.

        Throws: ConflictError, InternalError, RunNotFoundError,
        StreamExpiredError, ThrottledError.
        """
        ...


@runtime_checkable
class SupportsBatchGetRuns(Protocol):
    """Implementations that provide the optional `batchGetRuns` capability."""

    async def batch_get_runs(self, input: "BatchGetRunsInput") -> "BatchGetRunsOutput":
        """Reads several runs as one snapshot.

        `runs` preserves the request order, including duplicate IDs, and carries
        a null entry for every ID that does not exist.

        Optional capability: `batchGetRuns`. Throws: BadRequestError,
        InternalError, ThrottledError.
        """
        ...


@runtime_checkable
class SupportsBulkCancelRuns(Protocol):
    """Implementations that provide the optional `bulkCancelRuns` capability."""

    async def bulk_cancel_runs(self, input: "BulkCancelRunsInput") -> "BulkCancelRunsOutput":
        """Cancels many runs in one request.

        Missing, already-cancelled, and non-cancellable runs are reported as
        per-run outcomes rather than as operation errors, so one bad ID never
        fails the batch.

        Optional capability: `bulkCancelRuns`. Throws: BadRequestError,
        InternalError, ThrottledError.
        """
        ...


@runtime_checkable
class SupportsWriteStreamChunks(Protocol):
    """Implementations that provide the optional `writeStreamChunks`
    capability.
    """

    async def write_stream_chunks(self, input: "WriteStreamChunksInput") -> "WriteStreamChunksOutput":
        """Appends several chunks in order, in one request.

        An optional optimization. Callers fall back to repeated
        `WriteStreamChunk` calls when an implementation does not provide it.

        Optional capability: `writeStreamChunks`. Throws: ConflictError,
        InternalError, RunNotFoundError, StreamExpiredError, ThrottledError.
        """
        ...
