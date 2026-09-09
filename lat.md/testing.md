# Testing Strategy

Tests are layered around pure contracts, runtime replay behavior, backend consistency, compiler output, framework integration, and deployed end-to-end execution.

## Unit and Contract Tests

Package-local Vitest suites validate schemas, state transitions, serialization, error classification, queue helpers, compiler utilities, and backend operations close to their implementation.

World tests should emphasize the contract in [[worlds]]: append-only transitions, dense log prefixes, materialized-view agreement, idempotency, token uniqueness, terminal-state enforcement, streams, and lifecycle cleanup. Directly staged storage tests are preferred when a filesystem or transaction race can be reproduced without a full server.

## Replay Tests

Core replay tests validate that committed histories deterministically reconstruct workflow behavior under concurrency, asynchronous hydration, and VM boundaries.

High-value cases include parallel steps, `Promise.race`, Hook/wait/step ordering, duplicate events, retained sessions, cold replay, serialization failures, retries, cancellation, stale snapshots, deployment guards, and corrupt or stranded events. A test should distinguish infrastructure starvation from a replay that actually reached an invalid history.

## Compiler and Integration Tests

SWC fixtures and builder tests specify directive syntax, transformed output, discovery, IDs, closures, class registration, tree shaking, module resolution, manifests, and generated route code.

Framework integration tests cover the layer-specific risks that unit transforms cannot: duplicated module graphs, loaders, export conditions, externals, watch rebuilds, virtual routes, build output placement, and source maps. Transformation behavior and `packages/swc-plugin-workflow/spec.md` must move together.

## Simulation Tests

`@workflow/world-sim` makes concurrency schedules explicit and deterministic rather than relying on repeated probabilistic races.

A scenario can pause a writer before a World call or after its effect commits, inject another writer, advance virtual time, and then release execution. The simulator checks event/entity invariants and cold-replays completed histories with the terminal event withheld to prove the same outcome is derivable from the log alone.

Simulation is the preferred home for protocol interleavings that can be expressed at the World boundary. It complements implementation-specific tests for locks, SQL transactions, network retries, and queue behavior.

## Workbenches

Workbench applications verify the published developer experience across supported frameworks and bundlers.

Shared workflows should normally be authored once in `workbench/example` and symlinked into other workbenches. Framework-specific applications then test configuration, build hooks, generated routes, local servers, deployment output, and runtime behavior without allowing their workflow semantics to drift.

Packages must be built before downstream workbench or end-to-end tests consume them, because the workbenches exercise package artifacts rather than arbitrary source imports.

## End-to-End Tests

The core end-to-end suite drives public APIs through a running or deployed workbench and verifies observable durable behavior.

Local Next.js testing requires the workflow manifest to be public at build time. Deployed lanes additionally exercise Vercel routing, deployment IDs, authentication, and cross-invocation behavior. The CI workflow matrix is the source of truth for app names and deployment configuration.

## Event-Log Race Harness

The dedicated race harness applies repeated out-of-band wakes and concurrent replays to detect `CORRUPTED_EVENT_LOG` in realistic queue and World implementations.

Its scenarios cover step storms, Hook storms, a blocked-branch ordinal race, and a sleep control. PostgreSQL, local, and Vercel lanes expose different arbitration and scheduling, so results are not interchangeable. Default-scale green runs mean only that the storm did not trigger a defect; they are not rate estimates.

`corrupt` means the race executed and violated replay. `stuck` often means process, queue, or memory starvation prevented the intended race. Diagnosis should use progress events and resume pressure, not only the aggregate status. The local lanes are report-oriented when their baseline is unstable; the deployed Vercel lane remains the gate.

## Static and Documentation Checks

Formatting, linting, type checking, package builds, docs sample type checks, bundle-size checks, and `lat check` protect repository-wide interfaces.

Local static checks are advisory during development, while CI is authoritative. Bundle-size gating measures builder-emitted workflow code separately from framework output because only the former isolates the flow route's VM payload. Documentation changes must preserve agent-readable sitemap routes, and every configurable environment variable needs public documentation.

## Choosing a Test Level

Use the narrowest deterministic level that proves the relevant invariant, then add broader coverage only for a boundary the narrow test does not exercise.

- Use a pure unit test for parsing, serialization, event folding, or helper behavior.
- Use a World storage test for atomicity, locking, uniqueness, or backend materialization.
- Use simulation for controlled multi-writer ordering.
- Use compiler tests for source semantics and generated identifiers.
- Use a workbench build for framework bundling and route generation.
- Use end-to-end tests for queue, transport, deployment, or public API behavior.
- Use the race harness for probabilistic whole-system concurrency regressions, not as the first way to stage a known backend race.
