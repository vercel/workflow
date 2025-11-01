import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { join } from 'path';

export interface WorkflowInfrastructureProps extends cdk.StackProps {
  /**
   * Path to the Next.js application directory (relative to infrastructure/)
   * This is where workflow bundles will be copied from after build
   */
  appPath: string;

  /**
   * Optional Lambda configuration
   */
  lambda?: {
    memorySize?: number;
    timeout?: cdk.Duration;
    environment?: Record<string, string>;
  };
}

/**
 * AWS Workflow Infrastructure Stack
 *
 * Creates all necessary AWS resources for running Workflow DevKit:
 * - DynamoDB tables for workflow state
 * - SQS queues for async execution
 * - S3 bucket for streaming
 * - Lambda function for processing workflows
 */
export class WorkflowInfrastructure extends cdk.Stack {
  public readonly tables: {
    runs: dynamodb.Table;
    steps: dynamodb.Table;
    events: dynamodb.Table;
    hooks: dynamodb.Table;
    streams: dynamodb.Table;
  };

  public readonly queues: {
    workflow: sqs.Queue;
    step: sqs.Queue;
    dlq: sqs.Queue;
  };

  public readonly streamBucket: s3.Bucket;
  public readonly workerFunction: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    props: WorkflowInfrastructureProps
  ) {
    super(scope, id, props);

    // Create DynamoDB tables
    this.tables = this.createTables();

    // Create SQS queues
    this.queues = this.createQueues();

    // Create S3 bucket for streaming
    this.streamBucket = this.createStreamBucket();

    // Create Lambda worker function
    this.workerFunction = this.createWorkerFunction(props);

    // Grant permissions
    this.grantPermissions();

    // Add SQS event sources to Lambda
    this.workerFunction.addEventSource(
      new SqsEventSource(this.queues.workflow, {
        batchSize: 1,
        reportBatchItemFailures: true,
      })
    );

    this.workerFunction.addEventSource(
      new SqsEventSource(this.queues.step, {
        batchSize: 1,
        reportBatchItemFailures: true,
      })
    );

    // Create CloudFormation outputs
    this.createOutputs();
  }

  private createTables() {
    const runs = new dynamodb.Table(this, 'WorkflowRuns', {
      tableName: 'workflow_runs',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    runs.addGlobalSecondaryIndex({
      indexName: 'workflowName-createdAt-index',
      partitionKey: {
        name: 'workflowName',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    const steps = new dynamodb.Table(this, 'WorkflowSteps', {
      tableName: 'workflow_steps',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'stepId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const events = new dynamodb.Table(this, 'WorkflowEvents', {
      tableName: 'workflow_events',
      partitionKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const hooks = new dynamodb.Table(this, 'WorkflowHooks', {
      tableName: 'workflow_hooks',
      partitionKey: { name: 'hookId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    hooks.addGlobalSecondaryIndex({
      indexName: 'token-index',
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
    });

    const streams = new dynamodb.Table(this, 'WorkflowStreamChunks', {
      tableName: 'workflow_stream_chunks',
      partitionKey: { name: 'streamId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'chunkIndex', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    return { runs, steps, events, hooks, streams };
  }

  private createQueues() {
    const dlq = new sqs.Queue(this, 'WorkflowDLQ', {
      queueName: 'workflow-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const workflow = new sqs.Queue(this, 'WorkflowQueue', {
      queueName: 'workflow-flows',
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const step = new sqs.Queue(this, 'StepQueue', {
      queueName: 'workflow-steps',
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    return { workflow, step, dlq };
  }

  private createStreamBucket() {
    return new s3.Bucket(this, 'StreamBucket', {
      bucketName: `workflow-streams-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // Change for production
    });
  }

  private createWorkerFunction(props: WorkflowInfrastructureProps) {
    const lambdaConfig = props.lambda || {};

    return new nodejs.NodejsFunction(this, 'WorkflowWorker', {
      functionName: `${this.stackName}-worker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: join(__dirname, '../../lambda/worker/index.ts'),
      memorySize: lambdaConfig.memorySize || 1024,
      timeout: lambdaConfig.timeout || cdk.Duration.minutes(15),
      environment: {
        AWS_REGION: this.region,
        RUNS_TABLE_NAME: this.tables.runs.tableName,
        STEPS_TABLE_NAME: this.tables.steps.tableName,
        EVENTS_TABLE_NAME: this.tables.events.tableName,
        HOOKS_TABLE_NAME: this.tables.hooks.tableName,
        STREAMS_TABLE_NAME: this.tables.streams.tableName,
        WORKFLOW_QUEUE_URL: this.queues.workflow.queueUrl,
        STEP_QUEUE_URL: this.queues.step.queueUrl,
        STREAM_BUCKET_NAME: this.streamBucket.bucketName,
        ...lambdaConfig.environment,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false, // Use local esbuild instead of Docker
        commandHooks: {
          beforeBundling: (inputDir: string, outputDir: string) => {
            // Copy workflow bundles from Next.js build
            const appPath = join(inputDir, props.appPath);
            return [
              `echo "Copying workflow bundles from ${appPath}/.well-known/"`,
              `mkdir -p ${outputDir}/.well-known/workflow/v1/flow`,
              `mkdir -p ${outputDir}/.well-known/workflow/v1/step`,
              `if [ -f "${appPath}/.well-known/workflow/v1/flow/route.js" ]; then`,
              `  cp "${appPath}/.well-known/workflow/v1/flow/route.js" ${outputDir}/.well-known/workflow/v1/flow/`,
              `  echo "✓ Copied flow handler"`,
              `else`,
              `  echo "⚠️  Warning: flow/route.js not found"`,
              `fi`,
              `if [ -f "${appPath}/.well-known/workflow/v1/step/route.js" ]; then`,
              `  cp "${appPath}/.well-known/workflow/v1/step/route.js" ${outputDir}/.well-known/workflow/v1/step/`,
              `  echo "✓ Copied step handler"`,
              `else`,
              `  echo "⚠️  Warning: step/route.js not found"`,
              `fi`,
            ];
          },
          afterBundling: () => [],
          beforeInstall: () => [],
        },
      },
    });
  }

  private grantPermissions() {
    // Grant Lambda access to DynamoDB tables
    this.tables.runs.grantReadWriteData(this.workerFunction);
    this.tables.steps.grantReadWriteData(this.workerFunction);
    this.tables.events.grantReadWriteData(this.workerFunction);
    this.tables.hooks.grantReadWriteData(this.workerFunction);
    this.tables.streams.grantReadWriteData(this.workerFunction);

    // Grant Lambda access to S3 bucket
    this.streamBucket.grantReadWrite(this.workerFunction);

    // Grant Lambda access to SQS queues
    this.queues.workflow.grantSendMessages(this.workerFunction);
    this.queues.step.grantSendMessages(this.workerFunction);
  }

  private createOutputs() {
    new cdk.CfnOutput(this, 'RunsTableName', {
      value: this.tables.runs.tableName,
      description: 'DynamoDB table for workflow runs',
    });

    new cdk.CfnOutput(this, 'StepsTableName', {
      value: this.tables.steps.tableName,
      description: 'DynamoDB table for workflow steps',
    });

    new cdk.CfnOutput(this, 'EventsTableName', {
      value: this.tables.events.tableName,
      description: 'DynamoDB table for workflow events',
    });

    new cdk.CfnOutput(this, 'HooksTableName', {
      value: this.tables.hooks.tableName,
      description: 'DynamoDB table for workflow hooks',
    });

    new cdk.CfnOutput(this, 'StreamsTableName', {
      value: this.tables.streams.tableName,
      description: 'DynamoDB table for stream chunks',
    });

    new cdk.CfnOutput(this, 'WorkflowQueueUrl', {
      value: this.queues.workflow.queueUrl,
      description: 'SQS queue URL for workflows',
    });

    new cdk.CfnOutput(this, 'StepQueueUrl', {
      value: this.queues.step.queueUrl,
      description: 'SQS queue URL for steps',
    });

    new cdk.CfnOutput(this, 'StreamBucketName', {
      value: this.streamBucket.bucketName,
      description: 'S3 bucket for stream data',
    });

    new cdk.CfnOutput(this, 'WorkerFunctionArn', {
      value: this.workerFunction.functionArn,
      description: 'Lambda function ARN for workflow worker',
    });
  }
}
