# @workflow/world-postgres

An embedded worker and workflow system backed by PostgreSQL for multi-host self-hosted solutions. This is a reference implementation. A production system might run workers in separate processes with a dedicated queuing system.

## Installation

```bash
npm install @workflow/world-postgres
# or
pnpm add @workflow/world-postgres
# or
yarn add @workflow/world-postgres
```

## Usage

### Basic setup

The PostgreSQL World can be configured by setting the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```

### Configuration

Configure the PostgreSQL world using environment variables:

```bash
# Required: PostgreSQL connection string
export WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"

# Optional: Job prefix for queue operations
export WORKFLOW_POSTGRES_JOB_PREFIX="myapp"

# Optional: Worker concurrency (default: 10)
export WORKFLOW_POSTGRES_WORKER_CONCURRENCY="10"

# Optional: Internal pg.Pool max size (default: 10)
export WORKFLOW_POSTGRES_MAX_POOL_SIZE="10"

# Optional: Let the application coordinate shutdown (default: false)
export WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN="1"

# Optional: Maximum Hook minimum retention in days (default: 30)
export WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS="30"
```

### Programmatic usage

You can also create a PostgreSQL world directly in your code:

<!-- @skip-typecheck: incomplete code sample -->
```typescript
import { createWorld } from "@workflow/world-postgres";

const world = createWorld({
  connectionString: "postgres://username:password@localhost:5432/database",
  jobPrefix: "myapp", // optional
  queueConcurrency: 50, // optional
  maxPoolSize: 10, // optional, overrides WORKFLOW_POSTGRES_MAX_POOL_SIZE when `pool` is omitted
});

// Or pass an existing pg.Pool (shared with your app Drizzle, etc.); `world.close()` will not end it.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const worldFromPool = createWorld({ pool });
```

### Application-managed shutdown

By default, Graphile Worker responds automatically when the application is asked to shut down. If your application already coordinates shutdown, set `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1` when selecting the package with `WORKFLOW_TARGET_WORLD`, or set `applicationManagedShutdown: true` when calling `createWorld()` directly. Await `world.close()` from your shutdown path so Graphile Worker cannot terminate the process as soon as its queue stops, before your application finishes closing dependent resources:

```typescript
import { createWorld } from '@workflow/world-postgres';

const world = createWorld({
  connectionString: process.env.DATABASE_URL!,
  applicationManagedShutdown: true,
});

await world.start();
```

Use this option only when your application or framework has its own shutdown hook. Handle cleanup errors there and await `world.close()` first, then close the workflow HTTP server and any caller-owned `pg.Pool`.

Closing the world stops the queue from accepting new jobs and waits for active jobs. After Graphile Worker's graceful-shutdown timeout (5s by default), it aborts any workflow HTTP request that is still pending. Graphile Worker then unlocks the same row through its normal failure handling. Graphile counts a delivery attempt when it claims the row, so the aborted delivery consumes that attempt and is retried only if its Graphile attempt budget remains. A one-attempt or final-attempt job is unlocked but not retried. The shutdown handler does not create a replacement row.

An aborted HTTP request does not guarantee that its server-side handler stopped, so workflow and step handlers must continue to tolerate at-least-once execution. Keep the workflow HTTP routes and any caller-owned pool available until `world.close()` resolves.

## Configuration options

| Option             | Type      | Default                                                                                | Description                                                                                          |
| ------------------ | --------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `connectionString` | `string`  | `process.env.WORKFLOW_POSTGRES_URL`, `process.env.DATABASE_URL`, or `'postgres://world:world@localhost:5432/world'` | Used only when `pool` is omitted, to construct an internal pool                                      |
| `maxPoolSize`      | `number`  | `process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE` or `pg.Pool` default (`10`)              | Optional. Sets the internal `pg.Pool` max size when `createWorld()` creates the pool                |
| `pool`             | `pg.Pool` | Not applicable                                                                         | Optional. When set, used for Drizzle, Graphile Worker, and stream writes. `world.close()` does not end it. |
| `jobPrefix`        | `string`  | `process.env.WORKFLOW_POSTGRES_JOB_PREFIX`                                             | Optional prefix for queue job names                                                                  |
| `queueConcurrency` | `number`  | `50`                                                                                   | Number of concurrent active step executions per process. Must be high enough to cover any parent→child workflow polling in flight because each `Run#returnValue` await holds a worker slot until the child run terminates. |
| `applicationManagedShutdown` | `boolean` | `false`; `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1` enables it for the default package configuration | Whether the application coordinates shutdown and awaits `world.close()` instead of Graphile Worker responding automatically. |

## Environment variables

| Variable                               | Description                                                  | Default                                         |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `WORKFLOW_TARGET_WORLD`                | Set to `"@workflow/world-postgres"` to use this world | -                                               |
| `WORKFLOW_POSTGRES_URL`                | PostgreSQL connection string                                 | `DATABASE_URL` or `'postgres://world:world@localhost:5432/world'` |
| `WORKFLOW_POSTGRES_JOB_PREFIX`         | Prefix for queue job names                                   | -                                               |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | Number of concurrent workers                                 | `50`                                            |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE`      | Internal `pg.Pool` max size                                  | `10`                                            |
| `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN` | Set to `1` when the application coordinates shutdown and awaits `world.close()` | unset (`false`) |
| `WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS` | Maximum Hook minimum retention in days | `30` |

When `pool` is omitted, `maxPoolSize` precedence is: `createWorld({ maxPoolSize })`, then `WORKFLOW_POSTGRES_MAX_POOL_SIZE`, then the `pg.Pool` default.

For higher worker concurrency, Graphile Worker recommends setting `maxPoolSize` to `10` or `queueConcurrency + 2`, whichever is larger.

## Database setup

This package uses PostgreSQL with the following components:

- **Graphile Worker**: For queue processing and job management
- **Drizzle ORM**: For database operations and schema management
- **pg** (node-postgres): For PostgreSQL client connections. Drizzle and Graphile Worker share a `pg.Pool`, while LISTEN uses a dedicated `pg.Client` created from the same connection options.

### Quick setup with CLI

Set up your database with the included CLI tool:

```bash
# npm
npx --package=@workflow/world-postgres bootstrap

# pnpm
pnpm dlx --package @workflow/world-postgres bootstrap

# Yarn
yarn dlx --package @workflow/world-postgres bootstrap

# Bun
bunx --package @workflow/world-postgres bootstrap
```

The CLI and runtime World automatically load the connection string from:
1. `WORKFLOW_POSTGRES_URL` environment variable
2. `DATABASE_URL` environment variable
3. Default: `postgres://world:world@localhost:5432/world`

### Database schema

The setup creates the following tables:

- `workflow_runs`: Stores workflow execution runs
- `workflow_events`: Stores workflow events
- `workflow_steps`: Stores individual workflow steps
- `workflow_hooks`: Stores webhook hooks
- `workflow_stream_chunks`: Stores streaming data chunks

You can also access the schema programmatically:

```typescript
import { runs, events, steps, hooks, streams } from '@workflow/world-postgres';
// or
import * as schema from '@workflow/world-postgres/schema';
```

Make sure your PostgreSQL database is accessible and the user has sufficient permissions to create tables and manage jobs.

### Data retention

Postgres World does not yet perform general workflow-run cleanup. After a
retained Hook's run ends and its deadline passes, reads treat the Hook as absent
and its token can be reused. If the token is never reused, the expired
`workflow_hooks` row remains.

## Features

- **Durable storage**: Stores workflow runs, events, steps, hooks, and webhooks in PostgreSQL
- **Queue processing**: Uses Graphile Worker as the durable queue and executes jobs over the workflow HTTP routes
- **Durable delays**: Reschedules waits and retries in PostgreSQL
- **Streaming**: Real-time event streaming capabilities
- **Health checks**: Built-in connection health monitoring
- **Configurable concurrency**: Adjustable worker concurrency for queue processing

## Queue behavior

- Graphile jobs are acknowledged only after execution finishes, or after the worker durably schedules a delayed follow-up job
- Backlog stays in PostgreSQL when all execution slots are busy
- Retry and sleep-style delays use Graphile `runAt` scheduling
- Workflow orchestration and queued step execution are both sent through `/.well-known/workflow/v1/flow`

### Experimental synchronous invocation

Enable `WORKFLOW_POSTGRES_INVOKE=1` when loading the World through
`WORKFLOW_TARGET_WORLD`, or pass `enableInvoke: true` to `createWorld()`.
The default is off. Apply database migrations before running the upgraded World
(also when invoke is disabled: hook deduplication and purge use new columns). Use
matching upgraded application workers sharing the same job prefix/namespace.

This advertises `world.capabilities.invoke` and implements the optional
`world.invoke(runId, payload, { idempotencyKey?, timeoutMs? })` operation.
`resumeHook()` then sends a serialized input to the executor instead of writing
the event in the caller. The executor validates the hook, awaits its event-log
write, and responds. A response does not mean the workflow has consumed the input.
Unsupported Worlds keep the existing hook-write/queue-wake path.

The World calls the normal SDK handler with `{ runId, invoke: true, requestId,
input }`. The SDK returns a value; the Postgres wrapper stores it for the caller.
Mailbox iteration and response storage are entirely backend-private. There is
no exported World invocation feed or `respond()` callback. Invocation returns
are data (even if they contain `timeoutSeconds`); only normal wake returns use
that field as queue control.

Postgres stores inputs and responses in `workflow.workflow_invocations`. Input
insertion and enqueueing an executor wake share one transaction. **Every invoke
enqueues a wake**, even when retrying an input whose response is already stored;
such a wake may find no additional work. It still checks durable run state because
the previous executor may have died after responding but before replaying the
committed event. A repeated idempotency key must carry
identical input. Without a key, every call is a new input.

There are two Graphile **task identifiers** with the default job prefix:

- `workflow_flows_executor`: workflow orchestration wakes. These set Graphile's
  named `queueName` to `workflow_flows:<runId>:executor`, allowing one active
  executor job per run across worker instances.
- `workflow_flows`: step execution and health checks. These remain parallel and
  are not placed behind the run's executor job.

`queueConcurrency` remains the overall per-process worker-slot limit (default
50); it is not changed to 1. Different runs can execute concurrently. An executor
stays unacknowledged while the World delivers inputs alongside existing
workflow execution. Input admission is serviced while inline steps wait. Node
VM retention remains bounded by existing replay boundaries and the executor's
idle window; a later executor may use another process and replay.

Only verified executor deliveries start mailbox service. The executor task
checks Graphile's actual named queue, then forwards its job ID, worker ID and
attempt through private HTTP headers. The HTTP receiver checks those against
Graphile's public `jobs` view: the job must still be locked, have the executor
task identifier, and belong to this run's exact named queue. Supplied application
headers cannot override this delivery metadata. Steps and health checks never
drain the mailbox.

Ordinary/legacy orchestration jobs picked up by updated workers are durably moved
to the executor task before acknowledgement, rather than executed immediately.
The transfer preserves payload/message identity and the known remaining attempt
budget. Updated HTTP receivers similarly reroute unmarked legacy orchestration
requests. Invalid or inactive executor metadata is rejected before reading the
mailbox. Older binaries that have not been upgraded cannot enforce these checks.
This verifies the delivery's role at entry; it is not continuous fencing of an
already-running handler and does not change the stale-handler limitation below.

The private mailbox reader loads pending rows in pages of 32. Input delivery and response
waiting use `LISTEN/NOTIFY`, sharing one lazily opened dedicated connection per
World instance. Notifications carry fixed-size hashed identifiers, not payloads
or results. Input notifications commit with insertion/wake scheduling; result
notifications commit with the response update. Waiters always read the table,
and a revision captured before each read prevents missing a notification that
arrives during the query. Completing/reestablishing LISTEN also wakes waiters
to cover writes committed before subscription.

A 1-second fallback read handles missing notifications or unavailable LISTEN.
Listener errors/disconnects wake waiters and permit reconnect after a 1-second
backoff. The listener needs a session-capable connection (for example, transaction
pooling alone cannot provide reliable LISTEN); fallback reads preserve progress.
Degradation and restoration are logged once per state transition to stderr,
without connection details or payloads; repeated failed retries do not spam logs.
Invoke defaults to a 30-second response timeout
(overridable with `timeoutMs`). A timeout leaves the input pending and does not
undo execution. Encoded input and result size are each limited to 1 MiB. Closing
the World aborts local response waits and closes its input feeds and listener.

Event writes and response writes remain **sequential, not atomic**. Postgres now
implements the existing `hookResumeDedup` capability: a unique durable resume ID
and payload digest make the hook-event write idempotent. A response-storage retry
converges on that event even after hook disposal or run completion. A changed
payload under the same identity is rejected. This is not an exactly-once guarantee
for arbitrary step side effects.

`$retention: 0` purges invocation inputs, results and fingerprints with the run's
other user data. An expiry tombstone lets waiting callers/retries receive
`INVOCATION_DATA_EXPIRED` (410), rather than wait indefinitely. Mailbox writers
lock/recheck the run so late inputs and responses cannot restore purged data.
If the run expires before its response can be read, that invocation may return
the expiry error even though its hook event committed. Other results currently
remain in the table without automatic cleanup. Graphile serialization
does not fence an old HTTP handler after an aborted/reclaimed delivery, and it
does not route heterogeneous code versions to the correct deployment. These are
limitations of this experimental mode; no new World acquisition API is added.

The invocation migration also clears mailbox data belonging to runs already
expired or terminal with zero retention, including rows from an earlier preview.

The real-database invocation tests use the built core runtime. Build it before
running `pnpm exec vitest run test/invoke.test.ts` in this package.

## Development

For local development, you can use the included Docker Compose configuration:

```bash
# Start PostgreSQL database
docker-compose up -d

# Create and run migrations
pnpm drizzle-kit generate
pnpm drizzle-kit migrate

# Set environment variables for local development
export WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:5432/world"
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```

## Testing

Integration tests use [Testcontainers](https://testcontainers.com/) to start a PostgreSQL container. **Docker must be installed and running** before you run tests.

- **Linux/macOS**: Start the Docker daemon (e.g. `sudo systemctl start docker` or Docker Desktop).
- **WSL2**: Use Docker Desktop with WSL2 integration, or run the Docker engine inside WSL and ensure the daemon is started. Verify with `docker info`.

Then from the package directory:

```bash
pnpm build
pnpm test
```

## World selection

To use the PostgreSQL world, set the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```
