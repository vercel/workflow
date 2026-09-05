# Domain Model

The durable domain consists of a run-level event log, materialized entities derived from it, queue deliveries that advance execution, and separately persisted streams.

## Workflow Definition

A workflow definition is a compiled function identified by a stable workflow ID containing its source module identity and function path.

The ID connects application-side `start()` calls, build manifests, queue topics, and the workflow registry inside the VM. Local files use project-relative module identities; published packages can use versioned module specifiers so cross-bundle references stay stable.

## Run

A Run is one invocation of a workflow definition, pinned to a deployment and protocol version for its lifetime.

Its lifecycle is `pending` → `running` → one of `completed`, `failed`, or `cancelled`. The run owns the event log, child entities, named streams, serialized input and outcome, optional execution context, attributes, timestamps, and encryption metadata.

The public `Run` handle is a serializable reference. It exposes status, return value, cancellation, sleep interruption, and readable streams without containing the execution itself.

## Event

An Event is the immutable record of a durable state transition and the source from which entity state is materialized.

Run events describe creation, start, attributes, and termination. Step events describe creation, attempts, retrying, and terminal outcomes. Hook and wait events describe creation and externally driven completion. A sealed log may contain `noop` fillers with no workflow meaning.

Every event belongs to a run. Most child-entity events also carry a correlation ID, which links all transitions of one logical operation across replays and delivery retries.

## Event Slot

An event slot is the dense, one-based position of an event in a run's committed history.

Current event IDs encode the slot as `evnt_` plus a zero-padded position. A World must return a contiguous prefix: a reader may lag behind new commits, but it must never observe an event above an unresolved hole.

When a concurrent writer commits above the caller's snapshot, the World advances the write to a free slot and can report skipped events back. This lets the runtime discover stale history without rejecting a still-valid idempotent write.

## Step

A Step is one durable invocation of a named step function and is identified within its run by a deterministic correlation ID.

It stores serialized input, the latest attempt, timestamps, and either output or error. Its states are pending, running, completed, failed, or cancelled. Attempts may repeat, but a terminal outcome is final and the body must never have two simultaneous owners.

The step name identifies executable code in the host-side registration map. The step ID identifies this particular invocation's entity; keeping those concepts separate allows the same function to be called repeatedly.

## Hook

A Hook is a durable channel from an external producer into a suspended workflow.

It has an internal ID, an externally addressable token, an owning run, optional metadata, and optional token-retention rules. Tokens are unique among live or retained Hooks. A Hook can receive multiple payloads until disposal or run termination.

A Webhook is a Hook with an HTTP adapter. The generated webhook route turns a request into a resumable payload and can coordinate automatic, static, or manual HTTP responses.

## Wait

A Wait represents a durable time suspension with a stable resume deadline.

It begins in `waiting` and becomes `completed` once. Delayed queue messages are wake-up mechanisms, not the state itself; the persisted wait and its events decide whether an early, duplicate, or retried delivery should do anything.

## Stream

A Stream is an ordered, durable sequence of chunks associated with a run and a namespace.

Streams are stored outside the event log because their volume and live-consumption behavior differ from orchestration state. They support append, close, live reading, snapshot pagination, tail inspection, and reconnection from an absolute or relative chunk index.

Stream handles may cross workflow and step boundaries, but actual I/O occurs in step or application contexts. Closing the run closes remaining streams; explicit close lets consumers finish earlier.

## Attributes and Execution Context

Attributes are plaintext string metadata intended for filtering and grouping, while execution context is opaque runtime and World metadata.

User attributes reject the reserved `$` prefix unless a framework-level caller explicitly opts in. The reserved namespace carries system concepts such as parent and root run lineage.

Execution context can evolve without a storage schema change and holds data such as replay provenance, VM selection, protocol capability markers, or trace context. It is not a substitute for user workflow state: decisions that must replay belong in inputs, results, or events.

## Identifiers

Different identifier families serve different stability scopes and must not be interchanged.

- Workflow, step-function, and serialization-class IDs identify compiled definitions.
- Run IDs identify invocations and may embed World-specific routing metadata while retaining a ULID-compatible shape.
- Correlation IDs deterministically identify child operations within a replay.
- Event IDs encode committed log position.
- Hook tokens are external routing keys and may be user-selected.
- Queue message IDs identify delivery attempts and can participate in transient ownership leases.

Definition IDs must remain stable across the bundles that serialize, orchestrate, and execute the same code. Invocation and correlation IDs must remain stable across retries without becoming global names for the underlying definition.
