# @workflow/world-postgres

An embedded worker/workflow system backed by PostgreSQL for multi-host self-hosted solutions

## Installation

```bash
npm install @workflow/world-postgres
# or
pnpm add @workflow/world-postgres
# or
yarn add @workflow/world-postgres
```

## Usage

### Basic Setup

The postgres world can be configured by setting the WORKFLOW_TARGET_WORLD environment variable to the package name.

```bash
WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```

### Configuration

Configure the PostgreSQL world using environment variables:

```bash
WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"
WORKFLOW_POSTGRES_SECURITY_TOKEN="your-secret-token-here"
WORKFLOW_POSTGRES_APP_URL="http://localhost:3000"
```

### Programmatic Usage

You can also create a PostgreSQL world directly in your code:

```typescript
import { createWorld, createPgBossHttpProxyQueue } from "@workflow/world-postgres";

const world = createWorld({
  connectionString: "postgres://username:password@localhost:5432/database",
  securityToken: "your-secret-token-here",
  queueFactory: createPgBossHttpProxyQueue({
    jobPrefix: "my-app",
    queueConcurrency: 10,
  }) 
});
```

**⚠️ IMPORTANT**: Always set a strong `WORKFLOW_POSTGRES_SECURITY_TOKEN` in production. This token authenticates queue workers when they call your workflow endpoints and prevents unauthorized access.

## Architecture

The package supports flexible queues and execution patterns, letting you choose how jobs are queued and where the steps and workflows execution will be happen.

### Queue Strategy
- **pg-boss** (default): Reliable PostgreSQL-backed job queue
- **Graphile Worker**: PostgreSQL queue using native LISTEN/NOTIFY for lower latency
- **Custom queue**: Implement your own queue system (Redis, SQS, RabbitMQ, etc.)

### Execution Proxy Strategy
- **HTTP Proxy**: Workers call workflow endpoints over HTTP (`/.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/step`)
- **Function Proxy**: Workers invoke workflow/step functions directly in-process

### Execution Environment
- **Same Process**: Workers run alongside your application (e.g., in Next.js `instrumentation.ts`)
- **Separate Process**: Dedicated worker process(es) for better isolation and scaling
- **Serverless**: Receive messages from your queue and call a proxy to execute workflows

## Advanced Usage

### pg-boss + HTTP Proxy (Default)

The simplest setup - jobs are queued usning pg-boss and workers make HTTP calls to your application:

```typescript
import { createWorld } from "@workflow/world-postgres";

const world = createWorld();
await world.start();
```

**Required Environment Variables:**
```bash
WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"
WORKFLOW_POSTGRES_SECURITY_TOKEN="your-secret-token-here"
WORKFLOW_POSTGRES_APP_URL="http://localhost:3000"
```

**Optional Environment Variables:**
```bash
WORKFLOW_POSTGRES_JOB_PREFIX="myapp_"
WORKFLOW_POSTGRES_WORKER_CONCURRENCY="10"
```

**Programmatic Configuration:**
```typescript
const world = createWorld({
  connectionString: "postgres://...",
  securityToken: "your-secret-token",
});
```

### pg-boss + Function Proxy

Jobs are using pg-boss and workers directly call workflow functions in the same process

```typescript
const { setWorld } = await import('workflow/runtime');
import { createWorld, createPgBossFunctionProxyQueue } from "@workflow/world-postgres";

// Import entrypoints from your framework API routes
import { __wkf_entrypoint as workflowEntrypoint } from './app/.well-known/workflow/v1/flow/route';
import { __wkf_entrypoint as stepEntrypoint } from './app/.well-known/workflow/v1/step/route';

const world = createWorld({
  queueFactory: () =>
    createPgBossFunctionProxyQueue({
      stepEntrypoint,
      workflowEntrypoint,
    }),
});

setWorld(world);

await world.start();
```

### Graphile Worker + HTTP Proxy

Use Graphile Worker for lower latency job processing via PostgreSQL LISTEN/NOTIFY:

```bash
WORKFLOW_QUEUE_DRIVER=graphile
```

Or programmatically:

```typescript
import { createWorld, createGraphileWorkerHttpProxyQueue } from "@workflow/world-postgres";

const world = createWorld({
  queueFactory: createGraphileWorkerHttpProxyQueue,
});

await world.start();
```

### Custom Queue Driver + HTTP Proxy

Implement your own queue system for maximum flexibility:

```typescript
const { setWorld } = await import('workflow/runtime');
import { createWorld } from "@workflow/world-postgres";
import type { QueueDriver, MessageData } from "@workflow/world-postgres/queue-drivers/types";

const myCustomQueue: QueueDriver = {
  pushStep: async (message: MessageData) => {
    // Push step execution message to your queue
    await myQueue.push('steps', message);
  },

  pushFlow: async (message: MessageData) => {
    // Push workflow execution message to your queue
    await myQueue.push('workflows', message);
  },

  start: async () => {
    // Start consuming from your queue and execute via proxy
    const proxy = createHttpProxy({
      baseUrl: 'http://localhost:3000',
      securityToken: process.env.WORKFLOW_POSTGRES_SECURITY_TOKEN!,
    });

    await myQueue.consume('steps', async (message) => {
      await proxy.proxyStep(message);
    });

    await myQueue.consume('workflows', async (message) => {
      await proxy.proxyWorkflow(message);
    });
  },
};

const world = createWorld({
  queueFactory: () => myCustomQueue,
});

setWorld(world);

await world.start();
```

### Serverless execution

In a serverless environment, receive messages from your queue and execute them via proxy:

```typescript
// queue-handler.ts
import { createHttpProxy } from "@workflow/world-postgres";
import type { MessageData } from "@workflow/world-postgres/queue-drivers/types";

const proxy = createHttpProxy({
  baseUrl: process.env.APP_URL,
  securityToken: process.env.SECURITY_TOKEN,
});

export async function handleQueueMessage(message: MessageData) {
  // Determine if it's a step or workflow
  if (message.queueName.includes('step')) {
    await proxy.proxyStep(message);
  } else {
    await proxy.proxyWorkflow(message);
  }
}
```

## Database Setup

This package uses PostgreSQL with the following components:

- **pg-boss** or **Graphile Worker**: For queue processing and job management
- **Drizzle ORM**: For database operations and schema management
- **postgres**: For PostgreSQL client connections

### Quick Setup with CLI

The easiest way to set up your database is using the included CLI tool:

```bash
pnpm exec workflow-postgres-setup
# or
npm exec workflow-postgres-setup
```

The CLI automatically loads `.env` files and will use the connection string from:
1. `WORKFLOW_POSTGRES_URL` environment variable
2. `DATABASE_URL` environment variable
3. Default: `postgres://world:world@localhost:5432/world`

### Database Schema

All workflow data is stored in its own PostgreSQL schema, keeping it isolated from your application data. The setup creates the following tables:

- `workflow_runs` - Stores workflow execution runs
- `workflow_events` - Stores workflow events
- `workflow_steps` - Stores individual workflow steps
- `workflow_hooks` - Stores webhook hooks
- `workflow_stream_chunks` - Stores streaming data chunks

You can also access the schema programmatically:

```typescript
import { runs, events, steps, hooks, streams } from '@workflow/world-postgres';
// or
import * as schema from '@workflow/world-postgres/schema';
```

Make sure your PostgreSQL database is accessible and the user has sufficient permissions to create schemas, tables, and manage jobs.

## Environment Variables Reference

| Variable                               | Description                                  | Default                                         | Required For               |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------- | -------------------------- |
| `WORKFLOW_TARGET_WORLD`                | Package name to use as workflow world        | -                                               | All patterns               |
| `WORKFLOW_POSTGRES_URL`                | PostgreSQL connection string                 | `postgres://world:world@localhost:5432/world`   | All patterns               |
| `WORKFLOW_POSTGRES_SECURITY_TOKEN`     | Security token for queue worker auth         | `secret`                                        | **Required in production** |
| `WORKFLOW_QUEUE_DRIVER`                | Queue driver to use (`pgboss` or `graphile`) | `pgboss`                                        | Optional                   |
| `WORKFLOW_POSTGRES_JOB_PREFIX`         | Prefix for queue job names                   | `workflow_`                                     | Optional                   |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | Number of concurrent workers                 | `10`                                            | Optional                   |
| `WORKFLOW_POSTGRES_APP_URL`            | Base URL for HTTP proxy                      | -                                               | Pattern 1 (HTTP proxy)     |
| `WORKFLOW_POSTGRES_APP_PORT`           | Port for HTTP proxy (if URL not provided)    | `3000`                                          | Pattern 1 (HTTP proxy)     |

All environment variables can be overridden by passing configuration programmatically to `createWorld()` or the queue factory functions.

## Features

- **Durable Storage**: Stores workflow runs, events, steps, hooks, and webhooks in PostgreSQL with schema isolation
- **Flexible Queue System**: Choose between pg-boss (polling), Graphile Worker (LISTEN/NOTIFY), or custom queue
- **Multiple Execution Strategies**: HTTP proxy for distributed systems, function proxy for co-located workers
- **Streaming**: Real-time event streaming capabilities
- **Health Checks**: Built-in connection health monitoring
- **Configurable Concurrency**: Adjustable worker concurrency for queue processing
- **Type-Safe**: Full TypeScript support with exported types

## Development

For local development, you can use the included Docker Compose configuration:

```bash
# Start PostgreSQL database
docker-compose up -d

# Run database setup
pnpm exec workflow-postgres-setup

# Set environment variables for local development
export WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:5432/world"
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```

### Creating Migrations

```bash
pnpm drizzle-kit generate --dialect=postgresql --schema=./src/drizzle/schema.ts --out src/drizzle/migrations
```

## License

See [LICENSE.md](./LICENSE.md)
