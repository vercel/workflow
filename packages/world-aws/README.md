# @workflow/world-aws

An AWS World implementation for the [Workflow DevKit](https://useworkflow.dev), using **DynamoDB** for storage and **SQS** for message queuing.

## Architecture

This package uses AWS managed services to provide a production-ready, serverless-compatible World backend:

| Concern | AWS Service | Details |
|---------|-------------|---------|
| **Storage** | DynamoDB | All entities (runs, events, steps, hooks, waits, stream chunks) are stored in DynamoDB tables with on-demand billing |
| **Queue** | SQS | Standard queues with per-message delay (up to 15 min) for workflow and step invocations |
| **Streaming** | DynamoDB | Stream chunks stored in DynamoDB with polling-based real-time delivery |

### Why SQS over Postgres-backed queues?

- **Fully managed** - No connection pools, no worker processes to manage
- **Per-message delay** - Native support for delayed delivery (up to 15 minutes), useful for step retries
- **Elastic scaling** - Automatically scales with traffic, no need to provision workers
- **Dead letter queues** - Built-in support for failed message routing

## Installation

```bash
npm install @workflow/world-aws
# or
pnpm add @workflow/world-aws
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `us-east-1` |
| `WORKFLOW_AWS_TABLE_PREFIX` | DynamoDB table name prefix | `workflow` |
| `WORKFLOW_AWS_SQS_WORKFLOW_QUEUE_URL` | SQS queue URL for workflow invocations | (required) |
| `WORKFLOW_AWS_SQS_STEP_QUEUE_URL` | SQS queue URL for step invocations | (required) |
| `WORKFLOW_AWS_QUEUE_CONCURRENCY` | Max concurrent message processing | `10` |
| `WORKFLOW_AWS_POLL_INTERVAL_MS` | SQS polling interval (ms) | `1000` |
| `WORKFLOW_AWS_DYNAMODB_ENDPOINT` | Custom DynamoDB endpoint (for local dev) | - |
| `WORKFLOW_AWS_SQS_ENDPOINT` | Custom SQS endpoint (for local dev) | - |

### Programmatic Configuration

```typescript
import { createWorld } from '@workflow/world-aws';

const world = createWorld({
  region: 'us-west-2',
  tablePrefix: 'myapp',
  sqsWorkflowQueueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789/myapp-workflows',
  sqsStepQueueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789/myapp-steps',
  queueConcurrency: 20,
});
```

## Setup

### 1. Create DynamoDB Tables

Run the setup CLI to create all required DynamoDB tables:

```bash
npx workflow-aws-setup
```

This creates six tables with on-demand (PAY_PER_REQUEST) billing:
- `{prefix}_runs` - Workflow run entities
- `{prefix}_events` - Append-only event log
- `{prefix}_steps` - Step entities
- `{prefix}_hooks` - Webhook/notification hooks
- `{prefix}_waits` - Durable delay/sleep tracking
- `{prefix}_streams` - Streaming output chunks

### 2. Create SQS Queues

Create two standard SQS queues in your AWS account:

```bash
aws sqs create-queue --queue-name myapp-workflows
aws sqs create-queue --queue-name myapp-steps
```

Set the queue URLs in your environment or configuration.

### 3. IAM Permissions

The following IAM permissions are required:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable",
        "dynamodb:CreateTable"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/workflow_*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:*:*:myapp-*"
    }
  ]
}
```

## Local Development

For local development, use [LocalStack](https://localstack.cloud/) or [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html):

```bash
# Start LocalStack
docker run -d -p 4566:4566 localstack/localstack

# Configure endpoints
export WORKFLOW_AWS_DYNAMODB_ENDPOINT=http://localhost:4566
export WORKFLOW_AWS_SQS_ENDPOINT=http://localhost:4566

# Create tables
npx workflow-aws-setup

# Create SQS queues
aws --endpoint-url http://localhost:4566 sqs create-queue --queue-name workflow-workflows
aws --endpoint-url http://localhost:4566 sqs create-queue --queue-name workflow-steps
```

## Usage with Next.js

```typescript
// workflow.config.ts
import { createWorld } from '@workflow/world-aws';

export const world = createWorld();
```

## DynamoDB Table Design

All tables use on-demand capacity (PAY_PER_REQUEST) and include Global Secondary Indexes for efficient querying:

- **Runs**: PK=`runId`, GSIs on `workflowName` and `status`
- **Events**: PK=`runId`, SK=`eventId`, GSI on `correlationId`
- **Steps**: PK=`stepId`, GSIs on `runId` and `status`
- **Hooks**: PK=`hookId`, GSIs on `runId` and `token`
- **Waits**: PK=`waitId`, GSI on `runId`
- **Streams**: PK=`streamId`, SK=`chunkId`, GSI on `runId`

Binary data (inputs, outputs, errors) is encoded using CBOR for efficient storage in DynamoDB's binary attribute type.
