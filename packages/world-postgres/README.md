# @workflow/world-postgres

An embedded worker/workflow system backed by PostgreSQL for multi-host self-hosted solutions. This is a reference implementation - a production-ready solution might run workers in separate processes with a more robust queuing system.

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

The postgres world can be configured by setting the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

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
```

### Programmatic Usage

You can also create a PostgreSQL world directly in your code:

<!-- @skip-typecheck: incomplete code sample -->
```typescript
import { createWorld } from "@workflow/world-postgres";

const world = createWorld({
  connectionString: "postgres://username:password@localhost:5432/database",
  jobPrefix: "myapp", // optional
  queueConcurrency: 10, // optional
});
```

## Configuration Options

| Option             | Type     | Default                                                                                | Description                         |
| ------------------ | -------- | -------------------------------------------------------------------------------------- | ----------------------------------- |
| `connectionString` | `string` | `process.env.WORKFLOW_POSTGRES_URL` or `'postgres://world:world@localhost:5432/world'` | PostgreSQL connection string        |
| `jobPrefix`        | `string` | `process.env.WORKFLOW_POSTGRES_JOB_PREFIX`                                             | Optional prefix for queue job names |
| `queueConcurrency` | `number` | `10`                                                                                   | Number of concurrent queue workers  |

## Environment Variables

| Variable                               | Description                                                  | Default                                         |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `WORKFLOW_TARGET_WORLD`                | Set to `"@workflow/world-postgres"` to use this world | -                                               |
| `WORKFLOW_POSTGRES_URL`                | PostgreSQL connection string                                 | `'postgres://world:world@localhost:5432/world'` |
| `WORKFLOW_POSTGRES_JOB_PREFIX`         | Prefix for queue job names                                   | -                                               |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | Number of concurrent workers                                 | `10`                                            |

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

The setup creates the following tables:

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

Make sure your PostgreSQL database is accessible and the user has sufficient permissions to create tables and manage jobs.

## Features

- **Durable Storage**: Stores workflow runs, events, steps, hooks, and webhooks in PostgreSQL
- **Queue Processing**: Uses pg-boss for reliable job queue processing
- **Streaming**: Real-time event streaming capabilities
- **Health Checks**: Built-in connection health monitoring
- **Configurable Concurrency**: Adjustable worker concurrency for queue processing

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

## World Selection

To use the PostgreSQL world, set the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```
