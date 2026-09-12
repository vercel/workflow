$version: "2"

namespace vercel.workflow.world

/// Identifier of a workflow run.
string RunId

/// Identifier of a step within a run.
string StepId

/// Identifier of an event within a run's log.
string EventId

/// Identifier of a hook.
string HookId

/// Identifier of a wait.
string WaitId

/// Identifier of a deployment a run is pinned to.
string DeploymentId

/// Machine-readable workflow function name, e.g.
/// `workflow//./src/workflows/order//processOrder`.
string WorkflowName

/// Machine-readable step function name.
string StepName

/// Name of a stream within a run.
string StreamName

/// Opaque, implementation-defined pagination cursor.
string Cursor

/// Correlation identifier tying an event to the entity it affects.
string CorrelationId

/// Opaque serialized workflow data.
///
/// Payload bytes are produced by the SDK serialization pipeline and may be
/// compressed and/or encrypted. The World never interprets them. Runs created
/// by spec version 1 carried unserialized JSON instead; those records are not
/// representable here and must be converted by a compatibility adapter.
blob SerializedData

/// Controls whether payload-bearing fields are resolved in a response.
///
/// Smithy cannot vary an output shape by an input value, so payload members
/// stay optional and `NONE` simply leaves them absent.
enum ResolveData {
    /// Omit payload fields such as input, output, error, and metadata.
    NONE = "none"

    /// Resolve all payload fields.
    ALL = "all"
}

/// Sort direction for list operations, ordered by creation time.
enum SortOrder {
    ASC = "asc"
    DESC = "desc"
}

/// Cursor pagination request options.
structure Pagination {
    /// Maximum number of items to return.
    @range(min: 1, max: 1000)
    limit: Integer

    /// Cursor returned by a previous page.
    cursor: Cursor

    /// Sort direction. Callers that depend on ordering should always set it.
    sortOrder: SortOrder
}

/// Retention window metadata returned by plan-aware list operations.
structure PageInfo {
    @required
    currentLookbackDays: Integer

    @required
    maxLookbackDays: Integer

    @required
    currentWindowStart: Timestamp

    @required
    maxWindowStart: Timestamp

    @required
    upgradeAvailable: Boolean
}

/// Plaintext run attributes.
map AttributeMap {
    key: String
    value: String
}

/// A single attribute mutation. Keys absent from a change set are untouched.
structure AttributeChange {
    @required
    key: String

    @required
    change: AttributeChangeValue
}

/// Upsert or removal of one attribute key.
union AttributeChangeValue {
    /// Upsert the key with this value.
    set: String

    /// Remove the key.
    remove: RemoveAttribute
}

/// Removal of an attribute key.
///
/// An empty structure rather than `Unit` so the variant can gain members
/// later without a breaking change.
structure RemoveAttribute {}

list AttributeChangeList {
    member: AttributeChange
}

/// Structured error metadata carried by run and step failures.
structure StructuredError {
    @required
    message: String

    stack: String

    /// Machine-readable error code, e.g. `USER_ERROR` or `RUNTIME_ERROR`.
    code: String
}
