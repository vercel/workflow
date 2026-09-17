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

Enable synchronous hook-input delivery with `WORKFLOW_POSTGRES_INVOKE=1` when
using `WORKFLOW_TARGET_WORLD`, or pass `enableInvoke: true` to `createWorld()`.
Invocation is off by default.

Apply the database migrations before running the upgraded World, including when
invocation is disabled, because hook deduplication and data purging use new
columns. Upgrade producers and workers together, using matching versions and the
same job prefix and namespace. Migration 0022 versions stored responses so values
from earlier previews keep their original meaning.

With invocation enabled, the World advertises `capabilities.invoke`.
`resumeHook()` sends the hook input to the run's executor, which validates the
input, writes the hook event, and responds. The response confirms that processing
has finished; workflow user code may consume the event later.

The World calls the SDK handler with `{ runId, invoke: true, requestId, input }`
and stores its response as an `InvocationOutcome`. `invoke()` returns the value
or throws the restored Workflow error with its diagnostic fields. Invocation
results are response data, including any `timeoutSeconds` property.

A terminal error, such as a missing hook or an input-identity conflict, is stored
as the request's outcome. Retrying that identity returns the stored error while
the result is retained. Transient or unrecognized failures leave the input pending
and cause Graphile to retry the workflow execution job. Failure to store or read
a response leaves the caller's outcome unknown. Earlier event writes may have
committed in either case.

Postgres stores inputs and responses in `workflow.workflow_invocations`. The
input is inserted into `workflow_invocations` and a request is enqueued in
Graphile in the same transaction. Retrying a retained input also enqueues a
workflow execution request, even when its response is already stored. This lets
the runner check committed events if a previous runner stopped after responding
but before replaying them.

Reuse an `idempotencyKey` with the same payload when retrying an invocation.
Without a key, each call creates a new input.

With invocation disabled (the default), deliveries for the same run may execute
concurrently. A workflow request can execute a step inline and wait for a hook
wake to abort that step, so the queue cannot hold a per-run lock for the entire
request. Duplicate deliveries with the same idempotency key remain coalesced.

With invocation enabled, each Graphile worker pool registers two task
identifiers. A task identifier selects a handler. A named queue controls which
jobs can execute concurrently. The default job prefix produces these names:

| Task identifier | Work | Named queue |
| --- | --- | --- |
| `workflow_flows_executor` | Start or resume workflow execution | `workflow_flows:<runId>:executor`, one queue per run |
| `workflow_flows` | Step execution and health checks | No run-scoped named queue |

Graphile permits one active job per run's named queue across worker processes.
Different runs, step jobs, and health checks can execute concurrently.
`queueConcurrency` limits the total active Graphile jobs per worker process
across both task identifiers and defaults to **50**.

While a workflow execution job is active, the World passes pending invocation
inputs to the SDK handler, including while inline steps wait. After an execution
returns, the World checks for idle time or an expired 120s input-intake budget.
Before acknowledging the job, the World stops reading new inputs, finishes any
input already being processed, and replays events committed since the previous
replay began. A later job can resume the run in another process.

A workflow execution request is the HTTP request sent by a Graphile
`workflow_flows_executor` job to start or resume a run. An invocation is an input
submitted through `world.invoke()` and stored in `workflow_invocations`. One
workflow execution request can process several invocations.

Before processing pending inputs, the HTTP receiver verifies the execution
request against Graphile's `jobs` view. The worker supplies the job ID, worker ID,
and attempt through private HTTP headers. The receiver requires a locked job
with matching metadata, the executor task identifier, and the run's named queue.
Application-supplied headers cannot replace this metadata. Step jobs and health
checks process their own work without reading pending invocation rows.

Updated workers move legacy orchestration jobs to the executor task before
acknowledging them, preserving message identity and the remaining attempt budget.
Updated HTTP receivers also reroute unmarked legacy requests. Older workers
cannot enforce these checks, so upgrade participating workers together.

Verification happens when the request enters the receiver. A handler that keeps
running after Graphile reclaims its job can still write events; this
implementation does not fence those writes.

The Postgres World reads pending inputs in pages of 32. One dedicated
`LISTEN/NOTIFY` connection per World instance signals new inputs and responses.
The connection opens when needed. Notifications contain hashed identifiers;
readers fetch payloads and results from the table.

Notifications commit with their associated writes. Readers track changes across
each query and reread after subscribing or reconnecting, covering writes that
arrived before the subscription became active.

Use a database connection that supports sessions for `LISTEN`. Transaction
pooling alone cannot maintain that subscription. When notifications are
unavailable, readers poll at 1s intervals and connection retries use a 1s backoff.
The World logs notification failure and recovery once per transition, excluding
payloads and connection details.

| Setting or limit | Value |
| --- | --- |
| Default response-wait timeout | 30s, configurable with `timeoutMs` |
| Maximum encoded input size | 1 MiB |
| Maximum encoded outcome size | 1 MiB |
| Pending-input page size | 32 rows |

A timeout ends the caller's wait without canceling processing or establishing
its outcome. Closing the World aborts local response waits and closes input
readers and the notification connection.

Postgres implements `hookResumeDedup` with a durable resume ID and payload digest.
Retrying the same identity reuses the committed hook event, including after hook
disposal or run completion. Reusing the identity with a different payload is
rejected.

The hook event and response are written in separate operations. If storing the
response fails, deduplication lets a retry recover the event's result. Step code
remains responsible for making its external side effects safe to retry.

`$retention: 0` purges invocation inputs, results, and fingerprints with the run's
other user data. An expiry marker lets waiting callers and retries receive a 410
error with code `INVOCATION_DATA_EXPIRED`. Writers lock and recheck the run so
late writes cannot restore purged data. A caller can receive this expiry error
after its hook event committed if the result expires before the caller reads it.
The migration also clears invocation data for runs that already expired or ended
with zero retention.

The experimental implementation has these remaining limitations:

- Results outside zero-retention purging have no automatic cleanup.
- A handler can continue writing after Graphile aborts or reclaims its job.
- Requests are not routed to a compatible deployment when workers run different code versions.

The database integration tests use the built core runtime. Build core before
running `pnpm exec vitest run test/invoke.test.ts` from `packages/world-postgres`.

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
