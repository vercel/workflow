# @workflow/world-postgres

A PostgreSQL-backed workflow runtime for durable, long-running workflows in JavaScript/TypeScript. Designed for multi-host self-hosted solutions with flexible queue and execution strategies.

## Installation

```bash
npm install @workflow/world-postgres
# or
pnpm add @workflow/world-postgres
# or
yarn add @workflow/world-postgres
```

## Quick Start (Next.js)

Get started in seconds by adding this to your Next.js project:

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const { createWorld } = await import("@workflow/world-postgres");

    const world = createWorld();
    await world.start();
  }
}
```

Set these environment variables:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
export WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"
export WORKFLOW_POSTGRES_SECURITY_TOKEN="your-secret-token-here"
export WORKFLOW_POSTGRES_APP_URL="http://localhost:3000"
```

**⚠️ IMPORTANT**: Always set a strong `WORKFLOW_POSTGRES_SECURITY_TOKEN` in production. This token authenticates queue workers when they call your workflow endpoints and prevents unauthorized access.

That's it! The world will automatically use pg-boss for queuing and HTTP proxy for executing workflows.

## Architecture

This package provides a layered architecture with three key components:

- **Storage**: Persists workflow state in PostgreSQL (runs, events, steps, hooks, streaming chunks). All tables are isolated in their own PostgreSQL schema.
- **Queue Driver**: Manages job queuing and worker orchestration (default: pg-boss, or bring your own)
- **Proxy Strategy**: Determines how jobs are executed (HTTP calls or direct function invocation)

## Execution Patterns

The package supports flexible execution patterns based on two dimensions:

### Queue Strategy
- **Built-in pg-boss** (default): Reliable PostgreSQL-backed job queue
- **Custom queue**: Implement your own queue system (Redis, SQS, RabbitMQ, etc.)

### Proxy Strategy
- **HTTP Proxy**: Workers call workflow endpoints over HTTP (`/.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/step`)
- **Function Proxy**: Workers invoke workflow/step functions directly in-process

### Execution Environment
- **Same Process**: Workers run alongside your application (e.g., in Next.js `instrumentation.ts`)
- **Separate Process**: Dedicated worker process(es) for better isolation and scaling
- **Serverless**: Receive messages from your queue and call a proxy to execute workflows

## Configuration Patterns

### Pattern 1: pg-boss + HTTP Proxy (Default)

The simplest setup - workers make HTTP calls to your application:

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

### Pattern 2: pg-boss + Function Proxy

Workers call workflow functions directly in the same process - better performance, simpler deployment:

```typescript
import { createWorld, createPgBossFunctionProxyQueue } from "@workflow/world-postgres";

// Import entrypoints from your Next.js API routes
import { __wkf_entrypoint as workflowEntrypoint } from './app/.well-known/workflow/v1/flow/route';
import { __wkf_entrypoint as stepEntrypoint } from './app/.well-known/workflow/v1/step/route';

const world = createWorld({
  queueFactory: () =>
    createPgBossFunctionProxyQueue({
      stepEntrypoint,
      workflowEntrypoint,
    }),
});

await world.start();
```

**Required Environment Variables:**
```bash
WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"
WORKFLOW_POSTGRES_SECURITY_TOKEN="your-secret-token-here"
```

**Optional:**
All configuration can be passed programmatically:

```typescript
createPgBossFunctionProxyQueue({
  stepEntrypoint,
  workflowEntrypoint,
  connectionString: "postgres://...",
  securityToken: "your-secret-token",
  jobPrefix: "myapp_",
  queueConcurrency: 10,
})
```

### Pattern 3: Custom Queue Driver

Implement your own queue system for maximum flexibility:

```typescript
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

await world.start();
```

You can use the helper proxies:
- `createHttpProxy({ baseUrl, securityToken })` - for HTTP execution
- `createFunctionProxy({ stepEntrypoint, workflowEntrypoint, securityToken })` - for in-process execution

See `src/queue-drivers/types.ts` for the full `QueueDriver` interface and `MessageData` structure.

## Execution Environment Examples

### Same Process (Next.js instrumentation.ts)

Run workers in the same process as your Next.js application:

```typescript
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const { createWorld, createPgBossFunctionProxyQueue } =
      await import("@workflow/world-postgres");

    const { __wkf_entrypoint: workflowEntrypoint } =
      await import('./app/.well-known/workflow/v1/flow/route');
    const { __wkf_entrypoint: stepEntrypoint } =
      await import('./app/.well-known/workflow/v1/step/route');

    const world = createWorld({
      queueFactory: () =>
        createPgBossFunctionProxyQueue({
          stepEntrypoint,
          workflowEntrypoint,
        }),
    });

    await world.start();
  }
}
```

### Separate Worker Process

Run workers in a dedicated process for better isolation:

```typescript
// worker.ts
import { createWorld, createPgBossHttpProxyQueue } from "@workflow/world-postgres";

const world = createWorld({
  queueFactory: () =>
    createPgBossHttpProxyQueue({
      baseUrl: "http://localhost:3000", // Your app URL
    }),
});

await world.start();
```

Then run: `node worker.ts`

### Serverless

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

- **pg-boss**: For queue processing and job management
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
| `WORKFLOW_POSTGRES_JOB_PREFIX`         | Prefix for queue job names                   | `workflow_`                                     | Optional                   |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | Number of concurrent workers                 | `10`                                            | Optional                   |
| `WORKFLOW_POSTGRES_APP_URL`            | Base URL for HTTP proxy                      | -                                               | Pattern 1 (HTTP proxy)     |
| `WORKFLOW_POSTGRES_APP_PORT`           | Port for HTTP proxy (if URL not provided)    | `3000`                                          | Pattern 1 (HTTP proxy)     |

All environment variables can be overridden by passing configuration programmatically to `createWorld()` or the queue factory functions.

## Features

- **Durable Storage**: Stores workflow runs, events, steps, hooks, and webhooks in PostgreSQL with schema isolation
- **Flexible Queue System**: Use built-in pg-boss or integrate any queue system (Redis, SQS, RabbitMQ, etc.)
- **Multiple Execution Strategies**: HTTP proxy for distributed systems, function proxy for co-located workers
- **Streaming**: Real-time event streaming capabilities
- **Health Checks**: Built-in connection health monitoring
- **Configurable Concurrency**: Adjustable worker concurrency for queue processing
- **Type-Safe**: Full TypeScript support with exported types

## API Reference

### `createWorld(options)`

Creates a workflow world instance with PostgreSQL storage.

**Options:**
- `connectionString?: string` - PostgreSQL connection string (default: `process.env.WORKFLOW_POSTGRES_URL`)
- `securityToken?: string` - Token for authenticating queue workers (default: `process.env.WORKFLOW_POSTGRES_SECURITY_TOKEN`)
- `queueFactory?: () => QueueDriver` - Factory function to create queue driver (default: `createPgBossHttpProxyQueue()`)

**Returns:** World instance with `start()` method

### Built-in Queue Factories

#### `createPgBossHttpProxyQueue(options)`

Creates a pg-boss queue driver with HTTP proxy execution.

**Options:**
- `connectionString?: string`
- `securityToken?: string`
- `jobPrefix?: string`
- `queueConcurrency?: number`
- `port?: number`
- `baseUrl?: string`

#### `createPgBossFunctionProxyQueue(options)`

Creates a pg-boss queue driver with direct function call execution.

**Options:**
- `stepEntrypoint: (request: Request) => Promise<Response>` - Required
- `workflowEntrypoint: (request: Request) => Promise<Response>` - Required
- `connectionString?: string`
- `securityToken?: string`
- `jobPrefix?: string`
- `queueConcurrency?: number`

### Proxy Helpers

#### `createHttpProxy(options)`

Creates an HTTP proxy for executing workflows via HTTP calls.

**Options:**
- `baseUrl?: string` - Base URL of your application
- `port?: number` - Port (if baseUrl not provided)
- `securityToken: string` - Security token for authentication

#### `createFunctionProxy(options)`

Creates a function proxy for executing workflows via direct function calls.

**Options:**
- `stepEntrypoint: (request: Request) => Promise<Response>` - Required
- `workflowEntrypoint: (request: Request) => Promise<Response>` - Required
- `securityToken: string` - Security token for authentication

## TypeScript Support

All public APIs are fully typed. Import types from the package:

```typescript
import type {
  QueueDriver,
  MessageData,
  WkfProxy,
  PostgresWorldConfig
} from "@workflow/world-postgres";
```

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
