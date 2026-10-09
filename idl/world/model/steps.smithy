$version: "2"

namespace vercel.workflow.world

/// Lifecycle status of a step.
enum StepStatus {
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
}

/// Materialized view of a step.
structure Step {
    @required
    runId: RunId

    @required
    stepId: StepId

    @required
    stepName: StepName

    @required
    status: StepStatus

    input: SerializedData

    output: SerializedData

    /// Most recent serialized thrown value, from either a retry or the final
    /// failure.
    error: SerializedData

    @required
    attempt: Integer

    /// When the step first began executing. Not updated by retries.
    startedAt: Timestamp

    completedAt: Timestamp

    /// Earliest time a retrying step may start again.
    retryAfter: Timestamp

    specVersion: Integer

    @required
    createdAt: Timestamp

    @required
    updatedAt: Timestamp
}

list StepList {
    member: Step
}

/// Reads one step.
@readonly
operation GetStep {
    input := {
        @required
        runId: RunId

        @required
        stepId: StepId

        resolveData: ResolveData
    }

    output := {
        @required
        step: Step
    }

    errors: [
        RunNotFoundError
        StepNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Lists the steps of one run.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "steps")
operation ListSteps {
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
        steps: StepList

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
