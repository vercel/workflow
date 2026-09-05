# Worlds

A World is the runtime's sole durable connection to storage, queues, streams, deployment identity, encryption keys, and optional platform capabilities.

## Purpose of the Abstraction

The replay engine depends on behavioral contracts rather than a specific database or hosting platform.

`@workflow/world` defines schemas and interfaces shared by the core runtime and all backends. A World combines event and entity storage, queue production and consumption, stream persistence, lifecycle hooks, deployment identity, protocol version, and optional optimizations.

The World API is also the complete schedule boundary for deterministic simulation: all externally observable progress crosses one of its methods.

## Event-Sourced Storage

Events are the write API; runs, steps, Hooks, and waits are materialized read models updated atomically with their events.

A caller cannot directly mutate a run or step status. Cancellation, completion, retrying, Hook receipt, and wait completion are expressed as events. Worlds validate lifecycle transitions, enforce uniqueness, append the event, and update the affected entity as one logical operation.

This design makes replay, audit, and recovery share one authority. A materialized entity that disagrees with the log is a backend consistency defect, not an alternative interpretation.

## Append and Slot Contract

Every successful append occupies a dense event slot, and every list result must be a prefix of the committed log.

Positions are allocated at commit, or preallocated positions are hidden until filled or sealed with a `noop`. A reader must never return events above an unresolved hole because the runtime uses log length as evidence of the highest observed position.

Single-event creation receives the writer's event-count snapshot. If that position is already occupied, the World commits at the next free position and reports the intervening events. Optional batch creation must be atomic per attempt and preserve request order in consecutive slots.

These rules turn concurrency into an observable stale prefix. They prevent a later write from appearing behind history a replay has already consumed.

## Idempotency and Concurrency

World operations assume concurrent writers, queue retries, client retries, and process death between adjacent effects.

Entity correlation IDs, run IDs, Hook tokens, resume IDs, queue idempotency keys, and lifecycle validation make repeated operations converge. A World may return a canonical existing result or a typed conflict, depending on the operation, but it must never allow two terminal outcomes or two owners for one attempt.

Optimistic preconditions may reject a decision made from stale externally originated history. The runtime abandons that replay rather than retrying the same derived event against a newer log, because the corrected replay may generate a different correlation ID or operation sequence.

## Queue Contract

The queue delivers orchestration and step messages at least once and supports immediate or delayed publication.

Messages carry routing and replay metadata; the run's event log carries truth. Implementations acknowledge only after the handler completes. Retry delays, waits, and ownership backstops use durable scheduling rather than process timers.

Concurrency limiting is an optional capability. When sequential replay is configured, both build-time queue trigger configuration and runtime topic selection must agree; a partial configuration does not establish serialization.

## Capability Negotiation

Optional methods and declared capabilities enable fast paths without making older or third-party Worlds unsafe.

Examples include batch event writes, run-status long polling, bulk cancellation, Hook retention, resume deduplication, queue concurrency limits, deployment affinity, environment identity, and analytics queries. Absence means unsupported, and core must keep a conservative fallback.

Capabilities describe behavior, not branding or inferred environment. A remotely controlled backend feature may need a fresh response-level attestation so rollback or a kill switch takes effect without redeploying the adapter.

## Encryption Responsibility

A World may resolve a run-specific AES key or enough context for sealed cross-run writes, but serialization and cryptography remain in core.

This separation keeps storage opaque to application values. Worlds store bytes and plaintext routing metadata; core derives payload keys, encrypts or seals values, and hydrates them after reading. A World that omits key resolution explicitly operates without payload encryption.

## Implementations

The repository includes production, development, self-hosted, simulation, and testing implementations with different scheduling properties.

| World | Storage | Queue | Intended use |
| --- | --- | --- | --- |
| Local | JSON/filesystem with cross-process locking | In-memory/in-process delivery | Local development and lightweight integration tests |
| PostgreSQL | PostgreSQL/Drizzle | Embedded Graphile Worker | Reference multi-host self-hosting |
| Vercel | Managed Workflow service over HTTP/WebSocket | Vercel Queues | Production Vercel deployments |
| Simulation | Deterministic in-memory event store | Explicit virtual scheduler | Reproducible race and consistency scenarios |
| Testing | Test server utilities | Test-controlled | Framework and user workflow testing |

The local and PostgreSQL Worlds are not simplified aliases for Vercel. Their queue concurrency, event-slot arbitration, process topology, and deployment model differ, so concurrency-sensitive changes must be checked in each relevant implementation.

## World Lifecycle and Module Identity

A World can initialize background consumers and release owned resources, but published implementations must remain safe when bundlers duplicate modules.

Mutable state belongs on the World instance. Genuine process-wide registries and warn-once latches use versioned `globalThis` singletons. Top-level `Map`, `let`, or mutable object state is prohibited because framework bundlers can create separate copies for instrumentation, route, SSR, or edge layers in one process.

`start()` and `close()` are optional lifecycle methods. Caller-owned resources, such as a supplied PostgreSQL pool, remain caller-owned; World-created resources must be released by `close()` so CLI and test processes can exit cleanly.
