$version: "2"

namespace vercel.workflow.world

/// Marks an operation that must never be exposed over a network transport.
///
/// Operations carrying this trait exist so that in-process implementations
/// share one cross-language contract (TypeScript, Python) for behavior that
/// is resolved locally: ID minting, environment attribution, deadlines,
/// display enrichment, and encryption-key resolution. Any future transport
/// projection is expected to remove these operations from its closure and to
/// fail the build if one survives.
@trait(selector: "operation")
structure localOnly {}

/// Marks an operation as part of an optional World capability.
///
/// Smithy services have no notion of an optional operation, so optional
/// behavior lives in its own service closure. This trait records which
/// capability an operation belongs to so wrappers and conformance tooling can
/// tie a generated service to the capability an implementation advertises in
/// `WorldInfo`.
@trait(selector: "operation")
structure optionalCapability {
    /// Capability name as advertised by `WorldInfo$capabilities`.
    @required
    name: String
}

/// Marks an operation that is invoked in the reverse direction: the World (or
/// its queue adapter) calls the workflow runtime rather than the other way
/// around.
@trait(selector: "operation")
structure callback {}
