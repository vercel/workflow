# Data and Compatibility

Durable values must remain readable across VM boundaries, queue transports, SDK upgrades, backend upgrades, and the deployment lifetime of a run.

## Serialization Pipeline

Workflow inputs, step inputs and outcomes, Hook payloads, errors, closures, and durable handles pass through context-specific serialization and hydration.

The codec preserves supported JavaScript values and custom classes using reducers and revivers. Workflow-, step-, and client-side entry points use compatible formats but register values in the globals appropriate to their environment. Object graphs are passed by value; mutating a step argument does not mutate workflow memory on replay.

Serialized binary payloads begin with a four-byte lowercase alphanumeric format prefix. Prefixes make stored data self-describing and allow codecs or wrappers to evolve without requiring the World to understand application values.

## Compression and Encryption

Compression and encryption compose around the encoded payload and are gated by the run's protocol capabilities.

Large supported payloads may be compressed before storage. When a World provides a run key, core uses derived keys and authenticated encryption; cross-run writers can use a published run encryption key to seal a payload without gaining read access.

Routing fields, lifecycle metadata, attributes, and error classification remain plaintext where backends and observability tools need them. Application inputs, outputs, and thrown values remain opaque until hydrated with the correct keys and class registrations.

## Serializable Types

Only values with stable cross-context meaning may cross a durable boundary.

The built-in set includes ordinary structured JavaScript data plus supported platform objects, errors, streams and SDK handles. `Request` and `Response` bodies use durable built-in steps when consumed from workflow code. Custom classes opt in with static serialization and deserialization symbols and must be discoverable in both producing and consuming bundles.

Serialization failures at a step boundary become durable failures that workflow code can catch. Failures before the runtime can establish a valid durable boundary fail the run rather than silently dropping data.

## Protocol Versions

Each run is stamped with a World protocol version, and behavior checks use that persisted version rather than the currently installed package version.

The version history layers event sourcing, binary queue transport, attributes, compression, slot-numbered events, and sealed logs. New readers may support more versions than new Worlds mint during a rollout. Feature checks are monotonic `>=` tests so existing runs retain their original scheme.

At startup, core verifies that the selected World is neither below the runtime's required floor nor above its readable ceiling. This fails early instead of corrupting a run midway through replay.

## Compatibility Strategy

Compatibility is coordinated across four independently deployed surfaces: compiled application code, core runtime, World adapter, and World backend.

Changes follow these principles:

- Persisted run version controls wire and storage semantics.
- Unknown optional fields are tolerated where safe; unsupported required formats fail explicitly.
- New optimizations require method presence, capability declarations, or fresh backend attestations and retain an old path.
- Queue payload additions are optional for rolling producers and consumers.
- Kill switches restore the previously correct behavior rather than creating a third protocol.
- Definition IDs remain stable across the bundles participating in one run.

Compatibility code is part of the architecture, not temporary clutter. Removal requires evidence that persisted runs, old queue messages, and rolling deployments can no longer reach it.

## Deployment Pinning

A run normally executes on the immutable deployment that created it so replay sees the same workflow code and definition IDs.

New deployments receive new runs while in-flight runs continue on their original deployment. Worlds that can guarantee atomic immutable deployments declare deployment affinity; the runtime can reroute a misdelivered message and fail a persistent mismatch.

Worlds with synthetic or version-derived deployment IDs must not claim this capability because a changed ID does not necessarily mean changed logical code placement. Environment identity is checked separately to prevent resilient start from accidentally creating the same run in two tenants.

`deploymentId: "latest"` is an explicit boundary for starting a new run, not permission to replay old history on new code. Long-lived workflows upgrade by carrying state into a successor run.

## Resilient Boundaries

Queue publication and event creation can fail independently, so selected messages carry enough serialized data for the consumer to re-establish missing durable state idempotently.

Resilient start lets the first delivery ensure `run_created` when the initiating write failed transiently. Resilient step dispatch can carry step input so a consumer ensures `step_created`. Hook resume uses a durable event before publishing its wake, with legacy payload-carrying messages still understood for rolling compatibility.

These paths require stable idempotency identities and byte-identical serialized payloads. They address process and transport failure windows; they do not change the event log's authority.

## Error Compatibility

Stored failures preserve the thrown value where possible and also carry a stable plaintext error code for classification.

User failures, runtime failures, World contract violations, deployment mismatches, replay divergence, delivery exhaustion, and serialization errors have different operational meaning. Callers and observability tools should branch on codes rather than parsing messages, while hydrated causes preserve application diagnostics.
