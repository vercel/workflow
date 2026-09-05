# Workflow SDK

Workflow SDK turns ordinary TypeScript functions into durable programs whose progress survives process loss, deployment changes, retries, and long periods of inactivity.

This directory records the system's stable concepts and decisions. It complements the user documentation and source comments by explaining how the pieces fit together and which invariants implementations must preserve.

## Reading Map

Start with the architecture and execution model, then follow the links for the subsystem being changed.

- [[architecture]] maps packages, generated artifacts, and request boundaries.
- [[execution-model]] explains deterministic replay, suspension, and step execution.
- [[domain-model]] defines runs, steps, hooks, waits, streams, and their relationships.
- [[build-system]] documents directive compilation and framework integration.
- [[worlds]] defines the persistence and queue abstraction and its concurrency contract.
- [[data-and-compatibility]] covers serialization, encryption, protocol evolution, and deployment pinning.
- [[rust-portability]] proposes a shared Rust implementation for portable Worlds and CLI tooling across language SDKs.
- [[testing]] explains the repository's layered verification strategy.

## Architectural Priorities

Durability and deterministic reconstruction take precedence over preserving the execution behavior of an ordinary in-process function.

The major consequences are:

1. Side effects cross an explicit step boundary.
2. Durable state changes are events, while entity records are materialized views.
3. Queue delivery and external requests are assumed to be repeatable.
4. A run keeps the code and protocol context with which it began.
5. Optional optimizations must fail closed to a conservative path.
