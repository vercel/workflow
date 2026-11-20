$version: "2"

namespace vercel.workflow.world

/// The request was malformed or violated a validation rule.
@error("client")
structure BadRequestError {
    @required
    message: String

    code: String
}

/// No run exists for the requested ID.
@error("client")
structure RunNotFoundError {
    @required
    message: String

    runId: RunId
}

/// No step exists for the requested ID.
@error("client")
structure StepNotFoundError {
    @required
    message: String

    runId: RunId

    stepId: StepId
}

/// No event exists for the requested ID.
@error("client")
structure EventNotFoundError {
    @required
    message: String

    runId: RunId

    eventId: EventId
}

/// No hook exists for the requested ID or token.
@error("client")
structure HookNotFoundError {
    @required
    message: String

    hookId: HookId
}

/// No stream exists for the requested run and name.
@error("client")
structure StreamNotFoundError {
    @required
    message: String

    runId: RunId

    streamName: StreamName
}

/// The entity already exists, or its current state forbids this write.
///
/// The runtime commonly reads this as "another writer won the race" rather
/// than as a hard failure.
@error("client")
structure ConflictError {
    @required
    message: String

    /// Observed status of the entity, when the implementation reports one.
    status: String
}

/// The run is gone: it passed its retention window or was otherwise expired.
@error("client")
structure ExpiredError {
    @required
    message: String

    runId: RunId
}

/// The stream is gone: it passed its retention window.
@error("client")
structure StreamExpiredError {
    @required
    message: String

    runId: RunId

    streamName: StreamName
}

/// A replay-context write was fenced because its snapshot is behind the run's
/// recorded log.
///
/// Only implementations that advertise the `preconditionGuard` capability
/// raise this. It is unrelated to slot allocation: a slot-numbering World
/// bumps to the next free slot and reports the events it skipped instead of
/// rejecting the write.
@error("client")
structure PreconditionFailedError {
    @required
    message: String

    /// Number of events the World held when it rejected the write.
    eventCount: Integer
}

/// The operation was attempted before its earliest valid time.
@error("client")
structure TooEarlyError {
    @required
    message: String

    /// Earliest time at which the operation may be retried.
    retryAfter: Timestamp
}

/// The caller is being throttled, or lost a contention retry budget.
@error("client")
@retryable(throttling: true)
structure ThrottledError {
    @required
    message: String

    retryAfter: Timestamp
}

/// The implementation failed for a reason the caller cannot correct.
@error("server")
@retryable
structure InternalError {
    @required
    message: String

    code: String
}
