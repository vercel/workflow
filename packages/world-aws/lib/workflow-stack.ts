import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { getDynamoDBAttributeType, TableSchemas } from './schema-utils';

export interface WorkflowStackProps extends cdk.StackProps {
  stackName: string;
  environment: 'dev' | 'staging' | 'prod';
  tablePrefix?: string;
  queuePrefix?: string;
}

export class WorkflowStack extends cdk.Stack {
  public readonly runsTable: dynamodb.Table;
  public readonly stepsTable: dynamodb.Table;
  public readonly eventsTable: dynamodb.Table;
  public readonly hooksTable: dynamodb.Table;
  public readonly streamsTable: dynamodb.Table;

  public readonly workflowQueue: sqs.Queue;
  public readonly stepQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  public readonly streamBucket: s3.Bucket;

  public readonly workerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);

    const tablePrefix = props.tablePrefix || 'workflow';
    const queuePrefix = props.queuePrefix || 'workflow';
    const isProd = props.environment === 'prod';

    // ============================================================================
    // DYNAMODB TABLES
    // Schema definitions imported from @workflow/world package
    // ============================================================================

    // Workflow Runs Table
    const runsSchema = TableSchemas.runs;
    this.runsTable = new dynamodb.Table(this, 'WorkflowRunsTable', {
      tableName: `${tablePrefix}_runs`,
      partitionKey: {
        name: runsSchema.partitionKey,
        type: getDynamoDBAttributeType('string'),
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Add GSIs based on schema definition
    for (const index of runsSchema.indexes) {
      this.runsTable.addGlobalSecondaryIndex({
        indexName: index.name,
        partitionKey: {
          name: index.partitionKey,
          type: getDynamoDBAttributeType('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: getDynamoDBAttributeType('string'),
          },
        }),
      });
    }

    // Workflow Steps Table
    const stepsSchema = TableSchemas.steps;
    this.stepsTable = new dynamodb.Table(this, 'WorkflowStepsTable', {
      tableName: `${tablePrefix}_steps`,
      partitionKey: {
        name: stepsSchema.partitionKey,
        type: getDynamoDBAttributeType('string'),
      },
      ...(stepsSchema.sortKey && {
        sortKey: {
          name: stepsSchema.sortKey,
          type: getDynamoDBAttributeType('string'),
        },
      }),
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add GSIs based on schema definition
    for (const index of stepsSchema.indexes) {
      this.stepsTable.addGlobalSecondaryIndex({
        indexName: index.name,
        partitionKey: {
          name: index.partitionKey,
          type: getDynamoDBAttributeType('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: getDynamoDBAttributeType('string'),
          },
        }),
      });
    }

    // Workflow Events Table
    const eventsSchema = TableSchemas.events;
    this.eventsTable = new dynamodb.Table(this, 'WorkflowEventsTable', {
      tableName: `${tablePrefix}_events`,
      partitionKey: {
        name: eventsSchema.partitionKey,
        type: getDynamoDBAttributeType('string'),
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl', // Optional: auto-expire old events
    });

    // Add GSIs based on schema definition
    for (const index of eventsSchema.indexes) {
      this.eventsTable.addGlobalSecondaryIndex({
        indexName: index.name,
        partitionKey: {
          name: index.partitionKey,
          type: getDynamoDBAttributeType('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: getDynamoDBAttributeType('string'),
          },
        }),
      });
    }

    // Workflow Hooks Table
    const hooksSchema = TableSchemas.hooks;
    this.hooksTable = new dynamodb.Table(this, 'WorkflowHooksTable', {
      tableName: `${tablePrefix}_hooks`,
      partitionKey: {
        name: hooksSchema.partitionKey,
        type: getDynamoDBAttributeType('string'),
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add GSIs based on schema definition
    for (const index of hooksSchema.indexes) {
      this.hooksTable.addGlobalSecondaryIndex({
        indexName: index.name,
        partitionKey: {
          name: index.partitionKey,
          type: getDynamoDBAttributeType('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: getDynamoDBAttributeType('string'),
          },
        }),
      });
    }

    // Workflow Stream Chunks Table (metadata)
    const streamsSchema = TableSchemas.streams;
    this.streamsTable = new dynamodb.Table(this, 'WorkflowStreamsTable', {
      tableName: `${tablePrefix}_stream_chunks`,
      partitionKey: {
        name: streamsSchema.partitionKey,
        type: getDynamoDBAttributeType('string'),
      },
      ...(streamsSchema.sortKey && {
        sortKey: {
          name: streamsSchema.sortKey,
          type: getDynamoDBAttributeType('string'),
        },
      }),
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: isProd,
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================================
    // S3 BUCKET FOR STREAMING
    // ============================================================================

    this.streamBucket = new s3.Bucket(this, 'WorkflowStreamBucket', {
      bucketName: `${tablePrefix}-streams-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: isProd,
      lifecycleRules: [
        {
          id: 'DeleteOldStreams',
          enabled: true,
          expiration: cdk.Duration.days(isProd ? 90 : 30),
        },
      ],
      removalPolicy: isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ============================================================================
    // SQS QUEUES
    // ============================================================================

    // Dead Letter Queue
    this.deadLetterQueue = new sqs.Queue(this, 'WorkflowDeadLetterQueue', {
      queueName: `${queuePrefix}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Workflow Queue (for workflow invocations)
    this.workflowQueue = new sqs.Queue(this, 'WorkflowQueue', {
      queueName: `${queuePrefix}-flows`,
      visibilityTimeout: cdk.Duration.seconds(900), // 15 minutes
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // Step Queue (for step executions)
    this.stepQueue = new sqs.Queue(this, 'WorkflowStepQueue', {
      queueName: `${queuePrefix}-steps`,
      visibilityTimeout: cdk.Duration.seconds(900), // 15 minutes
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ============================================================================
    // LAMBDA FUNCTION (Worker - Placeholder)
    // ============================================================================

    // Create Lambda execution role
    const lambdaRole = new iam.Role(this, 'WorkflowWorkerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for Workflow worker Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
      ],
    });

    // Grant permissions to Lambda
    this.runsTable.grantReadWriteData(lambdaRole);
    this.stepsTable.grantReadWriteData(lambdaRole);
    this.eventsTable.grantReadWriteData(lambdaRole);
    this.hooksTable.grantReadWriteData(lambdaRole);
    this.streamsTable.grantReadWriteData(lambdaRole);
    this.streamBucket.grantReadWrite(lambdaRole);
    this.workflowQueue.grantConsumeMessages(lambdaRole);
    this.stepQueue.grantConsumeMessages(lambdaRole);
    this.workflowQueue.grantSendMessages(lambdaRole);
    this.stepQueue.grantSendMessages(lambdaRole);

    // Create Lambda function with pre-built bundle
    // Dependencies are installed by build.sh using npm (flat structure, no pnpm)
    // No Docker required for deployment - bundle is ready to use
    // Handler is index.js (ESM) and route files are also ESM
    this.workerFunction = new lambda.Function(this, 'WorkflowWorker', {
      functionName: `${queuePrefix}-worker`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      // Use pre-built bundle from build.sh (includes node_modules)
      code: lambda.Code.fromAsset('cdk.out/lambda-bundle'),
      timeout: cdk.Duration.seconds(900), // 15 minutes
      memorySize: 512,
      role: lambdaRole,
      environment: {
        // Workflow SDK auto-discovery
        WORKFLOW_TARGET_WORLD: 'aws-workflow',
        // AWS World configuration (must match world/config.ts)
        WORKFLOW_AWS_RUNS_TABLE: this.runsTable.tableName,
        WORKFLOW_AWS_STEPS_TABLE: this.stepsTable.tableName,
        WORKFLOW_AWS_EVENTS_TABLE: this.eventsTable.tableName,
        WORKFLOW_AWS_HOOKS_TABLE: this.hooksTable.tableName,
        WORKFLOW_AWS_STREAMS_TABLE: this.streamsTable.tableName,
        WORKFLOW_AWS_STREAM_BUCKET: this.streamBucket.bucketName,
        WORKFLOW_AWS_WORKFLOW_QUEUE_URL: this.workflowQueue.queueUrl,
        WORKFLOW_AWS_STEP_QUEUE_URL: this.stepQueue.queueUrl,
        // Note: AWS_REGION is automatically provided by Lambda runtime
        // Lambda configuration
        ENVIRONMENT: props.environment,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        NODE_OPTIONS: '--enable-source-maps',
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, 'WorkflowWorkerLogs', {
        logGroupName: `/aws/lambda/${queuePrefix}-worker`,
        retention: isProd
          ? logs.RetentionDays.ONE_MONTH
          : logs.RetentionDays.ONE_WEEK,
        removalPolicy: isProd
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      }),
      reservedConcurrentExecutions:
        props.environment === 'dev' ? 10 : undefined,
    });

    // Add SQS event sources to Lambda
    this.workerFunction.addEventSource(
      new SqsEventSource(this.workflowQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      })
    );

    this.workerFunction.addEventSource(
      new SqsEventSource(this.stepQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      })
    );

    // ============================================================================
    // OUTPUTS
    // ============================================================================

    new cdk.CfnOutput(this, 'RunsTableName', {
      value: this.runsTable.tableName,
      description: 'DynamoDB table for workflow runs',
      exportName: `${props.stackName}-runs-table`,
    });

    new cdk.CfnOutput(this, 'StepsTableName', {
      value: this.stepsTable.tableName,
      description: 'DynamoDB table for workflow steps',
      exportName: `${props.stackName}-steps-table`,
    });

    new cdk.CfnOutput(this, 'EventsTableName', {
      value: this.eventsTable.tableName,
      description: 'DynamoDB table for workflow events',
      exportName: `${props.stackName}-events-table`,
    });

    new cdk.CfnOutput(this, 'HooksTableName', {
      value: this.hooksTable.tableName,
      description: 'DynamoDB table for workflow hooks',
      exportName: `${props.stackName}-hooks-table`,
    });

    new cdk.CfnOutput(this, 'StreamsTableName', {
      value: this.streamsTable.tableName,
      description: 'DynamoDB table for stream chunk metadata',
      exportName: `${props.stackName}-streams-table`,
    });

    new cdk.CfnOutput(this, 'StreamBucketName', {
      value: this.streamBucket.bucketName,
      description: 'S3 bucket for stream chunks',
      exportName: `${props.stackName}-stream-bucket`,
    });

    new cdk.CfnOutput(this, 'WorkflowQueueUrl', {
      value: this.workflowQueue.queueUrl,
      description: 'SQS queue URL for workflow invocations',
      exportName: `${props.stackName}-workflow-queue-url`,
    });

    new cdk.CfnOutput(this, 'StepQueueUrl', {
      value: this.stepQueue.queueUrl,
      description: 'SQS queue URL for step executions',
      exportName: `${props.stackName}-step-queue-url`,
    });

    new cdk.CfnOutput(this, 'WorkerFunctionArn', {
      value: this.workerFunction.functionArn,
      description: 'Lambda worker function ARN',
      exportName: `${props.stackName}-worker-function-arn`,
    });

    new cdk.CfnOutput(this, 'Region', {
      value: cdk.Aws.REGION,
      description: 'AWS Region',
    });
  }
}
