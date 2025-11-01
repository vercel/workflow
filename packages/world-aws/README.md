# @workflow/world-aws

![Experimental](https://img.shields.io/badge/status-experimental-orange?style=flat-square) ![Beta](https://img.shields.io/badge/status-beta-yellow?style=flat-square)

> ⚠️ **EXPERIMENTAL & BETA**: This package is in active development and should be used with caution in production.

AWS World implementation for [Workflow DevKit](https://useworkflow.dev/) - Run durable, resumable workflows on AWS Lambda with DynamoDB, SQS, and S3. This is a reference implementation for serverless workflow execution on AWS infrastructure.

## Installation

```bash
npm install @workflow/world-aws
# or
pnpm add @workflow/world-aws
# or
yarn add @workflow/world-aws
```

## Usage

### Basic Setup

The AWS world can be configured by setting the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-aws"
```

### Configuration

Configure the AWS world using environment variables:

```bash
# Required: AWS region
export AWS_REGION="us-east-1"

# Required: SQS queue URLs
export WORKFLOW_AWS_WORKFLOW_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/..."
export WORKFLOW_AWS_STEP_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/..."

# Required: DynamoDB table names
export WORKFLOW_AWS_RUNS_TABLE="workflow_runs"
export WORKFLOW_AWS_STEPS_TABLE="workflow_steps"
export WORKFLOW_AWS_EVENTS_TABLE="workflow_events"
export WORKFLOW_AWS_HOOKS_TABLE="workflow_hooks"
export WORKFLOW_AWS_STREAMS_TABLE="workflow_stream_chunks"

# Required: S3 bucket for large payloads
export WORKFLOW_AWS_STREAM_BUCKET="workflow-streams-..."

# Optional: AWS credentials (local dev only, not required on AWS)
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
```

### Programmatic Usage

You can also create an AWS world directly in your code:

```typescript
import { createWorld } from "@workflow/world-aws";

const world = createWorld({
  region: "us-east-1",
  queueUrl: "https://sqs.us-east-1.amazonaws.com/...",
  stepQueueUrl: "https://sqs.us-east-1.amazonaws.com/...",
  runsTable: "workflow_runs",
  stepsTable: "workflow_steps",
  eventsTable: "workflow_events",
  hooksTable: "workflow_hooks",
  streamChunksTable: "workflow_stream_chunks",
  streamBucket: "workflow-streams-...",
});
```

## Configuration Options

| Option              | Type     | Default                        | Description                                   |
| ------------------- | -------- | ------------------------------ | --------------------------------------------- |
| `region`            | `string` | `process.env.AWS_REGION`       | AWS region                                    |
| `queueUrl`          | `string` | `process.env.WORKFLOW_AWS_WORKFLOW_QUEUE_URL` | SQS queue URL for workflow orchestration     |
| `stepQueueUrl`      | `string` | `process.env.WORKFLOW_AWS_STEP_QUEUE_URL` | SQS queue URL for step execution            |
| `runsTable`         | `string` | `process.env.WORKFLOW_AWS_RUNS_TABLE` | DynamoDB table for workflow runs            |
| `stepsTable`        | `string` | `process.env.WORKFLOW_AWS_STEPS_TABLE` | DynamoDB table for step execution           |
| `eventsTable`       | `string` | `process.env.WORKFLOW_AWS_EVENTS_TABLE` | DynamoDB table for workflow events          |
| `hooksTable`        | `string` | `process.env.WORKFLOW_AWS_HOOKS_TABLE` | DynamoDB table for webhook hooks            |
| `streamChunksTable` | `string` | `process.env.WORKFLOW_AWS_STREAMS_TABLE` | DynamoDB table for stream chunks           |
| `streamBucket`      | `string` | `process.env.WORKFLOW_AWS_STREAM_BUCKET` | S3 bucket for large payload storage        |

## Environment Variables

| Variable                      | Description                                    | Required | Default |
| ----------------------------- | ---------------------------------------------- | -------- | ------- |
| `WORKFLOW_TARGET_WORLD`       | Set to `"@workflow/world-aws"` to use this world | -        | -       |
| `AWS_REGION`                  | AWS region                                     | ✅       | -       |
| `WORKFLOW_AWS_WORKFLOW_QUEUE_URL` | SQS queue URL for workflow orchestration       | ✅       | -       |
| `WORKFLOW_AWS_STEP_QUEUE_URL`     | SQS queue URL for step execution               | ✅       | -       |
| `WORKFLOW_AWS_RUNS_TABLE`         | DynamoDB table for workflow runs               | ✅       | -       |
| `WORKFLOW_AWS_STEPS_TABLE`        | DynamoDB table for step execution              | ✅       | -       |
| `WORKFLOW_AWS_EVENTS_TABLE`        | DynamoDB table for workflow events             | ✅       | -       |
| `WORKFLOW_AWS_HOOKS_TABLE`         | DynamoDB table for webhook hooks               | ✅       | -       |
| `WORKFLOW_AWS_STREAMS_TABLE` | DynamoDB table for stream chunks              | ✅       | -       |
| `WORKFLOW_AWS_STREAM_BUCKET`       | S3 bucket for large payloads                  | ✅       | -       |
| `AWS_ACCESS_KEY_ID`            | AWS access key (local dev only)               | ✅*      | -       |
| `AWS_SECRET_ACCESS_KEY`        | AWS secret key (local dev only)                | ✅*      | -       |

*Not required when running on AWS (uses IAM roles)

## AWS Setup

This package uses AWS services with the following components:

- **DynamoDB**: For state persistence and workflow runs, steps, events, hooks, and stream chunks
- **SQS**: For message queuing and workflow orchestration
- **S3**: For large payload storage
- **Lambda**: For serverless workflow execution

### Quick Setup with CLI

The easiest way to set up your AWS infrastructure is using the included CLI tool:

```bash
npx aws-workflow bootstrap -y
# or
pnpm exec aws-workflow bootstrap -y
```

The CLI automatically creates the required AWS resources and outputs environment variables to `.env.aws`. It creates:

- 5 DynamoDB tables (workflow runs, steps, events, hooks, stream chunks)
- 2 SQS queues (workflow queue, step queue)
- 1 S3 bucket for large payload storage
- Lambda worker function for executing workflows

**Cost estimate:** Free tier eligible. Typical cost: $5-20/month for moderate usage.

### AWS Resources Schema

The setup creates the following DynamoDB tables:

- `workflow_runs` - Stores workflow execution runs
- `workflow_events` - Stores workflow events
- `workflow_steps` - Stores individual workflow steps
- `workflow_hooks` - Stores webhook hooks
- `workflow_stream_chunks` - Stores streaming data chunks

The S3 bucket is used for storing large payloads (>256KB).

Make sure your AWS credentials have sufficient permissions to create and manage DynamoDB tables, SQS queues, S3 buckets, and Lambda functions.

### Deploying Workflows

After setting up AWS resources, deploy your workflows to Lambda:

```bash
npx aws-workflow deploy
# or
pnpm exec aws-workflow deploy
```

**What this does:**
- Compiles your TypeScript workflows
- Builds Next.js to generate workflow bundles
- Packages Lambda handler with your workflows
- Deploys to AWS Lambda (no Docker required!)

## Features

- **Serverless Execution**: Runs workflows on AWS Lambda with automatic scaling
- **Durable Storage**: Stores workflow runs, events, steps, hooks, and webhooks in DynamoDB
- **Queue Processing**: Uses SQS for reliable message queuing and orchestration
- **Large Payload Storage**: Uses S3 for storing payloads larger than 256KB
- **Automatic Retries**: Steps automatically retry on failure with exponential backoff
- **State Persistence**: Workflow state is persisted to DynamoDB - resume from any point
- **Sleep & Wait**: Use `sleep()` to pause workflows for minutes, hours, or days without consuming resources
- **Parallel Execution**: Run multiple steps concurrently with `Promise.all()`

## Development

For local development with AWS:

```bash
# Bootstrap AWS resources (first time only)
npx aws-workflow bootstrap -y

# Copy environment variables from .env.aws to .env.local
cp .env.aws .env.local

# Deploy workflows to Lambda
npx aws-workflow deploy

# Get current AWS resource info
npx aws-workflow outputs

# Tear down all AWS resources
npx aws-workflow teardown
```

### Next.js Configuration

Add to your `next.config.ts`:

```typescript
import { withWorkflow } from 'workflow/next';

export default withWorkflow({
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
});
```

### Example Workflow

Create `workflows/user-signup.ts`:

```typescript
import { sleep } from 'workflow';

export async function handleUserSignup(email: string) {
  'use workflow';

  // Step 1: Create user
  const user = await createUser(email);
  
  // Step 2: Send welcome email
  await sendWelcomeEmail(email);
  
  // Step 3: Wait 7 days (workflow suspends - no resources consumed!)
  await sleep('7 days');
  
  // Step 4: Send follow-up
  await sendFollowUpEmail(email);
  
  return { userId: user.id, status: 'completed' };
}

async function createUser(email: string) {
  'use step';
  // Your user creation logic
  return { id: '123', email };
}

async function sendWelcomeEmail(email: string) {
  'use step';
  // Send email via Resend, SendGrid, etc.
}

async function sendFollowUpEmail(email: string) {
  'use step';
  // Send follow-up email
}
```

## World Selection

To use the AWS world, set the `WORKFLOW_TARGET_WORLD` environment variable to the package name:

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-aws"
```
