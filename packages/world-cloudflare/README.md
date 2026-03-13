# @workflow/world-cloudflare

A [Workflow DevKit](https://useworkflow.dev) world implementation for Cloudflare Workers, using **Durable Objects** for per-run state, **D1** for cross-run queries, and **Cloudflare Queues** for message dispatch.

## Architecture

- **Durable Objects**: Each workflow run maps to a single Durable Object instance. All run state (events, steps, hooks, waits, stream chunks) lives in the DO's transactional storage.
- **D1 (SQLite)**: A lightweight global index enables cross-run queries like `runs.list()` and `hooks.getByToken()`. The DO writes index updates to D1 after each mutation.
- **Cloudflare Queues**: Workflow and step invocations are dispatched through Cloudflare Queues for reliable, at-least-once delivery.

## Setup

### 1. Install

```bash
pnpm add @workflow/world-cloudflare
```

### 2. Configure bindings

Copy `wrangler.example.toml` and configure your D1 database ID:

```toml
[durable_objects]
bindings = [{ name = "WORKFLOW_RUNS", class_name = "WorkflowRunDO" }]

[[d1_databases]]
binding = "WORKFLOW_DB"
database_name = "workflow"
database_id = "<your-d1-database-id>"

[[queues.producers]]
binding = "WORKFLOW_QUEUE"
queue = "workflow-jobs"

[[queues.consumers]]
queue = "workflow-jobs"
max_batch_size = 10
max_retries = 3
```

### 3. Run D1 migration

```ts
import { migrate } from '@workflow/world-cloudflare/d1';

// Run once during setup or in a migration script
await migrate(env.WORKFLOW_DB);
```

### 4. Create the world

```ts
import { createWorld, WorkflowRunDO } from '@workflow/world-cloudflare';

// Re-export the DO class so Cloudflare can instantiate it
export { WorkflowRunDO };

export default {
  async fetch(request, env) {
    const world = createWorld({
      db: env.WORKFLOW_DB,
      runs: env.WORKFLOW_RUNS,
      queue: env.WORKFLOW_QUEUE,
    });
    // Use world with your workflow runtime...
  },

  async queue(batch, env) {
    const world = createWorld({
      db: env.WORKFLOW_DB,
      runs: env.WORKFLOW_RUNS,
      queue: env.WORKFLOW_QUEUE,
    });
    await world.handleQueueBatch(batch);
  },
};
```

## Limitations

- `events.listByCorrelationId()` requires the `runId` context (inherent to DO-per-run architecture)
- `steps.get()` requires `runId` (cannot look up steps without knowing which DO to query)
- `readFromStream()` expects stream names in `runId:streamName` format

## License

Apache-2.0
