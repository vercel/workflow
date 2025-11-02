# AWS World Implementation

This directory contains a complete implementation of the Workflow `World` interface for AWS using DynamoDB, SQS, Lambda, and S3.

## Architecture

The World implementation is split into several modules:

- **config.ts** - Configuration management
- **storage.ts** - DynamoDB storage for runs, steps, events, and hooks
- **queue.ts** - SQS queue management and worker polling
- **streamer.ts** - S3 + DynamoDB streaming implementation
- **index.ts** - Main entry point that combines all components

## Usage

### 1. Deploy Infrastructure

First, deploy the AWS infrastructure using CDK:

```bash
npm install
./scripts/deploy.sh
```

Save the output values (table names, queue URLs, bucket name).

### 2. Set Environment Variables

```bash
export AWS_REGION="us-east-1"
export WORKFLOW_AWS_RUNS_TABLE="workflow_runs"
export WORKFLOW_AWS_STEPS_TABLE="workflow_steps"
export WORKFLOW_AWS_EVENTS_TABLE="workflow_events"
export WORKFLOW_AWS_HOOKS_TABLE="workflow_hooks"
export WORKFLOW_AWS_STREAMS_TABLE="workflow_stream_chunks"
export WORKFLOW_AWS_STREAM_BUCKET="workflow-streams-123456789012-us-east-1"
export WORKFLOW_AWS_WORKFLOW_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123456789012/workflow-flows"
export WORKFLOW_AWS_STEP_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123456789012/workflow-steps"
```

### 3. Use in Your Application

```typescript
import { createWorld } from './lib/world/index.js';

// Create the world instance
const world = createWorld();

// Start the queue workers (important!)
await world.start();

// Now you can use the world in your workflows
const run = await world.runs.create({
  workflowName: 'my-workflow',
  workflowVersion: '1.0.0',
  input: { foo: 'bar' },
});

console.log('Created run:', run.runId);
```

### 4. Integration with Workflow DevKit

To use this as your workflow backend, configure your application:

```typescript
import { createWorkflow } from '@workflow/core';
import { createWorld } from './lib/world/index.js';

const world = createWorld();
await world.start();

// Define your workflow
const myWorkflow = createWorkflow('my-workflow', async (input) => {
  // Your workflow logic here
  return { result: 'success' };
});

// Use the world for execution
// (The core library will use the world you provide)
```

## How It Works

### Storage (DynamoDB)

All workflow data is stored in DynamoDB tables:
- **workflow_runs**: Workflow execution metadata
- **workflow_steps**: Individual step executions  
- **workflow_events**: Event log for auditing
- **workflow_hooks**: Webhook configurations
- **workflow_stream_chunks**: Stream metadata

Each table uses ULID-based IDs for ordering and includes GSIs for efficient queries.

### Queue (SQS)

Workflow and step executions are queued to SQS:
- **workflow-flows**: Workflow invocations
- **workflow-steps**: Step executions

The queue implementation:
1. Sends messages to SQS with deduplication
2. Long-polls for new messages (20s)
3. Processes messages using embedded world
4. Deletes successful messages
5. Allows failed messages to retry (visibility timeout)

### Streaming (S3 + DynamoDB)

Streams use a hybrid approach:
- **S3**: Stores actual chunk data
- **DynamoDB**: Stores chunk metadata and ordering

Flow:
1. `writeToStream()` uploads data to S3 and metadata to DynamoDB
2. `readFromStream()` queries DynamoDB for chunks, then fetches from S3
3. `closeStream()` writes an EOF marker

## Configuration Options

You can customize the world by passing a config object:

```typescript
const world = createWorld({
  region: 'us-west-2',
  tables: {
    runs: 'custom_runs_table',
    steps: 'custom_steps_table',
    events: 'custom_events_table',
    hooks: 'custom_hooks_table',
    streams: 'custom_streams_table',
  },
  queues: {
    workflow: 'https://sqs.us-west-2.amazonaws.com/...',
    step: 'https://sqs.us-west-2.amazonaws.com/...',
  },
  streamBucket: 'my-streams-bucket',
  credentials: {
    accessKeyId: 'YOUR_ACCESS_KEY',
    secretAccessKey: 'YOUR_SECRET_KEY',
  },
});
```

If not provided, values are read from environment variables.

## Production Considerations

1. **Queue Workers**: In production, run workers in separate processes/containers
2. **Scaling**: DynamoDB tables use on-demand billing by default (can switch to provisioned)
3. **Monitoring**: Enable CloudWatch metrics and X-Ray tracing
4. **Security**: Use IAM roles instead of access keys when running on AWS
5. **Streams**: Current implementation polls DynamoDB; consider DynamoDB Streams for real-time updates

## License

MIT

