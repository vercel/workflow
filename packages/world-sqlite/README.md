# `@workflow/world-sqlite`

Experimental, opt-in portable local World backed by native Rust and SQLite.
It implements the complete event lifecycle, materialized runs, steps, Hooks and
waits, durable streams, terminal-status polling, a leased loopback HTTP queue,
active-run recovery, Hook retention and resume deduplication, and
database-local cleanup. It does not replace `@workflow/world-local` by default.

```ts
import { createWorld } from '@workflow/world-sqlite';

const world = createWorld({
  databaseDir: '.workflow-database',
  queueNames: ['__wkf_workflow_my-workflow'],
  baseUrl: 'http://127.0.0.1:3000',
});

await world.migrate(); // Schema changes are always explicit.
await world.start();
```

Construction is side-effect free. `migrate()` is the only package operation
that advances the schema. `start()` checks the schema, recovers active runs by
default, and starts queue consumers only when exact `queueNames` were supplied.
Queue consumption also requires a loopback `http:` `flowUrl` or `baseUrl`; the
package never discovers ports or claims queues by prefix.

Framework hosts that load a zero-argument custom-World factory can call
`registerHost()` first. Repeating an identical registration is safe, while a
conflicting URL or queue set for the same canonical database and deployment
target fails before work is claimed. Independent databases or targets may
register their own routes in the same process. A wildcard listen address is
normalized to a connectable loopback address.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `databaseDir` | `WORKFLOW_LOCAL_DATABASE_DIR`, then `.workflow-database` | Directory containing `workflow.sqlite`. |
| `deploymentId` | `local-js` | Stable compatible-worker-group queue target. |
| `queueNames` | `[]` | Exact concrete queue names this process may consume. |
| `flowUrl` | none | Full private loopback flow-handler URL. |
| `baseUrl` | `WORKFLOW_LOCAL_BASE_URL`, then `PORT` on `127.0.0.1` | Loopback base URL used to derive the standard flow route. |
| `workerConcurrency` | `4` | Concurrent native deliveries, from 1 through 256. |
| `leaseDurationMs` | `30000` | Renewable queue lease duration. |
| `pollIntervalMs` | `25` | Queue and long-poll interval. |
| `retryDelayMs` | `100` | Delay after a failed HTTP delivery. |
| `requestTimeoutMs` | `10000` | Per-delivery HTTP deadline; leases renew while it runs. |
| `recoverActiveRuns` | `true` | Re-enqueue pending and running runs during `start()`. |
| `hookRetentionLimitDays` | `WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS`, then `30` | Maximum minimum-retention deadline accepted for a Hook. |

Programmatic values take precedence over environment variables. The legacy
`WORKFLOW_LOCAL_DATA_DIR` belongs only to the filesystem World and is not an
alias. `@workflow/vitest` can select this World with `world: 'sqlite'`; each
Vitest pool receives its own `vitest-<pool>.sqlite` database.

`clear()` deletes rows only in the selected database and preserves the schema.
It never recursively removes the database directory or another Vitest pool.

Wrappers for the same canonical database share one Rust runtime engine in the
process. The current conservative engine reuses one connection and serializes
all access, staying below the profile's three-reader ceiling. Connection
acquisition, the local lane, and SQLite lock waiting share one five-second
budget; exhaustion is a retryable storage error that reports its wait stage and
elapsed time. Inspection tools use checksum-pinned read-only handles and never
migrate, recover runs, or start queue workers.

Run, step, and Hook pages use opaque creation-time-and-ID cursors, so ties are
stable and a continuation does not depend on the cursor row still existing.
Graceful shutdown always closes native state and rejects with
`QUEUE_STORAGE_FAILURE` if a worker observed background storage failures.

## Experimental support policy

The source build requires Rust 1.88 and Node.js 22 or 24. CI runs the native
adapter contract on Node.js 22 and 24 for Linux x64 with glibc 2.28 or newer,
macOS arm64 with a 13.5 deployment target, and Windows x64. The complete staged
Next.js production E2E and no-Rust consumer lane is currently Linux x64 on
Node.js 22 and remains advisory. This is experimental validation, not a public
cross-platform distribution promise. The addon uses Node-API 8 and bundled
SQLite 3.53.2. musl, network filesystems, and multiple unrelated applications
sharing one database are not supported.

SQLite runs in WAL mode with foreign keys and `synchronous=NORMAL`. Committed
transactions recover after an application-process crash, but a machine crash
or power loss can roll back recent acknowledged writes. Use this package for
local development and tests, not as an advertised production backend.

The core runtime's experimental run-payload `retention` option is accepted but
is not materialized by this backend yet. SQLite keeps that data until ordinary
run cleanup or `clear()`; do not use this profile to test retention expiry.

The package remains private while its final public package name and artifact
layout are decided. CI nevertheless packs the wrapper with a prebuilt native
addon and exercises a clean staged application with failing `cargo` and `rustc`
shims ahead of any runner toolchain. Native metadata carries both the Cargo
crate version and the injected wrapper package version; loading requires the
latter to match exactly.

## Development measurements

The Phase 2 snapshot below is one local sample from 2026-09-08 on an Apple M4
Pro (macOS arm64, Node.js 24.18.0); it is a regression reference, not a
performance commitment.

| Measurement | Result |
| --- | ---: |
| Staged Next.js optimized compile | 6.2 s |
| Staged `.next` output / `.next/server` | 96 MiB / 79.6 MiB |
| Native addon | 7.6 MiB |
| Production server ready | 127 ms |
| Applicable local E2E | 158 passed, 2 expected advisory failures in 238.05 s |
| Server RSS observed after that corpus | 607 MiB |

Run `pnpm --filter @workflow/world-sqlite benchmark:queue` for the isolated
loopback queue sample. With 1,000 one-byte messages and concurrency 4, the same
machine migrated in 6.3 ms, enqueued in 87.9 ms (11,383 messages/s), and drained
in 299.7 ms (3,337 deliveries/s) at 88.1 MiB process RSS, with all 1,000 rows
acknowledged and no delivery or storage failures. The message count and
concurrency can be changed with `WORKFLOW_SQLITE_QUEUE_BENCH_MESSAGES` and
`WORKFLOW_SQLITE_QUEUE_BENCH_CONCURRENCY`.
