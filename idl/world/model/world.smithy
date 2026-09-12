$version: "2"

metadata shapeClosures = [
    {
        id: "vercel.workflow.world#WorldTypes"
        includeNamespaces: ["vercel.workflow.world"]
    }
]

namespace vercel.workflow.world

/// The World interface.
///
/// One interface, implemented by every World: local, Postgres, Vercel, and
/// the simulator. This is the whole point of the model, so the surface is not
/// split by concern, by optionality, or by whether an operation can cross a
/// network.
///
/// Two of those distinctions still exist, and both are traits on operations
/// rather than separate interfaces:
///
/// - `optionalCapability` marks an operation an implementation may omit. It
///   is the modeled form of today's optional `World` methods (`getMany?`,
///   `cancelMany?`, `writeMulti?`), and callers feature-detect it exactly as
///   they do now. `GetWorldInfo` reports which ones are present.
/// - `localOnly` marks an operation that is resolved in-process and must
///   never be exposed over a transport. It stays on this interface because a
///   World implements it; a future transport projection is what drops it.
///
/// No protocol trait is applied anywhere in this model. The operations are
/// transport-independent by construction: an in-process implementation
/// satisfies the generated interface directly, and any wire format is a
/// separate projection that layers protocol and binding traits on top.
service World {
    version: "2026-08-18"

    operations: [
        GetWorldInfo
        CreateRun
        GetRun
        BatchGetRuns
        ListRuns
        BulkCancelRuns
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
        WriteStreamChunks
        CloseStream
        ReadStream
        ListStreams
        ListStreamChunks
        GetStreamInfo
        GetDeploymentId
        Enqueue
        CreateRunId
        GetRuntimeDeadline
        GetEnvironment
        DescribeRun
        GetEncryptionKeyForRun
    ]
}

/// The runtime's own queue-consumer interface.
///
/// Deliberately not part of `World`, and not a second World interface: the
/// implementor is the workflow runtime, and the caller is a World's queue
/// adapter. Today this is the callback handed to `createQueueHandler`.
/// Folding it into `World` would say that a World implements it, which is
/// backwards.
service RuntimeQueueConsumer {
    version: "2026-08-18"

    operations: [
        DeliverQueueMessage
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
