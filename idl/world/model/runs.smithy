$version: "2"

namespace vercel.workflow.world

/// Lifecycle status of a run.
enum RunStatus {
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
}

/// Materialized view of a run.
///
/// `input`, `output`, and `error` are absent when the caller asked for
/// `ResolveData$NONE`, and `output`/`error`/`completedAt` are only populated
/// once the run reaches the matching terminal status.
structure WorkflowRun {
    @required
    runId: RunId

    @required
    status: RunStatus

    @required
    deploymentId: DeploymentId

    @required
    workflowName: WorkflowName

    /// Workflow protocol spec version the run was created under.
    specVersion: Integer

    /// Opaque, world-specific execution context recorded at creation.
    executionContext: Document

    input: SerializedData

    output: SerializedData

    /// Serialized thrown value from `run_failed`.
    error: SerializedData

    /// Plaintext failure category, readable without decryption.
    errorCode: String

    @required
    attributes: AttributeMap

    /// Base64 X25519 public key that lets other parties seal payloads to this
    /// run. Present only for runs created by SDKs that support sealed
    /// envelopes on encryption-capable implementations.
    encryptionPublicKey: String

    expiredAt: Timestamp

    startedAt: Timestamp

    completedAt: Timestamp

    @required
    createdAt: Timestamp

    @required
    updatedAt: Timestamp
}

list WorkflowRunList {
    member: WorkflowRun
}

@sparse
list SparseWorkflowRunList {
    member: WorkflowRun
}

list RunIdList {
    member: RunId
}

/// Reads one run.
@readonly
operation GetRun {
    input := {
        @required
        runId: RunId

        resolveData: ResolveData
    }

    output := {
        @required
        run: WorkflowRun
    }

    errors: [
        RunNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Reads several runs as one snapshot.
///
/// `runs` preserves the request order, including duplicate IDs, and carries a
/// null entry for every ID that does not exist.
@readonly
@optionalCapability(name: "batchGetRuns")
operation BatchGetRuns {
    input := {
        @required
        runIds: RunIdList

        resolveData: ResolveData
    }

    output := {
        @required
        runs: SparseWorkflowRunList
    }

    errors: [
        BadRequestError
        ThrottledError
        InternalError
    ]
}

/// Lists canonical run records.
///
/// This is the operational, payload-bearing listing. Observability surfaces
/// should prefer the analytics read path once it is modeled.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "runs")
operation ListRuns {
    input := {
        workflowName: WorkflowName

        status: RunStatus

        resolveData: ResolveData

        @range(min: 1, max: 1000)
        limit: Integer

        cursor: Cursor

        sortOrder: SortOrder
    }

    output := {
        @required
        runs: WorkflowRunList

        cursor: Cursor

        @required
        hasMore: Boolean

        pageInfo: PageInfo
    }

    errors: [
        BadRequestError
        ThrottledError
        InternalError
    ]
}

/// Per-run outcome of a bulk cancellation.
union BulkCancelOutcome {
    /// This request transitioned the run to cancelled.
    cancelled: CancelledOutcome

    /// The run was already cancelled. Idempotent success.
    alreadyCancelled: AlreadyCancelledOutcome

    /// The run is in a terminal, non-cancellable state.
    notCancellable: NotCancellableOutcome

    /// No run exists for this ID.
    notFound: RunNotFoundOutcome

    /// Cancellation failed for this run.
    failed: BulkCancelFailure
}

structure CancelledOutcome {}

structure AlreadyCancelledOutcome {}

structure RunNotFoundOutcome {}

structure NotCancellableOutcome {
    /// Observed run status.
    @required
    status: RunStatus
}

structure BulkCancelFailure {
    @required
    code: String

    @required
    retryable: Boolean
}

structure BulkCancelResult {
    @required
    runId: RunId

    @required
    outcome: BulkCancelOutcome
}

list BulkCancelResultList {
    member: BulkCancelResult
}

structure BulkCancelSummary {
    @required
    requested: Integer

    @required
    cancelled: Integer

    @required
    alreadyCancelled: Integer

    @required
    notCancellable: Integer

    @required
    notFound: Integer

    @required
    failed: Integer
}

/// Cancels many runs in one request.
///
/// Missing, already-cancelled, and non-cancellable runs are reported as
/// per-run outcomes rather than as operation errors, so one bad ID never
/// fails the batch.
@idempotent
@optionalCapability(name: "bulkCancelRuns")
operation BulkCancelRuns {
    input := {
        /// 1-500 unique run IDs.
        @required
        @length(min: 1, max: 500)
        runIds: RunIdList

        @length(max: 512)
        cancelReason: String
    }

    output := {
        @required
        summary: BulkCancelSummary

        /// One entry per requested ID, in request order.
        @required
        results: BulkCancelResultList
    }

    errors: [
        BadRequestError
        ThrottledError
        InternalError
    ]
}
