$version: "2"

metadata shapeClosures = [
    {
        id: "vercel.workflow.world#WorldTypes"
        includeNamespaces: ["vercel.workflow.world"]
    }
]

namespace vercel.workflow.world

/// The required World surface.
///
/// Every implementation provides all of it. Optional behavior lives in the
/// capability services instead, so a generated interface never forces an
/// implementation to stub a method it does not support.
///
/// No protocol trait is applied anywhere in this model. The operations are
/// transport-independent by construction: an in-process implementation
/// satisfies the generated interface directly, and any wire format is a
/// separate projection that layers protocol and binding traits on top.
service WorldCore {
    version: "2026-08-18"

    operations: [
        GetWorldInfo
        CreateRun
        GetRun
        ListRuns
        GetStep
        ListSteps
        CreateEvent
        GetEvent
        ListEvents
        ListEventsByCorrelationId
        GetHook
        GetHookByToken
        ListHooks
        WriteStreamChunk
        CloseStream
        ReadStream
        ListStreams
        ListStreamChunks
        GetStreamInfo
        GetDeploymentId
        Enqueue
    ]
}

/// Optional optimizations.
///
/// An implementation that omits this service is fully supported; callers fall
/// back to the equivalent `WorldCore` operations.
service WorldBatch {
    version: "2026-08-18"

    operations: [
        BatchGetRuns
        BulkCancelRuns
        WriteStreamChunks
    ]
}

/// Operations the workflow runtime implements and a World's queue adapter
/// calls.
service WorldConsumer {
    version: "2026-08-18"

    operations: [
        DeliverQueueMessage
    ]
}

/// Operations that are resolved in-process and never exposed over a
/// transport. See the `localOnly` trait.
service WorldLocalHooks {
    version: "2026-08-18"

    operations: [
        CreateRunId
        GetRuntimeDeadline
        GetEnvironment
        DescribeRun
        GetEncryptionKeyForRun
    ]
}

/// Feature capabilities an implementation declares.
///
/// Every member defaults to unsupported when absent: a runtime fast path
/// gated on a capability must keep its conservative behavior unless the
/// capability is explicitly declared.
structure WorldCapabilities {
    /// Supports minimum token retention for hooks.
    hookRetention: HookRetentionCapability

    /// Fences a stale replay-context write with `PreconditionFailedError`
    /// rather than committing it. Accepting a snapshot and ignoring it is not
    /// the same thing, and must leave this unset.
    preconditionGuard: Boolean

    /// The queue supports concurrency-limited consumption, including the
    /// per-run topics consumed with a limit of one.
    maxConcurrency: Boolean

    /// `CreateEvent` deduplicates concurrent `hookReceived` writes carrying
    /// the same `(runId, resumeId)`, collapsing them onto one committed
    /// event.
    hookResumeDedup: Boolean

    /// Deployment IDs are atomic and immutable, so a run pinned to one may
    /// only execute there. Implementations whose deployment ID is synthetic
    /// or version-tagged must leave this unset.
    deploymentAffinity: Boolean

    /// Event IDs encode the event's dense, 1-based slot in its run's log.
    /// Implies both density and bump-and-report on contention.
    slotEventIds: Boolean
}

structure HookRetentionCapability {
    @required
    active: Boolean
}

/// Names of the optional capability services this implementation provides,
/// matching `optionalCapability`.
list CapabilityNameList {
    member: String
}

/// Reports the implementation's protocol version and capabilities.
///
/// This replaces inferring support from method presence, which stops working
/// as soon as calls cross a transport where every method always exists.
@readonly
operation GetWorldInfo {
    input := {}

    output := {
        /// Workflow protocol spec version this implementation writes.
        /// Runtimes require an exact match before creating or replaying runs.
        @required
        specVersion: Integer

        capabilities: WorldCapabilities

        /// Optional capability services that are available.
        optionalCapabilities: CapabilityNameList
    }

    errors: [
        ThrottledError
        InternalError
    ]
}
