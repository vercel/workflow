# How PostgreSQL World Works

This document explains the architecture and components of the PostgreSQL world implementation for workflow management.

This implementation is using [Drizzle Schema](./src/drizzle/schema.ts) that can be pushed or migrated into your PostgreSQL schema and backed by [node-postgres](https://node-postgres.com/) (`pg`). `createWorld` uses a single `pg.Pool` for Drizzle and graphile-worker (via `pgPool`), and a dedicated `pg.Client` for LISTEN/NOTIFY derived from the same connection options. You may pass your own pool to share query connections with application code.

If you want to use any other ORM, query builder or underlying database client, you should be able to fork this implementation and replace the Drizzle parts with your own.

## Job Queue System

```mermaid
graph LR
    Client --> PG[graphile-worker queue]
    PG --> Worker[Embedded Worker]
    Worker --> Handler[Registered Queue Handler]
    Route[Workflow HTTP route] --> Handler

    PG -.-> F["${prefix}flows<br/>(workflows)"]
    PG -.-> S["${prefix}steps<br/>(steps)"]
```

Jobs include retry logic (3 attempts), idempotency keys, durable delayed rescheduling, and configurable worker concurrency (default: 50).

## Streaming

Real-time data streaming via **PostgreSQL LISTEN/NOTIFY**:

- Stream chunks stored in `workflow_stream_chunks` table
- `pg_notify` triggers sent on writes to `workflow_event_chunk` topic
- Subscribers receive notifications and fetch chunk data
- ULID-based ordering ensures correct sequence
- One long-lived dedicated `LISTEN` client, with an in-process EventEmitter for distributing events to multiple subscribers

## Setup

Call `world.start()` to initialize graphile-worker utilities and migrations. Startup can durably enqueue work before the application HTTP listener is accepting connections.

Graphile workers begin consuming jobs after the generated workflow route registers its queue handler. When a job arrives, the worker deserializes the queue payload, resolves the handler registered for the job's queue at execution time, calls it directly in-process, and awaits completion before acknowledging the Graphile job. Resolving per job means handlers registered later (for example a lazily loaded step route) are picked up without restarting the worker.

If `world.start()` runs before the generated route module has loaded, the queue probes `/.well-known/workflow/v1/flow?__health` in the background. That probe lets the application finish binding its HTTP listener, then loads the route so it can register the in-process handler. A job whose queue has no handler yet triggers the same probe for its route and is durably re-added with a short delay, so it executes once registration catches up.

When the runtime returns `{ timeoutSeconds }`, the worker schedules a new Graphile job with a future `runAt` time before finishing the current task.

The generated HTTP routes still use the same queue handler wrapper for external route requests. Embedded Graphile workers do not fetch loopback workflow URLs; explicit `WORKFLOW_LOCAL_BASE_URL` worker processes keep using those routes as a remote execution fallback.


In **Next.js**, add the `world.start()` call to `instrumentation.ts|js` so Graphile is initialized and active runs are re-enqueued during application startup. Use `workflow/runtime` for `getWorld` (same as the testing server and other framework plugins):

```ts
// instrumentation.ts

if (process.env.NEXT_RUNTIME !== "edge") {
  import("workflow/runtime").then(async ({ getWorld }) => {
    // start listening to the jobs.
    const world = await getWorld();
    await world.start?.();
  });
}
```
