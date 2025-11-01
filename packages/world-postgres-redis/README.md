# @workflow/world-postgres-redis

An embedded worker/workflow system backed by PostgreSQL for durable storage and Redis for queue and streaming for multi-host self-hosted solutions. This is a reference implementation - a production-ready solution might run workers in separate processes with a more robust queuing system.

## Installation

```bash
npm install @workflow/world-postgres-redis
# or
pnpm add @workflow/world-postgres-redis
# or
yarn add @workflow/world-postgres-redis
```

## Usage

### Basic Setup

The postgres-redis world can be configured by setting the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres-redis"
```

### Configuration

Configure the PostgreSQL + Redis world using environment variables:

```bash
# Required: PostgreSQL connection string
export WORKFLOW_POSTGRES_URL="postgres://username:password@localhost:5432/database"

# Optional: Job prefix for queue operations
export WORKFLOW_POSTGRES_JOB_PREFIX="myapp"

# Optional: Worker concurrency (default: 10)
export WORKFLOW_POSTGRES_WORKER_CONCURRENCY="10"

# Redis connection (optional, defaults to localhost)
export WORKFLOW_REDIS_URL="redis://127.0.0.1:6379"
```

### Programmatic Usage

You can also create a PostgreSQL + Redis world directly in your code:

```typescript
import { createWorld } from "@workflow/world-postgres-redis";

const world = createWorld({
  connectionString: "postgres://username:password@localhost:5432/database",
  jobPrefix: "myapp", // optional
  queueConcurrency: 10, // optional
  // Redis URL configured via WORKFLOW_REDIS_URL environment variable
});
```

## Configuration Options

| Option             | Type     | Default                                                                                | Description                         |
| ------------------ | -------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| `connectionString` | `string` | `process.env.WORKFLOW_POSTGRES_URL` or `'postgres://world:world@localhost:5432/world'` | PostgreSQL connection string        |
| `jobPrefix`        | `string` | `process.env.WORKFLOW_POSTGRES_JOB_PREFIX`                                             | Optional prefix for queue job names |
| `queueConcurrency` | `number` | `10`                                                                                   | Number of concurrent queue workers  |

Note: Redis URL is configured via the `WORKFLOW_REDIS_URL` environment variable (default: `redis://127.0.0.1:6379`).

## Environment Variables

| Variable                               | Description                                                  | Default                                         |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `WORKFLOW_TARGET_WORLD`                | Set to `"@workflow/world-postgres-redis"` to use this world   | -                                               |
| `WORKFLOW_POSTGRES_URL`                | PostgreSQL connection string                                 | `'postgres://world:world@localhost:5432/world'` |
| `WORKFLOW_POSTGRES_JOB_PREFIX`         | Prefix for queue job names                                   | -                                               |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | Number of concurrent workers                                  | `10`                                            |
| `WORKFLOW_REDIS_URL`                   | Redis connection string                                      | `'redis://127.0.0.1:6379'`                      |

## Database Setup

This package uses PostgreSQL and Redis with the following components:

- **Redis Lists + Pub/Sub**: For queue processing and job management
- **Redis Streams**: For real-time chunk streaming
- **Drizzle ORM**: For database operations and schema management
- **postgres**: For PostgreSQL client connections

Make sure your PostgreSQL database is accessible and the user has sufficient permissions to create tables. Redis should be running and accessible for queue and streaming operations.

## Features

- **Durable Storage**: Stores workflow runs, events, steps, hooks, and webhooks in PostgreSQL
- **Queue Processing**: Uses Redis lists with pub/sub notifications for reliable job queue processing
- **Streaming**: Real-time event streaming capabilities
- **Health Checks**: Built-in connection health monitoring
- **Configurable Concurrency**: Adjustable worker concurrency for queue processing

## Development

For local development, you can use the included Docker Compose configuration:

```bash
# Start PostgreSQL and Redis
docker-compose up -d

# Create and run migrations
pnpm drizzle-kit generate
pnpm drizzle-kit migrate

# Set environment variables for local development
export WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:5432/world"
export WORKFLOW_REDIS_URL="redis://127.0.0.1:6379"
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres-redis"
```

## World Selection

To use the PostgreSQL + Redis world, set the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres-redis"
```