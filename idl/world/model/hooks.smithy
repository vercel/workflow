$version: "2"

namespace vercel.workflow.world

/// Immutable slice of a hook's owning run, sufficient to resume the hook
/// without reading the run entity.
///
/// Deliberately excludes mutable run state, payloads, attributes, and any
/// secret.
structure HookResumeContext {
    @required
    deploymentId: DeploymentId

    @required
    workflowName: WorkflowName

    /// Spec version of the owning run, distinct from the hook's own.
    runSpecVersion: Integer

    workflowCoreVersion: String

    /// W3C trace context propagated from hook creation.
    traceCarrier: TraceCarrier

    /// The run's base64 X25519 public key, mirrored from the run entity.
    encryptionPublicKey: String

    /// Version of the lazy-hook-resume consumer protocol supported by the
    /// run's creating deployment. Absent means the sequential path.
    hookResumeInputVersion: Integer
}

/// Backend-attested resume capabilities, recomputed on every by-token lookup.
///
/// Response-only and never persisted, so a rollback or kill switch downgrades
/// new resumes immediately by omitting it.
structure HookResumeCapabilities {
    /// Present when the live backend enforces the `(runId, resumeId)` dedup
    /// constraint.
    @required
    hookResumeDedupVersion: Integer
}

/// Materialized view of a hook.
///
/// A hook kept alive by minimum retention stays readable after its run ends
/// and continues to reserve its token, but can no longer be resumed.
structure Hook {
    @required
    runId: RunId

    @required
    hookId: HookId

    @required
    token: String

    @required
    ownerId: String

    @required
    projectId: String

    @required
    environment: String

    metadata: SerializedData

    specVersion: Integer

    isWebhook: Boolean

    isSystem: Boolean

    /// Earliest time the token may be released after the run ends. An active
    /// run holds the token past this deadline.
    tokenRetentionUntil: Timestamp

    resumeContext: HookResumeContext

    resumeCapabilities: HookResumeCapabilities

    @required
    createdAt: Timestamp
}

list HookList {
    member: Hook
}

/// Reads one hook by ID.
@readonly
operation GetHook {
    input := {
        @required
        hookId: HookId

        runId: RunId

        resolveData: ResolveData
    }

    output := {
        @required
        hook: Hook
    }

    errors: [
        HookNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Reads the hook that currently owns a token, including a retained hook
/// whose run has ended.
@readonly
operation GetHookByToken {
    input := {
        @required
        token: String

        resolveData: ResolveData
    }

    output := {
        @required
        hook: Hook
    }

    errors: [
        HookNotFoundError
        ExpiredError
        ThrottledError
        InternalError
    ]
}

/// Lists hooks, including retained hooks whose runs have ended.
@readonly
@paginated(inputToken: "cursor", outputToken: "cursor", pageSize: "limit", items: "hooks")
operation ListHooks {
    input := {
        runId: RunId

        resolveData: ResolveData

        @range(min: 1, max: 1000)
        limit: Integer

        cursor: Cursor

        sortOrder: SortOrder
    }

    output := {
        @required
        hooks: HookList

        cursor: Cursor

        @required
        hasMore: Boolean
    }

    errors: [
        BadRequestError
        ThrottledError
        InternalError
    ]
}

/// Materialized view of a wait.
structure Wait {
    @required
    runId: RunId

    @required
    waitId: WaitId

    @required
    resumeAt: Timestamp

    completedAt: Timestamp

    @required
    createdAt: Timestamp
}
