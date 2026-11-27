# Rust SQLite World

The Rust SQLite World ports `@workflow/world-local` to Rust. It currently sets up the TS local World's database file and runs a temporary host probe; it has no World schema or operations and the SDK rejects it.

[[plan#Backend sequence#SQLite]] holds the accepted direction and remaining plan. This document describes only what is implemented. Port [[packages/world-local/src/index.ts#createWorld]] behavior by default, and list each current difference under [[world-sqlite#Differences from the TS local World]].

## Components

Two crates split host-independent behavior from the Node adapter, following the [[rust#Crate layout]].

`workflow-world-sqlite` in [[crates/world-sqlite/]] is the backend library. It has no Node dependency and no async runtime; its operations are synchronous, so the host decides which thread calls them. [[crates/world-sqlite/Cargo.toml]] bundles SQLite through rusqlite, avoiding a system SQLite dependency. The driver stays internal: no rusqlite type appears in the crate's public API.

`workflow-world-sqlite-node` in [[packages/world-sqlite-rust/]] builds the private `@workflow/world-sqlite-rust` npm package with napi-rs. [[packages/world-sqlite-rust/README.md]] lists its development commands.

## Rust crate

The crate's public API is [[crates/world-sqlite/src/config.rs#Config]], [[crates/world-sqlite/src/lib.rs#World]] and [[crates/world-sqlite/src/error.rs#Error]]; database handles stay private.

### Configuration

`Config` ports [[packages/world-local/src/config.ts]] for the options implemented so far. It is non-exhaustive: callers start from [[crates/world-sqlite/src/config.rs#Config#from_env]] and override public fields, so later options do not break them. [[crates/world-sqlite/src/lib.rs#World#new]] stores the configuration's database path without touching the filesystem.

The database is [[crates/world-sqlite/src/database.rs#DATABASE_FILE_NAME]] in the data directory, matching [[packages/world-local/src/db/index.ts#DATABASE_FILE_NAME]], so both implementations address the same file.

#### Environment

`Config::from_env` takes the data directory from a non-empty `WORKFLOW_LOCAL_DATA_DIR`, falling back to `.workflow-data` relative to the working directory.

Like the TS `config` value, the environment is read once per process, on the first call; later changes to the variable have no effect. The crate owns this default so every host binding gets the same behavior.

### Spec version

[[crates/world-sqlite/src/lib.rs#World#spec_version]] is the version the World declares to the SDK, as `specVersion` on the TS local World. It returns 0 until World operations are complete, so SDK protocol validation rejects the World.

The TS local World computes its version with [[packages/world/src/spec-version.ts#mintedSpecVersion]] from its capabilities and `WORKFLOW_SPEC_VERSION`. That logic belongs to the shared contract and lands with the capabilities it depends on.

### Database connections

[[crates/world-sqlite/src/database.rs#Database]] holds a path, not a connection. [[crates/world-sqlite/src/database.rs#Database#with_connection]] opens a connection for one operation and closes it afterwards, including on failure.

This is the TS local World's `none` mode of [[packages/world-local/src/db/index.ts#connectionMode]]. Because no handle is retained, removing the file between operations works, and the next operation creates it again rather than writing to an unlinked file.

[[crates/world-sqlite/src/database.rs#open]] ports [[packages/world-local/src/db/index.ts#open]] for waiting callers: it creates the data directory and applies the same settings in the same order. They are a 30-second busy timeout, incremental auto-vacuum (left alone once set, so no write lock is needed), a 64 MiB journal size limit, WAL, normal synchronization, secure delete and foreign keys. It installs no schema and leaves `user_version` at 0.

#### Lock waits

While another process holds the file, opening blocks the calling thread for up to the busy timeout. This matches how the TS local World waits synchronously on the JS thread.

SQLite's busy handler covers most setup statements. Switching to WAL gets no busy handler, so [[crates/world-sqlite/src/database.rs#retry_while_busy]] retries it while SQLite reports `SQLITE_BUSY` or `SQLITE_LOCKED`. It sleeps for the same backoff as the TS `retryWhileBusy` (doubling from 1 ms up to 50 ms), within the busy timeout.

### Errors

`Error` wraps a filesystem or SQLite failure. It displays as the underlying error and continues that error's source chain.

When SQLite reported the failure, [[crates/world-sqlite/src/error.rs#Error#sqlite_code]] returns its extended result code and [[crates/world-sqlite/src/error.rs#Error#sqlite_description]] its generic description, so hosts can classify errors without depending on the driver. Extended codes match `node:sqlite`'s `errcode` but can vary by platform, such as `SQLITE_CANTOPEN_ISDIR` on Windows; classify by the primary code in the low 8 bits. The message is rusqlite's, which for open failures appends the file path to SQLite's message.

## Node binding

[[packages/world-sqlite-rust/src/lib.rs#SqliteWorld]] owns its Rust World and calls it synchronously on the JS thread, as the TS local World calls `node:sqlite`. It needs no worker pool, mutex or Promise wrapper.

### Options

[[packages/world-sqlite-rust/src/lib.rs#create_world]] always starts from `Config::from_env`, then applies [[packages/world-sqlite-rust/src/lib.rs#WorldOptions]]. An omitted or `undefined` `dataDir` keeps the environment default.

Reading the environment even when `dataDir` is given matches the TS local World, which merges its options over its environment config: the first call fixes the default for the process either way.

### Buffers

Each probe call borrows its input Buffer during the synchronous call and returns a new Buffer, so neither side observes later mutation of the other.

### Errors

[[packages/world-sqlite-rust/src/lib.rs#host_error]] throws SQLite failures shaped like `node:sqlite` errors, which the TS local World surfaces unchanged. Each is an `Error` with `code` `ERR_SQLITE_ERROR`, plus SQLite's `errcode` and `errstr`.

A message starting with SQLite's own text keeps the TS busy detection (`database is locked`) applicable. Filesystem failures throw plain errors carrying the underlying message.

### SDK loading

The package's root export is the generated ESM loader declared in [[packages/world-sqlite-rust/package.json]], so the SDK and the package's own tests resolve it by name.

The [[packages/world-sqlite-rust/src/lib.rs#SqliteWorld#spec_version|specVersion getter]] forwards the crate's [[world-sqlite#Rust crate#Spec version]]. The object advertises no capabilities or World methods until they are implemented.

## Host probe

[[crates/world-sqlite/src/lib.rs#World#echo]] binds bytes as a SQLite BLOB and reads them back through a real database connection. It is temporary and not part of the World contract.

The probe covers the end-to-end path required before expanding the backend: Node calls Rust, Rust runs a SQLite statement, binary data or a typed error returns, and the connection is released. It keeps empty, NUL-containing and non-UTF-8 values as bytes. Remove it once storage operations carry binary payloads through the binding.

## Tests

The crate has its own unit and functional tests. The package's tests follow how other Worlds are tested: through the shared conformance suite, plus temporary probe checks.

- **Unit tests** inline in [[crates/world-sqlite/src/database.rs]] cover internals the public API cannot observe: per-connection settings, connection release, and waiting for a lock held by another thread.
- **Functional tests** in [[crates/world-sqlite/tests/]] use only the public API. Cargo runs each file as its own process, so [[crates/world-sqlite/tests/config.rs]] observes the once-per-process environment read from a fresh start.
- **Conformance** belongs in [[packages/world-sqlite-rust/test/spec.test.ts]]. It currently asserts that the SDK rejects spec version 0. Once the World is functionally complete, it runs `createTestSuite` from [[packages/world-testing/src/index.mts]], as [[packages/world-postgres/test/spec.test.ts]] does. world-local runs the same suite from [[packages/world-testing/test/embedded.test.ts]].
- **Probe checks** in [[packages/world-sqlite-rust/test/probe.test.ts]] are the end-to-end acceptance for the [[world-sqlite#Host probe]]: Buffers round trip through SQLite, and SQLite failures match `node:sqlite` errors. Delete them with `echo`.

The crate is reusable without a host, so its tests stand alone rather than relying on host-level coverage. Each expectation must come from outside the implementation, such as TS local World behavior, documented SQLite results or the test's own input, never from rerunning the code under test. A failure case should behave the same on every platform: [[crates/world-sqlite/tests/world.rs#sqlite_failures_expose_sqlite_result_codes]] uses `SQLITE_NOTADB`, which has no extended codes.

world-local's own tests mostly exercise its internals and serve as references for later slices. [[packages/world-local/src/db/schema.test.ts]] guides the crate's migration tests. [[packages/world-local/src/db/write-lock-wait.test.ts]] and [[packages/world-local/src/db/lock-contention.test.ts]] move to this package once its JS side retries busy writes without blocking the thread.

[[rust#Tests]] describes how both layers run locally and in CI.

## Differences from the TS local World

These differences are deliberate gaps in the current slice; each closes or receives a recorded rationale in the PR that changes the area.

- **Schema:** [[packages/world-local/src/db/schema.ts#migrate]] runs on every TS open. Rust installs nothing, so a file it creates is configured but empty; a TS World opening it later migrates it as a new database.
- **Missing files:** TS reads never create the database or data directory; they read an empty in-memory database until a write creates the file. Every Rust operation currently creates the file.
- **Connection sharing:** TS shares one idle-closed connection per file per process (`keep` mode, or `brief` on Windows) and reopens it when the file's identity changes. Rust always uses `none` mode.
- **Non-waiting writes:** [[packages/world-local/src/db/index.ts#Database#transactAsync]] opens and begins without a busy timeout, yielding to the event loop between attempts. Rust has no write transactions yet.
- **World lifecycle:** queue, queue auth key, data directory initialization, legacy-data notices, recovery, `start()`, `close()` and `clear()` are absent.
