# Rust Portability Architecture

Rust becomes the shared implementation layer for portable tooling and self-hosted Worlds, while language SDKs retain idiomatic APIs and existing JavaScript entry points remain compatible.

## Design Status

This document fixes the intended boundaries and sequencing. Phases 0 through 2 now have executable evidence, while later-phase choices remain open where a focused prototype or benchmark is still needed.

The status words used below have precise meanings:

- **Direction** is the working architecture and should change only with a recorded reason.
- **Provisional** is the preferred option, but must be validated before becoming a compatibility promise.
- **Open** identifies a decision that should not be hidden inside an implementation pull request.

The current directions are an in-process Rust library, a new SQLite-backed local profile, thin Node.js and Python bindings, a native CLI kernel with language drivers, and incremental coexistence with the TypeScript implementations.

The decision ledger keeps established boundaries separate from hypotheses that still need evidence:

| Decision | Status |
| --- | --- |
| Rust owns World durability while language SDKs own replay and compilation | Direction |
| The primary integration is an in-process library, not a required daemon | Direction |
| Local persistence moves to a new SQLite format | Direction |
| Node.js uses napi-rs and Python uses PyO3 with thin host adapters | Direction |
| The native CLI delegates language-specific work to versioned drivers | Direction |
| Shared transition logic is a pure, spec-aware plan executed inside backend transactions | Direction |
| First-slice structural types are hand-mapped and checked by a backend-neutral conformance suite and shared fixtures | Direction |
| Node.js and Python adapters use direct host-type mappings, and each wrapper ships atomically with its native artifact | Direction |
| SQLite uses bundled `rusqlite`, explicit migrations, WAL, checksummed migration history, and bounded blocking execution | Direction |
| The portable-local native gate is Rust 1.88, Node.js 22/24, Linux x64 glibc, macOS arm64, Windows x64, and bundled SQLite 3.53.2 | Direction |
| One SQLite file also contains a leased durable local queue | Direction |
| One SQLite file is one application boundary, while stable local deployment IDs identify compatible worker groups | Direction |
| A Rust-owned worker delivers the initial SQLite queue exclusively through loopback HTTP; direct binding callbacks are deferred | Direction |
| Language hosts explicitly register a complete loopback flow URL in process memory before a SQLite worker claims messages | Direction |
| Initial SQLite HTTP callback validation matches existing self-hosted Worlds; per-claim authorization is deferred and recorded as hardening | Direction |
| Local `tag` selects a separate SQLite database per Vitest pool in the host; it is not an overlay or schema scope | Direction |
| SQLite local defaults to `synchronous=NORMAL`, a five-second contention budget, one writer plus three readers, and 1000-page passive auto-checkpoints | Direction |
| SQLite databases live in `WORKFLOW_LOCAL_DATABASE_DIR`, default `.workflow-database`; the legacy data directory is not an alias | Direction |
| Context-bearing fields use a portable `ContextValue` tree, direct binding conversion, and schema-selected standard CBOR BLOBs | Direction |
| Durable stream FFI uses owned byte chunks, explicit cursors, bounded polling, and host-native cancellation | Direction |
| Final public package names and platform artifact layout | Open |
| Native-wheel repository, publisher, and cross-repository release coordination | Open |
| PostgreSQL schema coexistence and replacement for Graphile Worker | Open |
| Legacy local-data importer and timing of default switches | Open |

### Phase 0 Evidence

The first contract slice records what the probes establish without promoting narrow implementation details into compatibility promises.

The shared resilient-run-start fixture is validated against JSON Schema by TypeScript and decoded into independently declared Rust types. First-slice structural types remain hand-mapped and are checked by an expanded backend-neutral conformance suite and shared fixtures. Moving a larger contract to an IDL requires separate evidence that manual synchronization has become the limiting cost; an IDL would not replace behavioral tests.

The Node-API and PyO3 probes pass owned byte buffers and ordinary host values into Rust and recursively convert execution context directly into an owned `ContextValue`. The conversion rejects cycles and unsupported host objects; repeated references become equal, independent subtrees. Ordinary requests and results use direct binding mappings rather than a general JSON or CBOR envelope. Each language wrapper and its native addon form one atomic release unit; build identity and native metadata are diagnostic, not an independently versioned adapter protocol. Returning fixture-shaped JSON and checking protocol version 1 are probe instrumentation rather than selected interfaces. Cancellation, streams, large-payload measurements, and backpressure remain validation work for their specialized binding shapes.

The SQLite backend uses synchronous `rusqlite` with its bundled SQLite build and runs database work on bounded blocking executors so it never blocks a host event loop or holds the Python GIL. This avoids making an async runtime part of the shared embedded layer while retaining direct transaction, error-code, and fault-injection control. Schema changes run only through an explicit migration call under one `BEGIN IMMEDIATE` transaction, enter WAL mode, and record ordered checksums. Concurrent migrators, process death before and after commit, history gaps, future versions, and checksum drift are tested. Runtime operations reject missing or incompatible migration history instead of migrating implicitly. The local profile explicitly uses `synchronous=NORMAL`, a total five-second contention budget, one serialized writer plus at most three readers per process and database, and 1000-page passive auto-checkpoints.

The leased-queue storage prototype keeps messages in the same SQLite file and scopes claims by an explicit target and queue name. The shipped SQLite profile treats the file itself as the application boundary rather than adding a queue-only application ID that would falsely suggest tenant isolation. Its existing `deploymentId` becomes a stable compatible-worker-group target: JavaScript and Python default to distinct `local-js` and `local-python` targets, callers may override the target deliberately, and SDK, native build, process, port, and path identities never enter it. A worker claims only its configured target and exact advertised queue names; workers sharing both are replicas. Local targets do not enable immutable deployment affinity. Active-run reconciliation filters by deployment and derives one deterministic message ID per run within that database. Claims use distinct lease capability tokens, retain the message ID across lease expiry and timeout rescheduling, and are tested across competing and killed processes. The current fixture's opaque application/deployment `scope` is probe input, not a public string callers will construct or a `tag` column the shipped schema must retain.

The Node-API probe now starts a Rust-owned single-concurrency supervisor with an explicit full flow URL. It proves claim-then-delivery ordering, stable message identity and increasing attempts across an HTTP failure and handler-requested `timeoutSeconds`, final acknowledgement, and bounded close during a stalled response. Loopback HTTP is the initial SQLite queue's only delivery transport; direct Node-API or PyO3 callbacks are deferred unless later benchmarks establish a need. Shipped hosts likewise resolve and explicitly register the complete URL before worker activation; Rust does not scan ports, issue discovery health probes, or guess a listening socket. Programmatic configuration, `WORKFLOW_LOCAL_BASE_URL`, a framework-provided address, or an explicit `PORT` may supply it. An unresolved or conflicting registration fails before any claim. The registration is process state shared across bundled World copies and is not persisted. Initial HTTP callback validation deliberately matches the existing TypeScript local and PostgreSQL Worlds rather than adding authorization in this slice. The prototype uses one blocking delivery thread and a minimal HTTP client with a request timeout; it validates the boundary, not the final concurrency, production HTTP client, or observability design.

The repository-local technical floor is Rust 1.88 for both native bindings; the native dependency graph does not compile under the workspace's older Rust 1.87 floor. The existing probe CI exercises Node.js 22 and Python 3.13 across Linux x64, macOS arm64, and Windows x64. The Python extension selects `abi3-py39`, so Python 3.9 is the intended interpreter floor for that probe. This evidence informs the Phase 1 gate in [[rust-portability#Native CLI#Initial Native Validation Matrix]], but neither the probe nor that gate is a public support promise.

The persisted-codec fixture fixes three boundaries. New SQLite execution context uses `workflow-cbor-v1`; Rust verifies exact writer bytes and both Rust and the installed `cbor-x` reader verify the same value, including bytes. Legacy JSON/JSONB/text vectors cover PostgreSQL values, JSON-stringified errors, and world-local's byte sentinel. Independently generated `cbor-x` vectors cover extensible objects, byte arrays, `undefined`, `null`, and dates, and the Rust compatibility reader rejects trailing data, non-string object keys, and unknown tags. Phase 2 validates bounded queue concurrency; native-wheel ownership and final public package names remain open.

### Phase 1 Evidence

Phase 1 is implemented as an opt-in Node.js and SQLite walking skeleton. It proves the ownership boundaries without changing the current local default or claiming Phase 2 completeness.

`workflow-protocol` now defines the Phase 1 run, step, and event vocabulary, while `workflow-world-core` owns the pure transition planner. The dev-only `workflow-world-testkit` supplies a backend-neutral lifecycle trace consumed by SQLite tests. `workflow-world-sqlite` applies each plan, reserves the next dense event slot, appends the event, and materializes run or step state inside one SQLite write transaction. Repeated cancellation still journals an event, and an in-flight step may report a retry after its run becomes terminal while a pending step may not. Final non-empty list pages retain their last-item cursor so callers can continue polling, including descending reads from the maximum legal event slot. Schema version 3 is installed only by an explicit, checksummed migration. Rust tests also cover concurrent dense appends, incompatible expected counts, and reopening persisted state.

The private `@workflow/world-sqlite` package loads its co-versioned napi-rs artifact, checks Node-API 8 and bundled SQLite 3.53.2 identity, and exposes the repository's JavaScript `World` shape through direct host-type mappings. The binding rejects Node-API's lossy unsigned-integer coercions and accepts only `Uint8Array` byte views in portable context values; early step-start errors preserve their retry delay. Construction performs no filesystem writes, engines are shared per canonical database path and deployment target through `globalSingleton`, and `close()` drains accepted native work. Unsupported Phase 2 capabilities fail with stable errors instead of silently weakening their contract.

The minimal queue persists in the same database and consumes only its configured deployment target and exact queue names. Repeating an enqueue with the same idempotency key and payload reuses the first durable message ID even when the host proposes a fresh ID. Its callback timeout is one deadline shared by address attempts, request writes, and response reads, and bracketed IPv6 loopback URLs receive the HTTP default port correctly. A fresh-process test creates a run and queue message through JavaScript, reopens the database in another Node.js process, reads the dense log, delivers the typed payload over the registered loopback flow URL, and acknowledges the same durable message.

The `workflow-cli` crate provides `version`, `doctor`, explicit `sqlite migrate`, and metadata-only `sqlite inspect`. Inspection opens the database read-only: tests prove that it neither creates or migrates storage nor starts the worker or consumes queued work. JSON output includes the native, SQLite, schema, and persisted-spec identity needed for diagnostics.

CI gates this slice on Rust 1.88 and stable plus Node.js 22 and 24 across Linux x64 with glibc 2.28, macOS arm64 with a 13.5 deployment target, and Windows x64. Binding tests assert the compiled architecture and bundled SQLite version. Full workflow E2E, clean installation without a Rust toolchain, streams, Hooks, and the remaining optional capabilities stay in Phase 2.

### Phase 2 Evidence

Phase 2 completes the experimental Node.js portable-local profile without changing the default World.

The shared protocol and transition planner now cover the complete current event vocabulary, attribute writers, Hooks, waits, Hook conflicts, resume IDs and payload digests, retained tokens, and terminal cleanup. SQLite schema version 5 materializes those entities and enforces dense event slots, correlated-creation uniqueness, Hook-ID and Hook-token ownership, and resume deduplication in the same write transaction as the journal append. Direct planner and storage tests cover rejected mutations, divergent replays, cross-run ID and token conflicts, retained and disposed Hooks, wait completion, and reopen persistence.

Every wrapper for one canonical database resolves to a shared Rust runtime engine, including wrappers separated by deployment target. Missing path components are resolved from the nearest existing canonical ancestor, so aliases through a symlink cannot split the engine before the database directory exists. The current conservative implementation reuses one connection and serializes all in-process access, which stays below the three-reader ceiling. N-API tasks and queue workers retain that same engine rather than reconstructing a backend per call. Connection acquisition, the local lane, and SQLite lock waiting consume one five-second budget; retryable exhaustion reports the wait stage and elapsed time. Entity lists select and hydrate each page within one read transaction, so a concurrent process cannot turn a valid page into mixed state or a false corruption error. Closing the final native owner releases the cached connection even while the closed JavaScript wrapper remains reachable.

Streams are durable SQLite rows with atomic batch allocation, canonical opaque cursors, idempotent close, process-independent polling, and run-scoped cleanup. A closed stream remains readable through every page, while the synthetic queue-health stream is deliberately permitted without a materialized run. The JavaScript adapter also provides bounded terminal-status polling and maps every native byte result, including nested execution-context values, back to ordinary `Uint8Array` instances rather than leaking Node.js `Buffer` behavior.

The queue now runs a configurable bounded worker set, renews leases during slow HTTP handlers, delays and reschedules durable messages, and reconciles active runs by deployment target during startup. Lease claims and handler-visible delivery attempts are separate: connection failures rotate leases without exhausting runtime delivery attempts, while any received HTTP response advances the durable attempt before acknowledgement or rescheduling. Host registrations are process-wide but keyed by canonical database identity and deployment target; identical registration is idempotent, while only a conflict within that scope fails. Programmatic and environment base URLs take precedence over an explicit `PORT` fallback, and wildcard listen addresses normalize to loopback. Tests exercise competing workers, expired leases, monotonic renewal, transport failures followed by recovery, bounded shutdown, process death around commits, and deterministic recovery without duplicate amplification. Shutdown closes native state and surfaces accumulated background storage failures through a stable `QUEUE_STORAGE_FAILURE` error.

`@workflow/world-sqlite` exposes the complete current World surface intended for this profile, database-local `clear()`, explicit migration, host registration, recovery controls, Hook-retention limits, and diagnostic native identity. The repository's full `@workflow/world-testing` runtime suite runs against the built package and covers addition, event positions, idempotency, Hooks, null bytes, retries, inline execution, sleeps, streams, abort signals, and parent/root lineage. The wrapper packs its co-versioned native addon; the build injects the wrapper package version separately from the Cargo crate version and the loader requires an exact package match. Native Turbo caching is disabled while one filename serves several OS-specific artifacts. A clean temporary npm consumer installed that tarball and migrated a schema-version-5 database with `cargo` absent from `PATH`.

The core runtime's later experimental run-payload retention option is intentionally not claimed by this profile yet. SQLite preserves such data, which is the allowed fallback for a World that does not implement expiry, until ordinary cleanup or database-local `clear()`.

`@workflow/vitest` can select `world: 'sqlite'`. Each worker maps to one exact `vitest-<pool>.sqlite` file, explicitly migrates and clears only that database, and serves generated exact queue names through a private ephemeral loopback host. Read-only CLI and web observability discover only `workflow.sqlite` and safe Vitest filenames in the selected directory, validate exact Rust-pinned migration checksums and Workflow metadata through a read-only native handle without migration, merge creation-time-and-ID pages through composite cursors, and re-probe every database before returning or routing a run so duplicate IDs are rejected even after a short cached page. A source that cannot participate makes that uniqueness check fail closed; unambiguous reads route to the owning database, and the UI displays the source filename without adding a storage-level tag. Web requests rediscover the live database set and close their read-only handles after the operation or stream, so adding or removing a Vitest pool does not leave a stale aggregate.

The Next.js Turbopack workbench consumes the packed addon through its staged dependency graph, registers its exact generated queues before worker startup, and shares one absolute database directory with the E2E driver. The advisory `e2e-local-sqlite` CI lane puts failing `cargo` and `rustc` shims ahead of the runner toolchain before staging, builds and starts that production fixture, runs the applicable core and agent corpus, publishes structured failures and the server log, and participates in the aggregate summary without becoming a required check yet. The definitive local production run passed 158 of 160 tests in 238.05 seconds; the two report-only failures are deliberately unadvertised queue names (`.well-known/agent` and the nonexistent-workflow negative case), and no SQLite busy or connection-budget error occurred. The event-log race workflow likewise has a report-only SQLite lane with a fresh explicitly migrated database; a minimized local Hook/resume run completed and cleaned up successfully. The package README records the experimental platform, filesystem, durability, and non-production support boundary.

The same 2026-09-08 Apple M4 Pro/Node.js 24 snapshot measured a 6.2-second optimized Next.js compile, 96 MiB `.next` output (79.6 MiB under `.next/server`), a 7.6 MiB addon, 127 ms production readiness, and 607 MiB server RSS observed after the corpus. The checked-in queue benchmark makes its inputs explicit; at 1,000 one-byte messages and concurrency four, one sample enqueued at 11,383 messages/s and drained loopback delivery at 3,337 messages/s with 88.1 MiB process RSS and no failed delivery or storage operation. These are regression reference points, not support or throughput promises.

## Motivation

The current CLI and self-hosted Worlds make Node.js part of the operational substrate even when workflow definitions and their runtime live in another language.

A Python user should not need an npm installation or `npx workflow` merely to inspect or operate workflows. Likewise, every new language SDK should not independently reproduce the local filesystem layout, lock files, PostgreSQL schema, event transition rules, queue retry behavior, and migration tooling.

The duplication is especially dangerous at the World boundary. Correctness depends on the dense-prefix event log, atomic entity materialization, idempotent transitions, stable queue message identity, and crash recovery described in [[worlds]]. Two implementations that expose similar method names but differ on those properties are not compatible Worlds.

Rust is a suitable shared layer because it can produce a standalone CLI, an embeddable library, Node-API modules, and Python extension modules from one implementation. The working model treats Rust as an implementation layer rather than requiring a new user-visible backend identity; public package names remain open.

## Goals

The project succeeds when a language SDK can consume one canonical self-hosted World implementation without reimplementing its durable behavior.

- Provide a zero-Node.js path for Python development using a portable SQLite World.
- Share event transitions, storage semantics, queue behavior, streams, migrations, configuration validation, and stable error codes across languages.
- Produce a standalone `workflow` executable while keeping the `workflow` and `wf` npm bins, including `npx workflow`, operationally compatible.
- Support language-native installation and execution, such as a Python wheel plus an `uvx` or `pipx` entry point, without requiring a Rust toolchain on user machines.
- Preserve the existing public World shape in JavaScript and expose an idiomatic equivalent in Python.
- Keep existing runs and PostgreSQL deployments safe during rolling upgrades and rollback.
- Reach the Python plus SQLite goal through a Node.js-first vertical slice, so the Rust World is proven against this repository's existing tests before cross-repository integration.

## Non-Goals

The initial program deliberately leaves the workflow execution engine and managed backend outside the Rust migration.

- Rewriting deterministic replay, workflow primitives, language compilers, or step execution in Rust is not required.
- Replacing `@workflow/world-vercel` is not required; the native CLI may eventually speak its remote APIs directly.
- Defining a stable C ABI for third-party embedders is not required. The Rust crates and first-party bindings release together.
- Making SQLite a multi-host production database is not a goal. It is a same-machine embedded World.
- Preserving the current local JSON/filesystem layout as the new storage format is not a goal.
- Giving the native CLI built-in knowledge of every language compiler or every community World is not a goal.
- Creating every anticipated crate before its first consumer exists is not a goal.

## Architectural Principles

The migration is governed by a small set of rules that keep language portability from weakening durability.

1. Rust owns durable semantics; bindings own type and runtime adaptation only.
2. User payloads remain opaque bytes to a World, preserving the encryption boundary in [[worlds#Encryption Responsibility]].
3. The persisted run spec, persisted codec, package/build identity, and database schema version are separate version axes.
4. SQLite and PostgreSQL share a state machine and conformance suite, not necessarily query text or the lowest common SQL abstraction.
5. A native implementation ships beside the TypeScript implementation before it replaces any default.
6. No language callback runs while a database transaction, SQLite writer lock, or internal queue lease mutation is held.
7. Optional capabilities fail closed exactly as described in [[worlds#Capability Negotiation]].
8. Correctness and crash recovery precede throughput optimization.

## Proposed System Shape

The system separates language-owned execution from a shared native persistence plane and gives the CLI explicit escape hatches for language-specific operations.

```mermaid
flowchart TB
  subgraph Hosts[Language hosts]
    TS[TypeScript SDK and replay runtime]
    PY[Python SDK and replay runtime]
  end

  TS --> NAPI[Node-API adapter]
  PY --> PYO3[PyO3 adapter]
  NAPI --> FACADE[Rust World facade]
  PYO3 --> FACADE

  CLI[Native workflow CLI] --> FACADE
  CLI --> DRIVER[Versioned language driver]
  DRIVER --> TS
  DRIVER --> PY

  FACADE --> SQLITE[SQLite World]
  FACADE --> POSTGRES[PostgreSQL World]
  SQLITE --> LOCALHTTP[Local flow endpoint]
  POSTGRES --> HOSTHTTP[Hosted flow endpoint]
  LOCALHTTP --> TS
  LOCALHTTP --> PY
  HOSTHTTP --> TS
  HOSTHTTP --> PY
```

The HTTP arrows represent queue delivery to the generated flow endpoint described in [[architecture#Request and Queue Boundary]]. Loopback HTTP is the initial SQLite transport as well as the semantic baseline. A direct in-process path is not part of the initial contract and may be reconsidered only if benchmarks justify its additional binding and lifecycle surface.

### Ownership Boundaries

Each layer has one primary reason to change, and dependencies point from language adapters toward the durable implementation rather than the reverse.

| Layer | Owns | Does not own |
| --- | --- | --- |
| Language SDK | Replay, workflow/step APIs, compiler or discovery, user-value serialization, framework routes | Database schema, event transition SQL, queue leases |
| Language binding | Host-value-to-`ContextValue` conversion, async integration, stream adaptation, native error mapping | Durable validation, retries, migrations, materialization |
| Rust protocol | IDs, event/entity envelopes, queue payloads, pagination, capability and error vocabulary | A language's custom classes or VM |
| Rust World core | Pure, persisted-spec-aware transition planning, shared validation, lifecycle rules, and backend traits | Locks, uniqueness claims, collision retries, or backend-specific transaction syntax |
| Backend crate | Locked reads, linearization, uniqueness, collision retries, connections, transactions, schema, queue, streams, migrations, and notifications | Language-specific objects |
| Native CLI | Command grammar, config discovery, output contract, built-in backend operations, driver dispatch | Language-specific transforms and builds |
| Language driver | Build, transform, validate, and other SDK-specific commands | Global CLI installation or durable World behavior |

The shared state machine is a pure function from a locked snapshot, persisted spec, and requested operation to a mutation plan or stable error. A backend obtains that snapshot, invokes the planner, enforces uniqueness, applies the plan, and commits within one transaction. Calling the planner before the transaction and applying its answer later would create a TOCTOU gap and is not a valid implementation.

This boundary keeps payload serialization and payload encryption/decryption above the World. The optional World key-resolution method remains part of the backend surface and may return or derive key bytes, but the SDK owns their use on application payloads. A Rust CLI that needs to hydrate values either supports a documented portable subset or delegates hydration to the matching language driver; it must not silently guess at language-specific values.

### World Surface Ownership

The existing JavaScript `World` surface crosses several layers, so compatibility requires an explicit owner for each method group rather than treating the whole interface as a database trait.

| World surface | Durable owner | Host adaptation or first-slice rule |
| --- | --- | --- |
| `runs`, `steps`, `events`, and `hooks` storage | Rust backend, with transition plans from Rust core | Binding maps values and errors; optional read methods remain fail-closed |
| Stream read/write/info/close | Rust backend | Binding adapts native cursors to Web streams or Python async iteration |
| `getDeploymentId()` and `queue()` | Rust backend and configuration | Required in every binding; SQLite returns a stable compatible-worker-group target and persists the requested target without deriving it from a package, process, port, or path |
| `createQueueHandler()` | Rust delivery engine plus host adapter | Rust owns attempts, leases, and envelopes; the Node wrapper owns `Request`/`Response`, and Python exposes an idiomatic equivalent |
| `specVersion` and `capabilities` | Rust protocol/backend | Binding reports them without inferring support from method presence or environment variables |
| World `start()` and `close()` lifecycle | Rust engine | Binding delegates explicitly; construction remains side-effect free |
| `getRuntimeDeadline()` | Language/framework host | Passed into Rust only when an operation needs the deadline |
| Deployment availability, latest-deployment resolution, environment, run-ID creation, and run description | Backend-specific extension | Implement only where meaningful; pure metadata methods stay side-effect free |
| `getEncryptionKeyForRun()` | Backend-specific key resolution | Binding returns opaque key bytes; language SDK performs payload encryption/decryption |
| Analytics | Optional backend read surface | Omitted initially; CLI falls back to canonical storage reads |
| Local `clear()` and active-run recovery controls | SQLite profile plus host adapter | Operate only on the selected database and remain compatibility gates before replacing `@workflow/world-local` |
| Local `tag` selection and cross-database test visibility | Host test and tooling integration | `@workflow/vitest` selects one database per pool; observability aggregates explicitly without adding tag scope to the Rust schema |
| Local `registerHandler()` extension | Host test integration | Not implemented as a native callback; `@workflow/vitest` uses a private ephemeral loopback server before the native profile replaces `@workflow/world-local` |

### Library Instead of Required Daemon

The primary integration is an in-process library because local development should not require supervising another service, reserving a port, or negotiating an IPC protocol.

A daemon or sidecar can be added later for languages without a native binding, process isolation, or centralized local workers. It would be another adapter over the same Rust World crates, not the canonical implementation or a prerequisite for Node.js and Python.

## Rust Workspace

The Cargo workspace should express durable boundaries without starting as a collection of empty abstraction crates.

The target dependency graph is:

```text
workflow-protocol
        |
workflow-world-core ----- workflow-world-testkit (dev only)
     |                   |
workflow-world-sqlite   workflow-world-postgres
     \         /
 workflow-world (facade and configuration)
      /             |             \
 Node binding  Python binding  workflow-cli
```

The provisional responsibilities are:

| Crate | Responsibility |
| --- | --- |
| `workflow-protocol` | Language-neutral models, IDs, persisted spec constants, queue envelopes, error codes, and fixture codecs; no I/O |
| `workflow-world-core` | World traits and a pure, persisted-spec-aware transition planner that produces mutation plans or stable errors; no I/O or uniqueness ownership |
| `workflow-world-testkit` | Dev-only operation traces, contract assertions, concurrency schedules, and fault-injection support shared by backend tests |
| `workflow-world-sqlite` | SQLite schema, migrations, transactions, persistent queue, streams, polling, and local configuration |
| `workflow-world-postgres` | PostgreSQL schema compatibility, migrations, transactions, queue implementation, streams, and notifications |
| `workflow-world` | Public Rust facade, backend selection, lifecycle composition, and stable configuration validation |
| `workflow-cli` | Standalone binary, command/output compatibility, built-in backend clients, and language-driver discovery |

Node.js and Python bindings build `cdylib` artifacts, but they are distribution adapters rather than public Rust abstraction layers. A binding stored here joins this Cargo workspace; one stored with an external SDK consumes a pinned native source revision and declares compatibility through the release manifest. The first slice adds only protocol, core, testkit, SQLite, a napi-rs binding deliverable, and a narrow maintenance CLI; the other crates appear when they have executable consumers.

Backend dependencies should be feature-gated so an SQLite-only native package does not inherit PostgreSQL, TLS, or remote-client dependencies. The facade must not turn feature selection into runtime ambiguity: requesting an omitted backend returns a stable unsupported-backend error.

The facade selects an explicit `Sqlite` or `Postgres` backend configuration; it does not infer a database engine from a URL string. Existing JavaScript packages can preselect one backend while Python exposes idiomatic constructors over the same engine.

Opening also requires an explicit role: `Runtime` may read and write but starts workers only when lifecycle `start()` is called, `InspectReadOnly` never creates files, migrates, or claims work, and `MaintenanceExclusive` is reserved for explicit migration, import, or clear operations. Exact type names are provisional, but these permissions are part of the contract.

Two later extraction points are deliberate. A `workflow-client` crate can own `start`, cancel, health, and endpoint negotiation only after those behaviors have a language-neutral protocol. A `workflow-codec` crate can own portable payload hydration only after its supported value set is specified; neither belongs in the World crates or should be created as an empty placeholder.

The graph is logical rather than a final directory decision. Reusable native crates can live under `crates/`, while binding crates may be colocated with the packages that own their loaders and metadata. One Cargo workspace and lockfile is preferable for native code in this repository; it does not imply that separately maintained language SDK repositories move into this monorepo.

The Python SDK currently lives outside this repository. Phase 0 still prototypes PyO3 async, byte, stream, and error boundaries and records viable packaging shapes, but final repository ownership, publishing, version pinning, cross-repository gates, rollback, and `uvx` driver discovery block Phase 3 rather than the Node.js walking skeleton.

The existing Cargo workspace currently targets Rust 1.87 and uses a size-oriented release profile for the SWC/Wasm build. Phase 0 must choose a binding-toolchain version and native release profiles deliberately: [current napi-rs scaffolding](https://napi.rs/docs/introduction/getting-started) documents a newer Rust build requirement, and native database code should not accidentally inherit a Wasm-only optimization policy.

## Language-Neutral World Contract

The TypeScript `@workflow/world` interface is the current executable definition of the World contract, but its `Date`, `Uint8Array`, `ReadableStream`, overloads, and callback types are not themselves a cross-language specification.

The migration must extract a language-neutral contract without creating a second source of truth. Initially, the TypeScript schemas, [[domain-model]], [[worlds]], and shared conformance fixtures remain authoritative; Rust types are tested against them. A later code-generation decision may move the structural schema into an IDL, but behavioral rules still require executable tests.

### Contract Layers

Six related compatibility boundaries evolve independently and must be named explicitly in errors, manifests, and release notes.

| Contract | Scope | Compatibility rule |
| --- | --- | --- |
| Persisted run spec | Event and queue meaning, state transitions, replay semantics | Stored per run; readers support a range as in [[data-and-compatibility#Protocol Versions]] |
| Persisted codec | Physical encoding of structured event/entity metadata and legacy fallback | Selected by persisted spec or schema state; compatibility is proven with fixed vectors, including existing `cbor-x` data |
| Database schema | Tables, columns, indices, migration state | Backend-specific monotonic migrations with rollback policy |
| Binding release identity | Host wrapper, Node-API/PyO3 module, and platform artifact provenance | Wrapper and native artifact are one atomic release unit; exact package/build identity is enforced by packaging and exposed for diagnostics, not evolved as a separate protocol |
| CLI driver protocol | Commands, progress, results, cancellation, and diagnostics exchanged over the driver transport | Independently versioned capability handshake; kernel and driver may come from different packages or repositories |
| Package/CLI version | User-facing features and command behavior | SemVer plus channel policy; never used to infer a run's persisted semantics |

An implementation must never stamp a newer run spec merely because a database migration or native package version increased.

### Canonical Representations

Rust models should remove host-language accidents while round-tripping all stored information.

- Identifiers are validated UTF-8 strings with typed newtypes and unchanged external spelling.
- Timestamps use one documented UTC integer unit internally and convert to JavaScript `Date` or timezone-aware Python `datetime` at the binding edge.
- Serialized application data is an opaque byte buffer plus its existing self-describing prefix; legacy structured JSON remains a versioned compatibility variant.
- Extensible context uses `ContextValue`: null, booleans, JavaScript-safe integers, finite floats, UTF-8 strings, bytes, arrays, and string-keyed objects.
- Event variants are a tagged union. Unknown required variants fail with a newer-protocol error rather than being dropped.
- Pagination cursors are opaque outside the backend that minted them.
- Optional World methods become explicit capabilities internally; a binding exposes or omits the public method according to the language SDK's existing convention.
- Analytics remains an optional read capability. A backend that omits it uses canonical storage reads; it must not advertise synthetic analytics merely to simplify CLI dispatch.

Ordinary FFI requests and results use direct binding conversion rather than a JSON or CBOR envelope. Opaque application payloads cross as byte buffers, typed fields map to binding structs, and each adapter converts extensible context into an owned `ContextValue` before Rust work leaves the JavaScript thread or Python GIL. Context traversal rejects cycles and unsupported values; shared-reference identity is not portable data, so aliases become equal subtrees. Streams and cancellation use specialized native handles or async adapters whose exact shapes still require prototypes; they do not introduce a general envelope.

The direct FFI representation is not the database codec and must never be confused with existing `cbor-x`-encoded PostgreSQL columns. Likewise, the CLI driver protocol is a process boundary with different evolution and trust properties from an in-process native addon.

Bindings expose a concrete engine with stable data-transfer operations, not a Rust trait object or backend driver's raw SQL API. This keeps Rust dispatch, language ABI, and public SDK interfaces independently evolvable.

### Persisted Codec

New SQLite context values have one schema-selected CBOR profile, while legacy readers preserve installed JSON/text and `cbor-x` values through explicit compatibility variants.

`workflow-cbor-v1` encodes `ContextValue` as standard CBOR. Object keys are emitted in sorted order for reproducible bytes; byte values use tag 64 around a byte string so current `cbor-x` readers recover a `Uint8Array`. Integers are limited to JavaScript's safe range and floats must be finite. `undefined`, dates, tuples, sets, maps with non-string keys, custom classes, and reference identity are not part of the profile.

Protocol payloads such as workflow input, output, errors, Hook payloads, and stream chunks remain opaque bytes in BLOB columns and do not pass through `ContextValue`. Execution context uses `_cbor` BLOB columns; strongly typed attributes remain JSON text. The schema selects the codec, so individual context values need no magic prefix. Future Hook metadata or resume context may reuse this profile only after their protocol types adopt `ContextValue`.

Compatibility reads use separate entry points. Legacy PostgreSQL JSONB and JSON-stringified text retain ordinary JSON semantics, while the world-local `{"__type":"Uint8Array","data":"..."}` shape recovers bytes exactly as its existing reviver does. Existing PostgreSQL CBOR accepts the standard forms emitted by the pinned `cbor-x` helper: string-keyed maps, arrays, primitives, `undefined`, tag-1 dates, raw byte strings, and tag-64 `Uint8Array`. Unknown tags, duplicate or non-string map keys, excessive nesting, malformed values, and trailing bytes fail as persisted-data errors instead of being guessed.

The shared fixture stores both the source value and exact encoded bytes or text. TypeScript decodes the new Rust-writer vector with installed `cbor-x`; Rust checks exact writer bytes and independently decodes it. Legacy vectors retain their existing TypeScript encoders and Rust compatibility readers. These vectors define value compatibility, not byte-for-byte preservation when a legacy value is later rewritten into a new schema.

### Behavioral Invariants

The Rust trait is incomplete unless it captures behavior that TypeScript method signatures cannot express.

- Events are the mutation API; runs, steps, Hooks, and waits are atomically updated materialized views.
- Event IDs encode a dense, one-based slot within one run, and a failed transaction cannot burn a slot.
- A stale `eventCount` bumps the write above concurrent events and returns a complete skipped-event report; a truncated report cannot advance the caller's observed head.
- Resilient `run_started` may create a missing run and its synthetic `run_created` event atomically.
- Lazy `step_started` may create a missing step and synthetic `step_created` event atomically; only the winning request reports ownership to execute the step body inline.
- Hook receipt/disposal, terminal run transitions, token ownership, wait completion, and resume-id deduplication linearize through storage rather than process-local locks.
- The backend computes and applies each shared transition plan against the same locked snapshot; a plan cannot be cached across a conflicting commit.
- A queue message ID stays stable across redeliveries, delayed work is durable, handler-requested timeouts reschedule rather than acknowledge, and byte payloads remain lossless.
- Stream notifications and database notifications are hints; readers recheck persistent state and release resources when cancelled.
- The exact allowed transition matrix comes from executable fixtures. Rust must not invent a blanket terminal-run rule that rejects transitions the current contract intentionally accepts.

Batch event creation is optional. The first Rust implementation should omit the capability unless one attempt can atomically commit all surviving results in request order and consecutive slots; a loop around single-event creation is not a valid batch implementation.

### Stable Errors

Rust is the authority for backend and transition errors, while each binding raises its language-native exception type.

Every error crossing a binding includes a stable code, safe message, retry classification, and optional structured details. Database-driver strings and credentials never become the compatibility surface. Existing JavaScript error classes and HTTP status behavior map from these codes, and Python receives an equivalent exception hierarchy.

### Evolution Workflow

A World contract change lands in an order that keeps TypeScript, Rust, and future languages synchronized.

1. Specify behavior and backward compatibility in `lat.md` and the public World-building documentation.
2. Add or update language-neutral fixtures and conformance scenarios.
3. Teach old readers to accept the new representation where rolling compatibility requires it.
4. Implement every first-party World and binding that will advertise the capability.
5. Raise the readable ceiling before changing what new runs mint.
6. Enable minting only after cross-version and rollback tests pass.

This is the multi-language form of [[data-and-compatibility#Compatibility Strategy]].

## Native Binding Contract

Bindings should feel native to their host language while remaining intentionally boring: they translate values, futures, streams, and errors around a Rust-owned World instance.

### Node.js Binding

The Node.js adapter uses Node-API through napi-rs so the JavaScript World remains a normal object satisfying the existing `World` interface.

The adapter returns Promises, maps byte buffers without retaining unsafe borrowed memory, turns Rust stream cursors into Web `ReadableStream` instances, and maps structured native errors to the existing JavaScript classes. Per-World connections, tasks, and caches remain instance-owned, preserving [[worlds#World Lifecycle and Module Identity]].

The native module is host-only. Package exports and framework externalization must keep `.node` artifacts out of workflow VM, edge, and client bundles while still allowing build-time access to the small handler/spec surface used by generated routes.

The likely long-term package shape is a thin `@workflow/world-local` or `@workflow/world-postgres` JavaScript facade over platform-specific native packages. An experimental package may precede that switch, but public backend names should describe SQLite/local or PostgreSQL semantics rather than the implementation language.

### Python Binding

The Python adapter uses PyO3 and produces awaitable, typed APIs that fit the Python SDK rather than exposing JavaScript-shaped method overloads.

I/O must release the GIL, cancellation must propagate into Rust tasks where safe, and streams should surface as async iterators or the SDK's stream abstraction. Cleanup is explicit through `close()` and an async context manager; object finalizers are a last-resort safety net, not the lifecycle protocol.

Maturin-built wheels are the provisional distribution mechanism. Python's stable ABI may reduce the wheel matrix, but it becomes a promise only after the chosen PyO3, async runtime, and target set pass import and end-to-end tests.

### Shared Binding Rules

Both bindings obey the same lifetime and concurrency rules even though their host runtimes differ.

- A World instance owns its pool, worker cancellation token, subscriptions, and shutdown state.
- Construction is side-effect free: connections, files, migrations, and worker threads initialize lazily or in `start()`, because framework builds may instantiate a World only to obtain handler metadata.
- `start()` is idempotent; `close()` stops claims, drains or releases in-flight work according to queue policy, closes resources, and makes later operations fail deterministically.
- Rust never invokes a host callback while holding a transaction or internal mutex needed by another World operation.
- Backpressure crosses the binding rather than accumulating unbounded chunks or queue deliveries.
- Panics are caught at the FFI boundary and reported as internal errors; they never unwind into the host runtime.
- Packaging keeps each wrapper and native artifact at one exact build identity; diagnostic metadata reports that identity, enabled features, SQLite version, and supported persisted-spec range without creating a separately versioned adapter protocol.
- Context graphs are converted while still attached to the host runtime: cycles fail, while repeated references are traversed again and become separate `ContextValue` subtrees.

## SQLite Local World

The first backend is a new SQLite database rather than a compatibility layer over the current filesystem World.

SQLite supplies a documented cross-platform file format, transactions, uniqueness constraints, and same-host multi-process locking. This removes the need for every language to reproduce atomic rename, exclusive-link, lock-file recovery, and index-repair behavior.

### Storage Shape

SQLite databases replace per-entity files as the durable unit. Each operational World uses one database, and the implementation never shards an application's data into one database per run.

SQLite manages the journal and shared-memory sidecars when WAL mode is active.

The conceptual schema contains:

- schema metadata and migration history;
- runs and their persisted protocol and storage metadata;
- an append-only event table keyed by `(run_id, position)` with unique event IDs;
- materialized steps, Hooks, and waits;
- Hook-token and resume-id uniqueness state;
- stream metadata and ordered stream chunks;
- durable queue messages, availability times, attempts, leases, and idempotency state.

This list records responsibilities, not final table or column names. SQL names become compatibility surface only after the first migration is released.

The chosen layout must preserve transactional cross-run queries, Hook-token rules, migrations, and queue recovery for the data visible to one World instance. Per-run databases would recreate cross-shard consistency problems without giving a local single-writer SQLite workload useful isolation.

Application payload fields use SQLite `BLOB` values without hydration. Filterable routing and lifecycle fields remain typed columns. Extensible execution context remains encoded data so adding a context key does not require a schema migration.

### Vitest Database Selection

The SQLite profile preserves Vitest isolation and observability without carrying the filesystem World's `tag` overlay into the canonical schema.

The filesystem implementation's `tag` is not a consistent tenant boundary: point reads prefer the selected tag and fall back to untagged files, writes use only the selected tag, lists expose all tags, recovery and `clear()` select one tag, and some uniqueness sidecars are global. Freezing that asymmetry would require scope in nearly every SQLite key, fallback queries, cross-layer event rules, and ambiguous duplicate run IDs.

The Rust SQLite World therefore has no tag or overlay column. The host maps each `@workflow/vitest` pool to its own SQLite database, and all point reads, writes, recovery, queue claims, and `clear()` operations stay within that database. A test that intentionally shares state must select the same database or import an explicit fixture; a test database never falls back to development data.

CLI and local observability tooling explicitly aggregate `workflow.sqlite` and schema-validated `vitest-<pool>.sqlite` files in the selected database directory and identify each result's source. Web requests rediscover this set and release their read-only database handles after each operation or stream. This preserves the reason tagged files were introduced without making cross-database listing a World storage operation.

The existing filesystem World retains its current behavior during coexistence. Replacing it treats removal of overlay fallback as an intentional compatibility change and requires tests for per-pool isolation, scoped clearing and recovery, and visibility through the aggregation layer.

### Database Directory

SQLite uses an independently named database directory so a legacy filesystem World cannot recursively clear native data.

The host option is `databaseDir`, the environment variable is `WORKFLOW_LOCAL_DATABASE_DIR`, and the zero-configuration default is `.workflow-database` relative to the effective workflow project directory. Hosts resolve it once to an absolute path and canonicalize its existing parent before Rust uses the resulting file paths or process registries.

The normal World opens `<databaseDir>/workflow.sqlite`. `@workflow/vitest` defaults to the same directory under its resolved `rootDir` and maps each safe pool identifier to `<databaseDir>/vitest-<pool>.sqlite`; its explicit test option is likewise named `databaseDir`. SQLite's `-wal` and `-shm` files remain beside their owning database.

Programmatic `databaseDir` overrides `WORKFLOW_LOCAL_DATABASE_DIR`, which overrides the `.workflow-database` default. The Rust layer receives a resolved database file and does not reinterpret a host working directory. JavaScript, Python, and CLI adapters must therefore resolve the same project-relative directory before cross-language access.

The filesystem option `dataDir` and `WORKFLOW_LOCAL_DATA_DIR` continue to configure only the legacy JSON World. They do not derive, override, or alias the SQLite directory. This explicit separation avoids the old untagged `clear()`, including in already published packages, deleting a database placed anywhere under its managed directory. Selecting the SQLite profile with only the legacy variable set uses `.workflow-database` and reports that the legacy setting was not consumed.

CLI discovery recognizes `.workflow-database` independently from legacy data directories, validates a database's application/schema metadata before opening it, and never chooses an engine merely because one format exists. If both formats are present, the selected World profile determines which is operational; diagnostics may report both, but there is no implicit import or fallback.

The implementation adds `.workflow-database` and its database sidecars to repository ignores and builder input exclusions. `clear()` deletes rows only from its selected database, and a Vitest pool clears only its own file's contents; neither operation recursively deletes the database directory or another profile's data.

### Event Transactions

Each accepted event and its materialized entity update commit in one short write transaction.

For an ordinary append, the backend begins a write transaction, reloads and locks the relevant run and entity state, invokes the pure transition planner for that persisted spec, acquires any uniqueness claim, allocates the next event position, applies the mutation plan, and commits. Allocation in the same transaction keeps the log dense by construction and does not require preallocated holes or `noop` sealing.

Whether the transaction derives the next slot from an indexed maximum or a run-row head is an implementation decision. Either way, allocation and insertion occur in the same transaction; an external sequence, `AUTOINCREMENT`, or pre-commit reservation is invalid unless the backend also implements spec-7 hole sealing.

The returned result still honors [[worlds#Append and Slot Contract]]: if the caller's `eventCount` was stale, the event lands at the next committed slot and the response reports intervening events. A supported batch append validates items independently where the contract permits mixed results, then commits all accepted items in request order and consecutive slots as one atomic attempt; it never exposes a partially committed survivor set.

SQLite has one writer at a time even in WAL mode, so transactions must contain no network calls, language callbacks, sleeps, or payload hydration. Busy handling is bounded, observable, and mapped to a retryable World error after its budget expires.

### Queue

The SQLite profile should use a persistent database queue rather than rebuilding the current in-memory queue in every language.

Enqueue stores the message before returning. Workers atomically claim ready rows with a renewable lease, preserve one stable message ID across redeliveries, increment attempts according to the public queue contract, and acknowledge only after the flow handler succeeds. Process death leaves an expiring lease that another worker can reclaim.

The SQLite file is one application's World and queue boundary. Pointing unrelated applications at it is a configuration error, not supported multi-tenancy; inventing an application field only for queue rows would not isolate the run and event tables and would provide false safety. A database instance identifier may aid diagnostics, but it is not a routing or authorization credential. Vitest pool isolation selects another database rather than adding a queue scope.

Claims use the existing persisted `deploymentId` as a logical compatible-worker-group target, not as an immutable local build identifier. JavaScript defaults to `local-js` and Python to `local-python`; these values remain stable across SDK/native upgrades, process restarts, port changes, and directory moves. The binding permits an explicit target so replicas can share work and a deliberately compatible cross-language implementation can opt into the same group. The SQLite profile does not advertise deployment affinity: local code may evolve while retaining responsibility for its durable runs.

Each live worker claims only rows whose target matches its configured deployment ID and whose concrete queue name appears in the handler set supplied by its host manifest. Queue namespaces are already part of that name. Matching the target but claiming an arbitrary workflow prefix is insufficient because a partial or different host may not contain that workflow. Workers matching both fields are replicas and may compete; an explicitly targeted message remains durable while no matching worker is online.

The durable claim scope is therefore the selected SQLite database, deployment ID, and concrete queue name. The current prototype's opaque `scope` string proves isolated claim and reconciliation behavior but is not a public concatenation contract or persisted application/tag field. Active-run reconciliation scans only runs in that database for the worker's target and recreates wakes under the same target. The row stores no live endpoint, avoiding a stale development port after restart.

Delayed delivery, handler-requested `timeoutSeconds`, retry backoff, idempotency windows, queue namespaces, concurrency limits, and graceful shutdown all live in Rust. The initial transport is exclusively loopback HTTP to the language host's generated flow route because it keeps the Rust queue independent of Node.js and Python callback ABIs and exercises the same Request/Response contract used by hosted delivery.

The language host resolves and registers its complete loopback flow URL before activating the Phase 1 worker, which then claims only the supplied target and concrete queue names. Rust neither scans listening ports nor probes health endpoints for discovery. Programmatic configuration and `WORKFLOW_LOCAL_BASE_URL` take precedence over a framework-provided address or explicit `PORT`; if none yields one unambiguous URL, consumer `start()` fails before claiming anything. This deliberately does not inherit the TypeScript local World's fallback from a failed health probe to the process's first listening socket.

The endpoint registration and supervisor are process state shared across bundler-created World copies through a `globalThis` registry keyed by resolved database identity and deployment target. Repeating the same registration is idempotent, while conflicting URLs fail instead of silently replacing a live worker. The complete URL must use HTTP and resolve only to loopback; a wildcard listen address is converted by the host to a connectable loopback address. Construction, migration, and inspection do not register or launch a consumer. The endpoint never enters a queue row, so restart on a new port and database copying cannot retain a stale destination.

Claim scope is routing rather than authentication. The initial SQLite handler matches existing `@workflow/world-local` and `@workflow/world-postgres`: it validates the queue metadata and payload shape but does not require a delivery credential or prove that the HTTP body corresponds to a claimed row. This is an explicit Phase 0 scope limit, not a claim that the public flow route is authenticated.

The recommended later hardening is a per-claim capability rather than a long-lived application or process secret. A handler would use the current random lease token to verify, before decoding or executing, that the lease is live and that its message ID, target, queue name, attempt, and raw body match the SQLite row; acknowledgement or rescheduling would invalidate it, and redelivery would rotate it. That change should be reviewed as a separate security feature, including how equivalent protection applies to other self-hosted Worlds, rather than becoming an unannounced SQLite-only requirement in the first slice.

The probe adapter's explicit worker start and draining close model the eventual World lifecycle: close stops claims and joins the supervisor off the host event loop. This is evidence for the encapsulation boundary; the prototype's one thread, concurrency of one, minimal HTTP parser, and short shutdown timeout are not compatibility commitments.

A durable queue does not remove the boundary between event creation and publication exposed by the current `World` interface. Queue success with event failure continues to rely on the resilient payload rebuilding missing state; event success with queue failure requires active-run reconciliation. Recovery must use a durable, deterministic idempotency identity and account for ready, delayed, and leased rows so repeated startup scans converge instead of creating a delivery storm.

A future SQLite-specific combined operation may insert an event and message in one transaction, but mixed-version callers and other replay wake paths still require reconciliation. Phase 0 must define which component performs the scan, the identity of a missing wake, and how it coexists with the current `reenqueueActiveRuns` behavior.

A direct Node-API or PyO3 callback is not part of the initial SQLite profile. Crossing from a Rust worker thread into a JavaScript Promise or Python coroutine would add per-language scheduling, backpressure, cancellation, reentrancy, and shutdown contracts while bypassing the generated route exercised in deployment. `@workflow/vitest`, the current non-test consumer of local `registerHandler()`, should instead host its combined handler on a private ephemeral loopback server before the native profile replaces `@workflow/world-local`. Direct delivery may be reconsidered later only with a benchmark that demonstrates material cost; it cannot become an automatic per-message fallback or create a second queue semantics.

### Streams and Long Polls

SQLite persists stream order and completion in tables; process-local notifications only reduce latency and never carry truth.

Readers combine a cursor query with bounded polling so another process's writes are observed even when no in-process signal fires. The same pattern supports `waitForTerminalStatus`: notification is a wake hint, and every wake rechecks durable state. Long reads must end their SQLite read transaction before waiting so they do not starve checkpoints.

### SQLite Configuration

The supported profile is a local file on one host, with configuration chosen for predictable recovery rather than surprising benchmark wins.

- Enable foreign keys, activate WAL, and read required settings back on every connection instead of relying on bundled-library compile defaults.
- Reject or clearly downgrade unsupported VFS behavior instead of assuming WAL was enabled.
- Do not claim support for network filesystems; SQLite's WAL design requires same-host shared memory.
- Bundle or otherwise pin a SQLite build containing the fixes required by the multi-process WAL workload instead of trusting an arbitrary system library.
- Restrict new database and sidecar permissions according to the containing directory and never log secrets or payload bytes.

The local default is `synchronous=NORMAL`. It preserves atomicity and consistency and recovers committed transactions after an application-process crash, but a machine crash or power loss may roll back recent acknowledged commits. This matches the existing filesystem World's lack of an fsync guarantee without selecting `OFF`, which could allow database corruption. A future profile intended for production-grade single-host storage should use explicit `FULL`; Phase 0 adds no public durability switch.

Each process shares one runtime engine per resolved database identity, so constructing or bundling another World wrapper does not multiply its connection budget. The engine serializes writes through one connection and permits at most three concurrent short read connections. Read transactions end before polling or host work, and queue delivery never occupies a database connection while making HTTP requests.

Connection acquisition, waiting for the local writer lane, and SQLite lock contention share one five-second operation budget. Writes begin with `BEGIN IMMEDIATE` so cross-process contention is acquired before mutation; exhaustion returns a retryable storage-busy error with its wait stage and elapsed time rather than waiting forever. A maintenance command may expose a separately explicit budget later, but runtime callers do not silently reset the five-second budget on each retry.

The writer explicitly enables a 1000-page WAL auto-checkpoint, whose mode is `PASSIVE`. Routine World shutdown closes its connections but does not request `FULL`, `RESTART`, or `TRUNCATE`, because another language process may still be reading or writing the same database. Long-lived reader detection and checkpoint progress are observable; an aggressive truncate checkpoint belongs to explicit offline maintenance if it is later needed.

SQLite's [WAL documentation](https://www.sqlite.org/wal.html) is the reference for these guarantees, same-host concurrency, checkpointing, sidecar handling, and VFS limits. The backend uses `rusqlite` with a Cargo-locked bundled SQLite build, and synchronous calls run on bounded blocking executors rather than introducing an async runtime into the shared embedded layer.

At the time of this proposal, SQLite identifies 3.51.3 and the 3.44.6/3.50.7 backports as containing its multi-connection WAL-reset fix. Release automation should assert a fixed build rather than preserve these particular version numbers as a permanent architectural constant.

### Migrations and Legacy Local Data

Rust owns SQLite migrations, and every binding and the CLI invoke the same migration engine.

Migrations are monotonic, checksummed, transactional where SQLite permits, and protected from concurrent application by a database-level migration lock or equivalent exclusive transaction. Runtime open may apply only migrations explicitly classified as safe and fast; potentially long rewrites require `MaintenanceExclusive` mode and an explicit CLI operation. `InspectReadOnly` validates that it can read the schema but never creates a database or advances it.

The filesystem World and SQLite World use different formats. There is no silent in-place conversion or destructive cleanup. If preserving local runs is valuable, an explicit import command reads the old format, writes a new database, validates counts and event prefixes, and leaves the source untouched. The default-switch plan must decide whether such an importer is release-blocking.

### Prior Art

Existing SQL Worlds are evidence and test inputs, not specifications to copy without checking current contract behavior.

The community [Turso/libSQL World](https://github.com/mizzle-dev/workflow-worlds/blob/d48f8d019fe08ee9c675019160ec0e008eb83cd6/packages/turso/README.md) demonstrates an embedded/remote SQLite-shaped schema, a persistent polling queue, WAL/busy handling, and migration tooling. The reviewed implementation predates dense event slots, separates some event/entity writes, lacks a complete crash-recoverable queue lease, and relies on process-local stream notification, so it is useful prior art rather than a conformance baseline.

The community [Cloudflare World](https://github.com/vinnymac/worlds/blob/8bc96b94503b466bbd4d406a809df15a78e61500/packages/world-cloudflare/README.md) demonstrates per-run transactional state through Durable Objects. Its implementation uses Durable Object key/value APIs rather than a reusable SQL schema, still predates dense slots, and depends on Cloudflare Queues and Workers KV, so its atomic state-transition pattern is more relevant than its storage topology.

Both reviewed community implementations generate ULID event IDs and target older `@workflow/world` contracts. Current dense, one-based per-run slots and spec-7 reading behavior must come from the first-party contract, not from either schema.

The first-party PostgreSQL World remains the closest relational reference for transition and materialization semantics. Conformance comes from shared behavior and fixtures, not from making SQLite imitate PostgreSQL query plans.

## PostgreSQL World

The PostgreSQL rewrite follows the SQLite vertical slice and reuses the protocol and state machine while retaining PostgreSQL-specific concurrency and notification mechanisms.

The storage direction is compatibility-first: a Rust implementation should read existing supported runs and prefer in-place, backward-compatible schema evolution. A default switch requires a tested rolling window in which TypeScript and Rust processes can access the same database without corrupting state, plus a documented rollback point.

### Storage Compatibility

The existing schema and migrations are an installed user asset, so a rewrite may not treat them as internal code that can simply be replaced.

The Rust backend must inventory every table, enum, index, payload encoding, cursor, constraint, and transaction behavior. It can issue different SQL from Drizzle while producing the same committed history and materialized views. If a new schema generation is ultimately justified, it needs an explicit online migration or export/import plan rather than an implicit package upgrade.

Initially, the checked-in PostgreSQL migration SQL should remain the single schema authority and be embedded or invoked with checksum verification by Rust. Maintaining an equivalent Rust migration history beside Drizzle would create two authorities before mixed-version writes are proven.

Existing legacy runs may use a different event-ID scheme and legacy JSON/text columns alongside CBOR columns. Rust must choose behavior from persisted per-run state, preserve that scheme for the run's lifetime, and round-trip the current `cbor-x` representations of dates, missing values, byte arrays, and extensible objects before it can share the installed schema.

### Queue Decision

The PostgreSQL queue is the largest open design item because the current implementation embeds Graphile Worker, whose runtime is JavaScript-specific.

The discovery phase must compare three concrete options: interoperating with the existing Graphile Worker tables and protocol, running a Rust-owned queue in new tables with a rolling drain plan, or temporarily splitting storage into Rust while a legacy Node host adapter, queue bridge, or sidecar continues to run Graphile Worker. A CLI language driver is not a long-lived queue consumer. The choice must account for delayed jobs, stable message IDs, idempotency, leases, graceful shutdown, attempts, namespaces, and old queued messages.

No PostgreSQL implementation should begin by hiding this choice under a generic queue trait. The queue migration and rollback story is a prerequisite for calling the Rust backend a replacement rather than an additional World.

### PostgreSQL-Specific Behavior

PostgreSQL may keep mechanisms that have no useful SQLite equivalent.

LISTEN/NOTIFY can reduce run-status and stream latency while reads remain authoritative. Row locks, unique constraints, statement-level event arbitration, advisory locks where justified, and a connection pool should be designed for multiple hosts. Backend-specific optimizations are valid only when shared conformance proves the same external World behavior.

Concurrent transition code should adopt and test one lock order, provisionally run row, child entity, then event allocation. A collision retry must observe a fresh committed snapshot; changing PostgreSQL isolation levels is a semantic change, not a generic driver tuning knob.

## Native CLI

The portable CLI is a Rust command kernel with built-in backend operations and versioned language drivers for commands that need a language toolchain.

This split lets `workflow` run in a Python-only environment without forcing Rust to understand every compiler. It also preserves JavaScript functionality during migration instead of making a full builder rewrite the entry price for a native executable.

Read-only CLI commands open storage without calling World `start()` or applying an unrequested migration. Commands that claim work, mutate durable state, import data, or change schema make that behavior explicit in their command contract and confirmation policy.

### Command Ownership

Command ownership follows the data and compiler boundary rather than whether the current command happens to be written in TypeScript.

| Command area | Initial owner | Long-term direction |
| --- | --- | --- |
| Help, version, global config, diagnostics | Native kernel | Native kernel |
| SQLite setup/migrate and metadata-only inspect | Native kernel | Native kernel |
| Payload hydration, `--with-data`, `--decrypt`, rich stream display | Language driver | Native only for a specified portable codec |
| PostgreSQL setup/migrate/inspect | Native after backend exists | Native kernel |
| Vercel inspect/cancel/health | Existing JS path or remote client | Native remote client if API contracts support it |
| Community World operations | JavaScript driver in JS projects | Driver/plugin; no arbitrary npm loading in the native process |
| `build`, `transform`, `validate` | JavaScript driver for TS/JS; Python driver for Python | Language driver unless a genuinely shared compiler layer emerges |
| `start`, cancel, workflow health | Driver while client protocols and payload codecs are language-owned | Shared native client after fixed-vector and rollback tests |
| `web` | JavaScript driver while the UI server is Node-based | Native launcher around a separately distributable UI |
| `init`, `dev` | Kernel orchestration plus language driver | Same split |

The existing command names, aliases, flags, JSON output, exit codes, environment precedence, and non-interactive behavior form a compatibility contract. A golden CLI suite should capture them before replacing oclif parsing.

That suite must include the `workflow` and `wf` bins, `npx workflow`, direct execution of `node_modules/workflow/bin/run.js`, stdout/stderr routing, machine-readable JSON or NDJSON, signal and broken-pipe behavior, World shutdown, and current project/manifest discovery. Historical quirks may be changed deliberately, but not accidentally during a parser rewrite.

`start` is intentionally delegated at first because it negotiates persisted spec and endpoint capabilities, dehydrates arguments, selects queue transport, handles compression and encryption, and coordinates a run-created event with a resilient queue publish. Workflow health likewise uses a queue/stream protocol with legacy response forms. They become Rust operations only after a shared client protocol and fixed vectors exist.

### Language Driver Protocol

A driver is an installed, versioned executable or module selected from explicit project metadata and verified discovery rules.

The kernel owns global flags, configuration layering, terminal capabilities, and final exit status. It passes the working directory, untouched language-specific arguments, relevant configuration, and output mode through a versioned structured protocol. The driver first returns its protocol version and capabilities; an incompatible driver fails with an actionable installation command.

The protocol should emit structured progress, diagnostics, result data, and error codes so human and `--json` output remain consistent. It must not require shell command construction, evaluate project code during discovery, or leak all environment variables by default.

Exact project metadata and transport are open. A stdio protocol is provisional because it works across languages, preserves process isolation, and avoids a long-running daemon; a prototype must prove cancellation, signals, large diagnostics, and Windows behavior.

### Distribution

One native source revision feeds several platform artifacts while preserving familiar package-manager entry points; language SDK packages may consume those artifacts from separately coordinated repositories.

- Standalone archives contain the `workflow` executable, `wf` alias or shim, checksums, signatures or attestations, and license data.
- The npm `workflow` and `@workflow/cli` packages become small launchers that select a platform-specific binary package, preserving `npx workflow` without requiring an install-time Rust compiler.
- A Python distribution provides the PyO3 extension and a console entry point suitable for `uvx` or `pipx`; the exact package spelling must be settled with the Python SDK naming.
- Homebrew, Scoop, or similar installers can consume the same signed release archives after the base matrix is reliable.
- `cargo install` may be offered for Rust developers, but it is not the portable default because it requires a toolchain.

Node-API reduces Node.js ABI churn but does not remove the OS, CPU, and libc artifact matrix. Python wheels add interpreter/ABI and platform tags. The CLI executable, Node native module, and Python module are separate artifacts built from one identified Rust commit and tested independently, even if their package tags and repositories differ.

The Phase 1 blocking matrix is defined in [[rust-portability#Native CLI#Initial Native Validation Matrix]]. It is repository-local integration evidence, not advertised platform support. Support begins only after Phase 2 proves clean installation without a compiler and runtime behavior from the artifacts users will receive.

### Initial Native Validation Matrix

The first native gate is deliberately narrow: it must cover the repository's Node.js contract and three already-probed host families without presenting an experimental source build as a shipped support promise.

| Dimension | Phase 1 blocking floor |
| --- | --- |
| Rust | Native World and binding crates declare MSRV 1.88.0 and compile in CI with both exactly 1.88.0 and the current stable toolchain. This does not silently raise an unrelated SWC/Wasm crate's floor. |
| Node.js | Node.js 22 and 24 use one Node-API 8 binding ABI. Both declared SDK engine lines are tested; there is no per-Node native artifact. |
| Linux | `x86_64-unknown-linux-gnu`, kernel 4.18 or newer, and glibc 2.28 or newer. The artifact is built or checked in a glibc 2.28 baseline environment rather than inferring compatibility from a newer Ubuntu runner. |
| macOS | `aarch64-apple-darwin` with deployment target macOS 13.5 or newer. |
| Windows | `x86_64-pc-windows-msvc` targeting Windows 10 or Windows Server 2016 or newer. |
| SQLite | Link only the bundled SQLite, initially exactly 3.53.2. CI also rejects any future pin below 3.51.3, the upstream safety floor containing the relevant WAL-reset corruption fix. System SQLite is not an alternative in this slice. |

The OS floors follow the current [Node.js platform table](https://github.com/nodejs/node/blob/main/BUILDING.md), which is stricter than Rust on the relevant Linux and macOS targets. Node-API 8 remains usable by later Node.js lines according to the [Node-API version matrix](https://nodejs.org/api/n-api.html), so Node.js 22 and 24 share one ABI without widening the host matrix.

Every OS and Node.js pair must load the addon and complete a small durable sequence: create a database, close it, reopen it, enqueue a message, claim it, and complete it. Rust storage/process tests also run on every host family. The fuller backend-neutral World conformance suite may stay on Linux for Phase 1; Phase 2 expands cross-platform end-to-end and clean-install evidence before support is advertised.

CI pins explicit runner versions and asserts the observed CPU architecture instead of relying on mutable `*-latest` labels; the available labels and architectures come from the [GitHub-hosted runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Unsupported targets fail with an actionable platform error and never fall back to an install-time native compilation.

Intel macOS, Linux arm64, Linux musl/Alpine, Windows arm64, later Node.js majors, and system SQLite are outside this gate. A target string already present in probe metadata, including Intel macOS, is not a promise without its own runner and runtime evidence. Python's interpreter, ABI, OS, and wheel matrix remains a separate Phase 3 decision; its Phase 0 probe is feasibility evidence only.

### Release Coordination

Native artifacts make partial publication a first-class release failure mode.

CI builds and tests every advertised target before publishing npm launchers or a native Python wheel. Consumer packages refer to exact compatible artifact versions. Published artifacts include their package/build identity, Rust commit, persisted-spec range, SQLite version, and enabled backends so support incidents can identify the actual binary.

The existing changeset-driven npm release, Cargo workspace versions, externally maintained Python SDK version, native wheel, and standalone release tag need one machine-readable compatibility manifest and cross-repository gates. A package may advance without advancing the persisted run spec; these operations must remain separate in automation.

## Configuration

Users should see one coherent configuration model whether they entered through Node.js, Python, or the standalone CLI.

Programmatic options override environment variables, which override config files, which override documented defaults unless an existing command already promises different precedence. Parsing and validation live in Rust for backend-owned settings; bindings expose idiomatic constructors without reinterpreting values.

The current npm launcher loads `.env`, then loads `.env.local` with override enabled, so `.env.local` can even replace an inherited process variable. Characterization tests must freeze this fact before the project decides whether the native CLI preserves it or introduces an intentional compatibility break.

Existing environment variables remain supported by the implementation that owns them through the compatibility period; they are not silently reinterpreted by another storage engine. SQLite adds the documented `WORKFLOW_LOCAL_DATABASE_DIR`, while `WORKFLOW_LOCAL_DATA_DIR` remains the filesystem profile's directory. The design should converge on a language-neutral project file, but it must not strand framework build-time settings that currently require JavaScript configuration.

Paths are normalized once, resolved relative to a documented base, and displayed before destructive or long-running migration work. CLI commands never infer a database target from an unresolved environment variable for deletion, clearing, or import.

## Compatibility and Migration

The migration is an adapter replacement under stable user-facing contracts, not a flag day for applications or stored runs.

### JavaScript Compatibility

The `workflow` and `wf` bins, `@workflow/world-local`, and `@workflow/world-postgres` remain valid entry points throughout the migration.

Initially, users explicitly select the native implementation. After conformance, the existing packages can become thin facades that select Rust by default and retain a documented legacy filesystem profile for one compatibility window. That profile is not a transparent fallback for a SQLite data directory: engine selection is explicit before opening data. Removing it requires install telemetry or issue evidence, a platform support policy, and a major-version decision if behavior is observably incompatible.

### Persisted Data Compatibility

Compatibility requirements differ between disposable local state and installed PostgreSQL state.

The SQLite profile starts with a new schema in `.workflow-database` and never mistakes a legacy filesystem directory for a database. If both independent directories exist, the user or project configuration selects an explicit profile; storage presence never triggers implicit fallback or migration. PostgreSQL must read all persisted spec versions supported by the matching TypeScript release and must mint the same default spec version. Unknown future runs fail before mutation.

Payload bytes, encryption context, event IDs, correlation IDs, Hook tokens, queue envelopes, and cursors are tested byte-for-byte or semantically as appropriate. The Rust backend may not hydrate and reserialize user data during a storage migration.

### Rolling Upgrade and Rollback

Every default switch has an explicit mixed-version interval and distinguishes implementation rollback from storage-format rollback.

For SQLite, mixed access means multiple Node.js, Python, and CLI processes using one file. A compatible older native implementation can be selected only while it can read the current SQLite schema. Switching back to the filesystem World is not a data rollback: SQLite-created runs are invisible to it.

Before making SQLite the default, the project must explicitly choose whether local data is disposable across that rollback, provide a reverse export, or pay the complexity of dual writes. The working bias is explicit profiles and no dual write, but that becomes a promise only with a migration policy. For PostgreSQL, mixed access also includes old and new queue producers and consumers on different hosts, so schema changes remain backward-readable throughout the declared window and have a documented last safe rollback point.

## Security and Operability

Moving durability into native code changes failure modes but not the system's trust boundary.

Database URLs, auth tokens, encryption material, application payloads, and SQL parameters are redacted from default logs and structured errors. Native dependencies and standalone binaries carry provenance and vulnerability scanning. SQLite files follow restrictive creation permissions, while PostgreSQL TLS behavior is explicit and never silently downgraded.

Rust emits tracing spans and metrics for transaction latency, busy/serialization retries, queue depth and lease recovery, delivery attempts, stream polling, migration duration, and binding-call latency. Bindings connect those signals to the host SDK's OpenTelemetry context where possible, without making observability a prerequisite for correctness.

A panic, poisoned worker, migration mismatch, or incompatible native module fails closed with enough version metadata to diagnose it. Background-task failures are surfaced through a lifecycle health API where the World contract provides one and, at minimum, through shutdown rather than being printed and forgotten.

## Primary Risks

The program has several cross-cutting risks whose mitigations must exist before a default switch, even when an individual crate appears feature-complete.

| Risk | Architectural mitigation |
| --- | --- |
| TypeScript, Python, and Rust protocol drift | One persisted-spec vocabulary, shared fixtures, exhaustive event handling, and startup range checks |
| Async runtime, GIL, Node event-loop, or shutdown leaks | Thin adapters, instance-owned tasks, explicit cancellation/close, and binding-level tests |
| SQLite corruption, contention, or stuck leased work | Fixed SQLite build, short transactions, durable leases, bounded busy handling, multiprocess crash tests |
| An untrusted caller forges a self-hosted flow delivery | The first SQLite slice retains existing callback-validation parity and makes no authentication claim; before stronger exposure, add the recorded per-claim capability or a coordinated self-hosted authorization design |
| Native artifact missing or loading on the wrong platform | Small advertised matrix, platform packages/wheels, clean-install tests, actionable capability errors |
| CLI behavior differs by installation channel | Native/driver capability handshake and one black-box command/output suite across every launcher |
| PostgreSQL cannot roll back after mixed deployment | Single migration authority, old/new coexistence tests, persisted per-run behavior, explicit queue drain plan |
| Rust accidentally absorbs language-specific payload semantics | Opaque World payloads and a separate, deliberately scoped client/codec layer |

## Verification Strategy

The Rust migration needs one conformance system that can prove backend behavior and cross-language interoperability, not parallel collections of happy-path SDK tests.

### Contract Fixtures

Language-neutral fixtures describe inputs, prior state, operation, expected result or error, and final durable state.

Fixtures cover every event transition, idempotent replay, conflict, stale `eventCount`, dense slots, terminal guards, Hook token retention, resume deduplication, waits, pagination, attributes, legacy spec variants, queue envelopes, and stream boundaries. TypeScript and Rust both consume them so drift is visible before either implementation becomes a reference by accident.

The existing `@workflow/world-testing` suite and backend-specific local/PostgreSQL cases are the first source material for the testkit. They should be made backend-injectable or translated into neutral traces rather than replaced by a smaller Rust-only interpretation.

### Backend Tests

Each backend adds the failure modes its storage engine can actually produce.

SQLite tests use multiple connections and processes, forced busy conditions, process kills around transaction and lease boundaries, WAL recovery, checkpoint pressure, disk-full and permission failures, corrupted or old schema metadata, and concurrent migration attempts. PostgreSQL tests add transaction isolation, pool exhaustion, notifications, network loss, database restart, and mixed old/new worker versions.

The event-log race harness remains a broad probabilistic signal, while direct backend tests stage known races as advised in [[testing#Choosing a Test Level]].

### Binding and Interoperability Tests

Bindings are tested as public SDK surfaces rather than assumed correct because Rust unit tests pass.

Required scenarios include Node.js writing while Python and the CLI read the same SQLite database, Python enqueuing work later delivered after process restart, stable error mapping in both languages, cancellation and shutdown, large byte payloads, stream backpressure, and native-module load failure messages.

The package matrix installs artifacts into clean projects with no compiler present. Tests verify npm launcher selection, `npx workflow`, the `wf` alias, wheel installation, the chosen `uvx` invocation, platform mismatch diagnostics, and checksum/provenance metadata.

### Differential Tests

Where an existing TypeScript World implements the same semantics, a generated operation trace should produce equivalent results and final state in TypeScript and Rust.

Differences in timestamps, generated IDs, physical schema, or pagination encoding are normalized only when the public contract permits them. A normalizer may not hide event order, error classification, status, idempotency, or payload bytes.

## Delivery Sequence

The implementation proves SQLite through Node.js in this repository, completes local E2E, then adds Python interoperability. Defaults change only after repository-local and cross-language evidence exists.

### Phase 0: Contract and Risk Prototypes

This phase creates the minimum shared vocabulary and resolves choices that could invalidate the architecture.

- Inventory the current World API, local extensions, persisted spec versions, event transitions, queue contract, and relevant TypeScript tests.
- Add language-neutral fixtures around run creation, event slots, steps, Hooks, waits, and terminal transitions across the minimum and current supported specs.
- Maintain shared fixed vectors for new SQLite context CBOR and legacy PostgreSQL JSON/text, world-local JSON, and `cbor-x` metadata.
- Prototype Node-API and PyO3 async calls, byte transfer, errors, cancellation, and stream iteration.
- Prototype a multi-process SQLite append, scoped leased queue claim, crash recovery, and active-run reconciliation without duplicate amplification.
- Keep first-slice types hand-mapped behind the backend-neutral conformance suite and shared fixtures; use direct host-type FFI mappings with atomic wrapper/native releases; use bundled `rusqlite` on bounded blocking executors; deliver the initial SQLite queue exclusively through loopback HTTP; route it by stable local deployment targets plus concrete advertised queue names; require explicit in-process host endpoint registration without port discovery; match existing self-hosted callback validation while recording per-claim authorization as later hardening; and map each Vitest pool to a host-selected database instead of a schema-level tag overlay.
- Gate the first native slice on Rust 1.88, Node.js 22/24, Linux x64 glibc 2.28, macOS arm64 13.5, Windows x64, and bundled SQLite 3.53.2 as specified in [[rust-portability#Native CLI#Initial Native Validation Matrix]].
- Record viable ownership and release shapes for the native Python wheel and its external SDK consumer without making that cross-repository decision block the Node.js slice.

Exit requires a written decision for each prototype and one fixture executed by both TypeScript and Rust.

### Phase 1: Node.js and SQLite Walking Skeleton

This phase proves the Rust World architecture inside the current repository before introducing a cross-repository integration variable.

Implement protocol/core/SQLite crates, migrations, run/event/step storage, a minimal durable queue, the napi-rs adapter, and an experimental JavaScript World package. Prove addon loading and a minimal durable operation through the JavaScript World surface, and add a narrow native maintenance CLI with `version`, `doctor`, explicit SQLite migration, and metadata-only inspection. The implementation is experimental and opt-in; it does not replace the current local default.

Exit requires dense event-log and process-restart tests through the Node.js binding, a JavaScript contract smoke test, and read-only CLI inspection that neither migrates nor consumes work. Full workflow E2E and clean-install coverage belong to Phase 2.

### Phase 2: Complete Portable Local World

This phase closes the semantic gaps that a walking skeleton can avoid and proves the Rust local World against this repository's real runtime.

Add all events and optional capabilities intended for launch, durable streams, long polling, Hook retention and resume deduplication, delayed jobs, retries, lease recovery, concurrency limits, observability, cleanup, and the complete conformance suite. Implement database-local `clear()` and active-run recovery, map each `@workflow/vitest` pool to a separate database, aggregate those databases for local observability, and adapt Vitest to a private ephemeral loopback server. Then inject the experimental package into the TypeScript workbench, compare it behaviorally with the filesystem World, and measure Node.js startup, bundle, memory, and queue costs.

Exit requires the applicable local core E2E corpus, direct concurrency and crash tests, queue lease recovery, the event-log race harness, clean npm installation without a Rust toolchain, and a documented SQLite support policy, all runnable without a Python repository checkout.

### Phase 3: Python Binding and Cross-Language Use

This phase proves that the repository-local Rust implementation is genuinely portable infrastructure rather than a Node.js-specific backend.

Add the PyO3 adapter and Python SDK integration using the Phase 0 technical spike, then run TypeScript and Python against databases created by either binding and prove Python queue delivery across process restart. Establish cross-repository compatibility gates and measure Python packaging, startup, memory, queue, and stream behavior without weakening the Node.js baseline.

Exit requires a Python end-to-end workflow, Node/Python/CLI interoperability, a clean wheel install with no Rust or Node.js toolchain, working cross-repository gates and rollback metadata, and no unsupported fallback hidden by the test environment.

### Phase 4: Native CLI and Distribution

This phase makes the portable executable the command entry point while keeping language-specific command implementations available through drivers.

Expand the maintenance shell into the command kernel, complete config and output compatibility, add the driver handshake, standalone archives, npm launchers, and the Python console entry point, and migrate commands incrementally according to the command-ownership table.

Exit requires golden command tests and installation smoke tests for every advertised platform and invocation path.

### Phase 5: PostgreSQL Backend

This phase ports the multi-host self-hosted World only after the shared contracts and release machinery are proven by SQLite.

Complete the schema and queue compatibility design, implement the PostgreSQL crate, run differential and mixed-version tests, and provide setup/migration/rollback commands through the native CLI.

Exit requires existing-run compatibility, queued-message migration or draining, rolling old/new deployment tests, and failure recovery under database and process restarts.

### Phase 6: Adoption and Cleanup

This phase changes defaults only where support evidence justifies it.

Promote the native facades, preserve an announced legacy-profile window, document legacy local-data handling, and later remove superseded TypeScript implementation code. Each removal is a separate decision; completing a Rust implementation does not automatically authorize deleting its predecessor.

## Open Decisions

Phase 0 has no remaining architecture decision. The unresolved product and compatibility questions below are ordered by the later phase they can block.

### Blocking Python Integration

Phase 0 must prove PyO3 feasibility, but these product and cross-repository choices need resolution only before Phase 3 begins.

1. Where are the PyO3 crate and native wheel built and published, and how does the external Python SDK pin a compatible artifact?
2. Which Python versions, ABI strategy, platforms, async runtime, stream mapping, and cancellation behavior form the supported binding contract?
3. How do cross-repository CI, compatibility metadata, and rollback prevent either repository from publishing an unusable pair?
4. What is the exact PyPI package and console-script spelling, and how does an isolated `uvx` process discover the project SDK or Python driver?

### Blocking CLI Compatibility

These decisions can wait until the SQLite World is operational but precede the native CLI default.

1. What project metadata selects a language driver, and how are monorepos or mixed-language projects handled?
2. Which commands and flags are frozen from the oclif CLI before cleanup is allowed?
3. Can `start` define a language-neutral client contract, including opaque binary payloads, serialization, compression, encryption, and deployment lookup?
4. How are native binaries and language packages versioned and published without a partially available release?

### Blocking PostgreSQL Replacement

These decisions should not constrain the SQLite design prematurely, but they must be explicit before PostgreSQL implementation begins.

1. Must the Rust backend use the existing PostgreSQL schema in place, and for how long must old code be able to write it?
2. Is Graphile Worker interoperability sustainable, or does the queue need a new Rust-owned schema and drain protocol?
3. Which migrations are online and reversible across mixed Rust/TypeScript deployments?
4. Which PostgreSQL capabilities are required at first release versus introduced after parity?

### Safe to Defer

These options do not block the first useful Node.js/SQLite result or the later Python target.

- A public stable Rust API or C ABI.
- A required daemon/sidecar mode.
- Bindings for languages beyond Node.js and Python.
- Rewriting the Vercel World, workflow VM, or compilers in Rust.
- Automatic conversion of disposable legacy local data.
- A single universal package containing every database backend.

## Rejected Starting Points

Several tempting approaches create early motion at the cost of the shared architecture.

- A line-for-line port of `world-local` preserves the lock-file complexity the project is trying to remove.
- A language-specific SQLite reimplementation immediately creates the next duplicated World.
- A mandatory daemon exchanges binding work for supervision and IPC work in every local project.
- One generic SQL repository for SQLite and PostgreSQL tends to hide engine-specific concurrency requirements and makes the weaker database dictate both designs.
- A complete CLI rewrite before a driver boundary is proven either drops TypeScript build commands or pulls the whole JavaScript builder into the native binary design.
- An automatic local-data migration risks destroying development state and makes rollback ambiguous.
- Replacing PostgreSQL storage without a queue migration plan leaves old durable jobs as an unowned protocol.

## First Decision Package

The next discussion should approve a small decision package that unlocks the Node.js/SQLite walking skeleton without pretending the full program is settled.

That package consists of the ownership boundary, the pure transition-plan model, the initial crate graph, SQLite as a new explicitly selected local format and application boundary, a persistent SQLite queue direction, stable compatible-worker-group deployment targets with distinct JavaScript/Python defaults, explicit process-local host endpoint registration, napi-rs as the first integrated binding, the minimum native validation matrix, Phase 2 validation through the existing TypeScript E2E paths, TypeScript coexistence, and Phase 0 prototypes for both Node-API and PyO3 plus the persisted codec, FFI representation, SQLite driver, queue routing, reconciliation, and delivery transport. Loopback HTTP is the approved initial SQLite delivery transport; direct binding callbacks are deferred unless later benchmarks justify them. Initial callback validation stays at existing self-hosted parity, with per-claim authorization recorded as later hardening. Python packaging, public package names, PostgreSQL queue design, and default replacement remain open.
