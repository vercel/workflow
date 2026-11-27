# Rust Worlds

Build Rust implementations of the World contract in the order SQLite, Vercel, then Postgres. They coexist with the TypeScript implementations and become selectable from the TS SDK as each backend reaches functional completeness.

## Using and maintaining this framework

This is a working implementation guide for successive agents and reviewers. Keep it aligned with accepted decisions and executable evidence as the project progresses.

Before a slice, read this guide and inspect the current code, tests and relevant design notes. Distinguish implemented behavior, accepted direction and undecided proposals; planned milestones do not establish readiness. Select the next bounded gap and explain its acceptance criteria in the PR.

When a decision changes, revise the affected guidance in the same PR, including consequences for dependencies, compatibility, rollout and remaining work. Replace superseded recommendations rather than accumulating contradictory alternatives. Explain changes to architecture or rollout for review; obtain agreement on crate boundaries before scaffolding. Routine implementation choices within accepted boundaries can proceed without reopening the design.

As work lands, replace assumptions with verified constraints and references to implementation/tests. Keep permanent knowledge with its authority under [[development#Knowledge ownership]]; use links here for coordination. Record rationale needed for later decisions, while leaving chronological progress reports to PRs.

Retire this guide when backend delivery and adoption decisions are resolved and it has no remaining coordination role. Move lasting architecture, compatibility and operational guidance to the appropriate maintained documents, then delete this file and update its index entry and incoming references. Completion does not require keeping a historical plan in the graph.

## Direction and rollout

The implementation order and coexistence model guide subsequent PRs. Each backend advances through its own readiness stages; completing all three is not a prerequisite for using the first.

| Stage | Expected behavior |
| --- | --- |
| Development | Rust components and private integration harnesses grow in small PRs. Existing TS implementations continue serving users. |
| Functionally complete | A reviewed parity inventory covers the target TS World's operations, supported run formats, capabilities, configuration and lifecycle. The Rust backend and host artifacts pass the corresponding acceptance checks. |
| Selectable | The TS SDK can explicitly select that Rust World. Configuration, supported environments, persisted-data compatibility and switching procedures are documented and tested. |
| Mature | Operational use demonstrates reliability, maintainability, installation compatibility and representative performance. A separate reviewed change can make this Rust backend the default for its environment. |

Default promotion is a decision for each backend, supported by evidence and a rollback plan. A selectable Rust SQLite World can mature while Rust Vercel and Postgres work proceeds. Preserve explicit implementation selection as defaults evolve.

For each backend under development, keep a concise readiness summary here linking to its parity inventory, implemented entry point, test evidence and next gap. Mark planned and verified behavior separately. Optional capabilities absent from the target TS World do not become requirements merely because another backend supports them; any intended contract differences require explicit review.

Language SDKs retain compilation, workflow replay and step execution. Rust implements reusable World services; thin host bindings adapt values, callbacks, streams and lifecycle. These APIs should also support other language SDKs and a future Rust CLI without requiring those projects in the first delivery.

## Shared architecture

The shared boundary is the World contract, with backend-specific storage and transport below it and host-language integration above it. SQLite implementation details must not become requirements of the remote or Postgres backends.

[[packages/world/src/interfaces.ts#World]] combines [[packages/world/src/interfaces.ts#Storage]], [[packages/world/src/queue.ts#Queue]] and [[packages/world/src/interfaces.ts#Streamer]]. [[packages/world/src/interfaces.ts#WorldCapabilities]] describes optional behavior. Rust types can express this contract idiomatically while preserving observable ordering, values, errors and retry semantics.

Keep host objects, binding runtimes and presentation concerns out of reusable Rust code. Share protocol models and behavior where consumers demonstrate the same requirement; keep database drivers, platform authentication and backend delivery mechanisms with their implementations. Vercel is a client of platform services, while SQLite and Postgres own database operations.

Preserve opaque application payloads as bytes. Host conversions must distinguish absent values, nulls, timestamps and binary values. Use typed errors with source chains and explicit mappings to SDK errors; callers must retain the distinction between a definite refusal and an uncertain outcome.

## Decisions before scaffolding

Use backend-specific Node bindings with the directory and naming convention below. Confirm crate interfaces and packaging details before scaffolding each backend.

| Directory | Rust crate | Node package |
| --- | --- | --- |
| `crates/world` | `workflow-world` | — |
| `crates/world-sqlite` | `workflow-world-sqlite` | — |
| `crates/world-vercel` | `workflow-world-vercel` | — |
| `crates/world-postgres` | `workflow-world-postgres` | — |
| `packages/world-sqlite-rust` | `workflow-world-sqlite-node` | `@workflow/world-sqlite-rust` |
| `packages/world-vercel-rust` | `workflow-world-vercel-node` | `@workflow/world-vercel-rust` |
| `packages/world-postgres-rust` | `workflow-world-postgres-node` | `@workflow/world-postgres-rust` |

Pure Rust libraries live under `crates/`, without Node or binding-runtime dependencies. The shared contract owns the host-independent types, errors and interfaces needed by consumers, without database drivers. Backend libraries own their storage or platform transport, streams and any delivery implemented in Rust. Node bindings live in the corresponding npm package directories under `packages/`, adapting values, callbacks, streams and resource ownership for the TS SDK. A package may also compose existing TS components into its full `World`, as the SQLite package does with the local queue.

The `-node` suffix identifies the Rust crate's host binding; `-rust` distinguishes the npm package from existing TypeScript implementations. Each binding depends on its corresponding backend library, beginning with `workflow-world-sqlite-node` → `workflow-world-sqlite`, so SQLite's native artifact and dependencies remain independently deliverable. Extract shared binding utilities when actual duplication warrants them.

The dependency direction is host binding → backend → shared contract. Backend libraries also serve Rust consumers without loading Node. Introduce each backend crate when work on it starts; avoid empty placeholders. Keep the initial contract small and extract shared behavior when a second backend demonstrates the need, rather than introducing a generic SQL or transition-engine crate upfront.

The structural discussion should settle public interfaces, backend features and native artifact packaging within this layout. Introduce each binding alongside its backend's integration probe; settle its interface before exposing the public npm package. Python bindings and a Rust CLI can become separate consumers later.

[[Cargo.toml]] already defines the compiler workspace, dependency versions, minimum compiler and release profile. Decide how new crates join that workspace, how native profiles coexist with compiler builds, and which dependencies/features belong to each consumer. Preserve existing compiler targets and validate any toolchain or profile change separately.

Settle the initial host-binding mechanism, resource ownership, supported platforms and native linkage in focused proposals or probes. Node integration serves the TS SDK first; additional language bindings can follow the same Rust APIs. After crate agreement, validate a small end-to-end host probe before expanding the backend: call Rust from Node, perform an isolated SQLite operation, return binary data or a typed error, and release resources. Choose development toolchain pins and MSRV deliberately rather than inheriting versions from the earlier experiment or another repository.

After crate agreement, the first implementation slice can be the minimal Node → Rust → SQLite probe above, with its own tests. Reuse or adapt existing World tests and conformance helpers as each slice lands, adding coverage where needed. A separate contract-fixture PR is optional; capture TS behavior upfront where an ambiguity would affect the Rust design. Useful examples include an accepted event with its projection, a refused mutation with its observable outcome, and a binary payload round trip. Record the reference revision and deterministic inputs; compare results and database state after reopening where applicable.

## Backend sequence

Use each backend to validate the shared architecture through a complete implementation. Extract common components with evidence from their actual consumers.

### SQLite

SQLite ports `@workflow/world-local`, the TS local World. Rust provides storage and streams; `@workflow/world-sqlite-rust` adds the existing in-memory queue so its first public TS SDK integration offers the complete World surface.

Port its behavior rather than designing a new backend. Start from [[packages/world-local/src/index.ts#createWorld]] and its existing tests, and match its defaults, including [[packages/world-local/src/config.ts#Config|configuration]], data location ([[packages/world-local/src/db/index.ts#DATABASE_FILE_NAME]] in the data directory) and the SQLite settings applied by [[packages/world-local/src/db/index.ts#Database]]. Record the reason for any divergence in the PR that introduces it.

`workflow-world-sqlite` implements database open/migrations and codecs, reads, transactional event writes and streams in coherent slices. An accepted event and all affected projections commit together. Preserve slot allocation, idempotency, hook ownership and resume deduplication, fences, pagination, retention, tag scoping and capability semantics relevant to the supported run formats.

`@workflow/world-sqlite-rust` keeps the queue from [[packages/world-local/src/queue.ts#createQueue]] in TS to provide the required queue APIs; the queue's storage reads go through the Rust backend. The package also owns restart recovery and shutdown, as the TS `createWorld` does; [[packages/world-local/README.md]] explains the storage/queue split. Moving storage alone is an internal milestone, not completion of the Rust World. A shared embedded queue for TS and other language SDKs is proposed separately in [vercel/vercel-rs#32](https://github.com/vercel/vercel-rs/issues/32) and is outside this port.

Start from the TS on-disk format defined by [[packages/world-local/src/db/schema.ts#migrate]] and [[packages/world-local/src/db/codec.ts#encode]]. If TS and Rust are to share a database, the implementation PR must prove it works in both directions and across processes. A distinct format or data location would require an explicit migration and switching policy.

Connection ownership and concurrency also start from the TS local World. Preserve what callers observe when the database behind [[packages/world-local/src/db/index.ts#databaseFor]] is closed, reopened or replaced; the storage PR settles concrete connection management and explains any differences. Like the TS local World, which calls SQLite synchronously on the JS thread, `workflow-world-sqlite` stays synchronous and needs no async runtime. Under write contention, [[packages/world-local/src/db/index.ts#Database#transactAsync]] tries `BEGIN IMMEDIATE` without waiting, then yields to the event loop and retries within a timeout; the Rust crate can return SQLite's busy error and let `@workflow/world-sqlite-rust` retry the same way.

### Vercel

Vercel follows SQLite and validates that Rust's reusable interfaces support a client of the existing platform services. Rewriting those services is outside this backend's scope.

Use [[packages/world-vercel/src/index.ts#createWorld]] and its tests as the reference for platform contracts. Split protocol/value conversion, request authentication and deployment context, event operations, streaming transports, queue integration and lifecycle into reviewable changes.

Preserve encryption, capability negotiation, error classification, retry identities, trace propagation and transport shutdown. Exercise scripted protocol tests before authenticated deployment tests. Do not equate retries after explicit admission refusals with retries after a response was lost following a possible commit. Detailed tracing rules remain in [[architecture#Architecture notes#Trace context propagation (world-vercel HTTP requests)]].

### Postgres

Postgres follows Vercel, reusing demonstrated contract and binding components while providing its own transactional storage and durable delivery coordination.

Use [[packages/world-postgres/src/index.ts#createWorld]] and its tests as the behavioral reference. Review schema/data compatibility, event transactions, job delivery and leases, notifications, streams and shutdown as separate coherent slices. Validate multi-process and multi-host behavior; a SQLite worker model does not establish distributed delivery correctness.

Document whether Rust and TS workers can share storage and queues, and test the supported coexistence or migration path. Changes to authentication, queue technology or deployment topology need explicit scope and acceptance criteria rather than being folded into a language port.

## PR progression

Each PR should establish one reviewable contract or capability with its own evidence. The work units below guide each backend without requiring a separate PR for every row or a fixed sequence for contract examples.

| Work unit | Review boundary |
| --- | --- |
| Contract examples | Reuse or adapt existing World tests and conformance helpers alongside each slice. Capture TS behavior upfront where design ambiguities require it, recording the reference revision and intentional differences. |
| Structural proposal | Agree crate/binding boundaries, data-compatibility direction and supported host/artifact targets before implementing those decisions. |
| Minimal scaffold and host probe | Add only the agreed components needed for one end-to-end operation, including error conversion and resource release through Node. |
| Pure values and codecs | Test identities, timestamps, bytes and error conversions without introducing backend or host-runtime dependencies unnecessarily. |
| Backend operations | Add read groups, write transition families or protocol operations independently. Each mutation keeps its complete transaction boundary. |
| Delivery, streams and lifecycle | Establish callbacks, backpressure, cancellation, restart recovery, resource release and backend-specific coordination. |
| Host integration and packaging | Expand the early probe into artifact and SDK integration tests across claimed environments. Keep incomplete implementations in internal harnesses. |
| Explicit SDK selection | Expose the functionally complete backend with documented configuration, capabilities and data compatibility. |
| Default promotion | Review maturity evidence, regressions, operational diagnostics and rollback before changing automatic selection. |

Open implementation PRs as drafts. Follow [[pull-requests]] and [[releases]] for review and changeset requirements. Keep unrelated refactors, new World features, compiler changes and CLI work in separately scoped PRs.

## Rust engineering principles

Rust code should make ownership, failures and concurrency explicit while keeping the contract stable across hosts. Concrete runtime and connection designs start from the TS implementation being ported and belong to the PR that introduces them.

- Make ownership of database handles, transport pools, workers and shutdown state explicit. Process-local synchronization cannot enforce cross-process invariants.
- Move owned values across host and worker boundaries. Keep thread-affine host handles on their permitted threads; justify any unsafe code and buffer-sharing assumptions.
- Do not add an async runtime ahead of need. A backend that does use an executor keeps blocking work off its workers, with bounded admission and defined shutdown behavior. A timeout or dropped future does not establish that an executing write was canceled.
- Avoid calling host/user code while holding write transactions or critical locks. Define how notifications and delivery recover when a commit succeeds but subsequent signaling fails.
- Return typed failures for expected errors. Malformed inputs, contention and contract refusals must not become panics.
- Review dependency features, native linkage and compile cost per consumer. Test the distributed addon or library itself; a successful standalone binary build does not establish host compatibility.

## Acceptance and SDK selection

Readiness requires contract, integration and distribution evidence. Passing Rust unit tests is one part of that evidence.

Use the reviewed parity inventory to map operations and capabilities to evidence, including delivery authentication, recovery, rate limits, retention, snapshots and observability where supported. Do not equate a passing generic suite with complete backend coverage. Record the TS reference revision and reconcile upstream contract changes before exposing selection or changing defaults. Resolve discrepancies between contract and implementation explicitly; separate existing defects from intended compatibility behavior.

Reuse the World conformance suite in [[packages/world-testing/src/index.mts]] and focused helpers in [[packages/world/src/test-support]]. Run differential mutations against isolated equivalent databases or test services. Compare returned results/errors and persisted outcomes; normalize only controlled nondeterminism, never ordering or refusal semantics. Include committed refusals and unknown outcomes after interrupted writes, rather than assuming every error means rollback.

SQLite acceptance includes real-file transactions, close/reopen, lock contention, crash consistency and cross-process access; existing [[packages/world-local/src/storage/crash-consistency.test.ts]] and [[packages/world-local/src/storage/fuzz-invariants.test.ts]] provide useful evidence. Remote backends also require protocol, interruption and deployment tests. Run the supported execution formats and capabilities identified by the current [[architecture#Workflow execution model|runtime design notes]]. [[testing]] and [[event-log-race-repro]] describe existing validation procedures.

Before exposing a backend to the TS SDK, exercise callbacks, binary ownership, live streams, cancellation and shutdown through the real host adapter. Define the supported host runtimes, OS/architecture and libc targets explicitly. Validate clean installation without a Rust compiler, framework builds and workflow execution, plus build-time handler loading and read-only CLI/observability access where supported. Include rustfmt, clippy, rustdoc, locked builds, MSRV and relevant feature combinations in the implementation checks.

Integrate selection through the SDK's World factory boundary, represented by [[packages/core/src/runtime/world.ts#createWorldFromModule]], and document the chosen package/configuration in the integration PR. Native loading errors must identify the selected implementation and actionable failure. Do not silently switch implementations after a failed operation whose commit outcome may be unknown.

Coexistence does not imply automatic mid-run handoff or concurrent ownership of the same work. Define data, queue and execution ownership when switching implementations, including rollback. Before promotion, compare operational correctness, install success, resource use, startup and latency under equivalent durability and workload settings. The promotion PR must state its maturity criteria, supporting measurements and a tested rollback procedure, including any data-conversion limits.

## Prior work and references

Prior work supplies design and test evidence to evaluate against the current contract. Its package layout, support matrix and completion labels do not determine subsequent implementation decisions.

The [feat/rust-world-portability experiment](https://github.com/fantix/workflow/tree/feat/rust-world-portability) lives in a separate fork. Its [pinned snapshot](https://github.com/fantix/workflow/tree/fe3197e122e046785ac75cfe1b439efdd2960c37) contains reusable compatibility tests, transaction ideas and binding probes. Its storage format, queue and async-runtime choices predate the current TS local World and must be reassessed.

At `vercel/vercel-rs` revision `84ffe3a28228d58da8a7c2dbb74486b9fe44c5b0`, the [architecture](https://github.com/vercel/vercel-rs/blob/84ffe3a28228d58da8a7c2dbb74486b9fe44c5b0/lat.md/architecture.md), [API design](https://github.com/vercel/vercel-rs/blob/84ffe3a28228d58da8a7c2dbb74486b9fe44c5b0/lat.md/api-design.md) and [runtime guidance](https://github.com/vercel/vercel-rs/blob/84ffe3a28228d58da8a7c2dbb74486b9fe44c5b0/lat.md/runtime.md) provide reference patterns for incremental shared-code extraction, behavioral parity and resource ownership. Evaluate its HTTP-client-specific policies separately from database and host-binding requirements.

Turborepo's [Node binding manifest](https://github.com/vercel/turborepo/blob/3210d69fe82bc95cf27c5ad9484b42d08bb1e2eb/packages/turbo-repository/rust/Cargo.toml) and [CI](https://github.com/vercel/turborepo/blob/3210d69fe82bc95cf27c5ad9484b42d08bb1e2eb/.github/workflows/turborepo-test.yml), pinned at `3210d69fe82bc95cf27c5ad9484b42d08bb1e2eb`, illustrate separating ordinary libraries from native bindings and testing Rust and host packages independently.
