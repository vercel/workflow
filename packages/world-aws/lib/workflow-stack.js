'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null)
      for (var k in mod)
        if (k !== 'default' && Object.prototype.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.WorkflowStack = void 0;
const cdk = __importStar(require('aws-cdk-lib'));
const dynamodb = __importStar(require('aws-cdk-lib/aws-dynamodb'));
const iam = __importStar(require('aws-cdk-lib/aws-iam'));
const lambda = __importStar(require('aws-cdk-lib/aws-lambda'));
const aws_lambda_event_sources_1 = require('aws-cdk-lib/aws-lambda-event-sources');
const logs = __importStar(require('aws-cdk-lib/aws-logs'));
const s3 = __importStar(require('aws-cdk-lib/aws-s3'));
const sqs = __importStar(require('aws-cdk-lib/aws-sqs'));
const schema_utils_1 = require('./schema-utils');
class WorkflowStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const tablePrefix = props.tablePrefix || 'workflow';
    const queuePrefix = props.queuePrefix || 'workflow';
    const isProd = props.environment === 'prod';
    // ============================================================================
    // DYNAMODB TABLES
    // Schema definitions imported from @workflow/world package
    // ============================================================================
    // Workflow Runs Table
    const runsSchema = schema_utils_1.TableSchemas.runs;
    this.runsTable = new dynamodb.Table(this, 'WorkflowRunsTable', {
      tableName: `${tablePrefix}_runs`,
      partitionKey: {
        name: runsSchema.partitionKey,
        type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
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
          type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
          },
        }),
      });
    }
    // Workflow Steps Table
    const stepsSchema = schema_utils_1.TableSchemas.steps;
    this.stepsTable = new dynamodb.Table(this, 'WorkflowStepsTable', {
      tableName: `${tablePrefix}_steps`,
      partitionKey: {
        name: stepsSchema.partitionKey,
        type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
      },
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
          type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
          },
        }),
      });
    }
    // Workflow Events Table
    const eventsSchema = schema_utils_1.TableSchemas.events;
    this.eventsTable = new dynamodb.Table(this, 'WorkflowEventsTable', {
      tableName: `${tablePrefix}_events`,
      partitionKey: {
        name: eventsSchema.partitionKey,
        type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
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
          type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
          },
        }),
      });
    }
    // Workflow Hooks Table
    const hooksSchema = schema_utils_1.TableSchemas.hooks;
    this.hooksTable = new dynamodb.Table(this, 'WorkflowHooksTable', {
      tableName: `${tablePrefix}_hooks`,
      partitionKey: {
        name: hooksSchema.partitionKey,
        type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
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
          type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
        },
        ...(index.sortKey && {
          sortKey: {
            name: index.sortKey,
            type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
          },
        }),
      });
    }
    // Workflow Stream Chunks Table (metadata)
    const streamsSchema = schema_utils_1.TableSchemas.streams;
    this.streamsTable = new dynamodb.Table(this, 'WorkflowStreamsTable', {
      tableName: `${tablePrefix}_stream_chunks`,
      partitionKey: {
        name: streamsSchema.partitionKey,
        type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
      },
      ...(streamsSchema.sortKey && {
        sortKey: {
          name: streamsSchema.sortKey,
          type: (0, schema_utils_1.getDynamoDBAttributeType)('string'),
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
    // Create Lambda function with actual workflow processing
    this.workerFunction = new lambda.Function(this, 'WorkflowWorker', {
      functionName: `${queuePrefix}-worker`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('cdk.out/lambda-worker', {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'cp -r /asset-input/* /asset-output/',
              'cd /asset-output',
              'npm install --omit=dev --production',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(900), // 15 minutes
      memorySize: 512,
      role: lambdaRole,
      environment: {
        RUNS_TABLE_NAME: this.runsTable.tableName,
        STEPS_TABLE_NAME: this.stepsTable.tableName,
        EVENTS_TABLE_NAME: this.eventsTable.tableName,
        HOOKS_TABLE_NAME: this.hooksTable.tableName,
        STREAMS_TABLE_NAME: this.streamsTable.tableName,
        STREAM_BUCKET_NAME: this.streamBucket.bucketName,
        WORKFLOW_QUEUE_URL: this.workflowQueue.queueUrl,
        STEP_QUEUE_URL: this.stepQueue.queueUrl,
        ENVIRONMENT: props.environment,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        NODE_OPTIONS: '--enable-source-maps',
      },
      tracing: lambda.Tracing.ACTIVE,
      logRetention: isProd
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
      reservedConcurrentExecutions:
        props.environment === 'dev' ? 10 : undefined,
    });
    // Add SQS event sources to Lambda
    this.workerFunction.addEventSource(
      new aws_lambda_event_sources_1.SqsEventSource(this.workflowQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      })
    );
    this.workerFunction.addEventSource(
      new aws_lambda_event_sources_1.SqsEventSource(this.stepQueue, {
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
exports.WorkflowStack = WorkflowStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2Zsb3ctc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ3b3JrZmxvdy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyxtRUFBcUQ7QUFDckQseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCxtRkFBc0U7QUFDdEUsMkRBQTZDO0FBQzdDLHVEQUF5QztBQUN6Qyx5REFBMkM7QUFFM0MsaURBQXdFO0FBU3hFLE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBZTFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxVQUFVLENBQUM7UUFDcEQsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxVQUFVLENBQUM7UUFDcEQsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLFdBQVcsS0FBSyxNQUFNLENBQUM7UUFFNUMsK0VBQStFO1FBQy9FLGtCQUFrQjtRQUNsQiwyREFBMkQ7UUFDM0QsK0VBQStFO1FBRS9FLHNCQUFzQjtRQUN0QixNQUFNLFVBQVUsR0FBRywyQkFBWSxDQUFDLElBQUksQ0FBQztRQUNyQyxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDN0QsU0FBUyxFQUFFLEdBQUcsV0FBVyxPQUFPO1lBQ2hDLFlBQVksRUFBRTtnQkFDWixJQUFJLEVBQUUsVUFBVSxDQUFDLFlBQVk7Z0JBQzdCLElBQUksRUFBRSxJQUFBLHVDQUF3QixFQUFDLFFBQVEsQ0FBQzthQUN6QztZQUNELFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsbUJBQW1CLEVBQUUsTUFB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LENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzFDLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVE7WUFDbEMsV0FBVyxFQUFFLHdDQUF3QztZQUNyRCxVQUFVLEVBQUUsR0FBRyxLQUFLLENBQUMsU0FBUyxxQkFBcUI7U0FDcEQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUTtZQUM5QixXQUFXLEVBQUUsbUNBQW1DO1lBQ2hELFVBQVUsRUFBRSxHQUFHLEtBQUssQ0FBQyxTQUFTLGlCQUFpQjtTQUNoRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzNDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLFdBQVc7WUFDdEMsV0FBVyxFQUFFLDRCQUE0QjtZQUN6QyxVQUFVLEVBQUUsR0FBRyxLQUFLLENBQUMsU0FBUyxzQkFBc0I7U0FDckQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDaEMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTTtZQUNyQixXQUFXLEVBQUUsWUFBWTtTQUMxQixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFsWUQsc0NBa1lDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCB7IFNxc0V2ZW50U291cmNlIH0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGEtZXZlbnQtc291cmNlc1wiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCAqIGFzIHNxcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNxc1wiO1xuaW1wb3J0IHR5cGUgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0IHsgZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlLCBUYWJsZVNjaGVtYXMgfSBmcm9tIFwiLi9zY2hlbWEtdXRpbHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBXb3JrZmxvd1N0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIHN0YWNrTmFtZTogc3RyaW5nO1xuICBlbnZpcm9ubWVudDogXCJkZXZcIiB8IFwic3RhZ2luZ1wiIHwgXCJwcm9kXCI7XG4gIHRhYmxlUHJlZml4Pzogc3RyaW5nO1xuICBxdWV1ZVByZWZpeD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFdvcmtmbG93U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBwdWJsaWMgcmVhZG9ubHkgcnVuc1RhYmxlOiBkeW5hbW9kYi5UYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IHN0ZXBzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgZXZlbnRzVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgaG9va3NUYWJsZTogZHluYW1vZGIuVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBzdHJlYW1zVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIHB1YmxpYyByZWFkb25seSB3b3JrZmxvd1F1ZXVlOiBzcXMuUXVldWU7XG4gIHB1YmxpYyByZWFkb25seSBzdGVwUXVldWU6IHNxcy5RdWV1ZTtcbiAgcHVibGljIHJlYWRvbmx5IGRlYWRMZXR0ZXJRdWV1ZTogc3FzLlF1ZXVlO1xuXG4gIHB1YmxpYyByZWFkb25seSBzdHJlYW1CdWNrZXQ6IHMzLkJ1Y2tldDtcblxuICBwdWJsaWMgcmVhZG9ubHkgd29ya2VyRnVuY3Rpb246IGxhbWJkYS5GdW5jdGlvbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogV29ya2Zsb3dTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB0YWJsZVByZWZpeCA9IHByb3BzLnRhYmxlUHJlZml4IHx8IFwid29ya2Zsb3dcIjtcbiAgICBjb25zdCBxdWV1ZVByZWZpeCA9IHByb3BzLnF1ZXVlUHJlZml4IHx8IFwid29ya2Zsb3dcIjtcbiAgICBjb25zdCBpc1Byb2QgPSBwcm9wcy5lbnZpcm9ubWVudCA9PT0gXCJwcm9kXCI7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gRFlOQU1PREIgVEFCTEVTXG4gICAgLy8gU2NoZW1hIGRlZmluaXRpb25zIGltcG9ydGVkIGZyb20gQHdvcmtmbG93L3dvcmxkIHBhY2thZ2VcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBXb3JrZmxvdyBSdW5zIFRhYmxlXG4gICAgY29uc3QgcnVuc1NjaGVtYSA9IFRhYmxlU2NoZW1hcy5ydW5zO1xuICAgIHRoaXMucnVuc1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiV29ya2Zsb3dSdW5zVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lOiBgJHt0YWJsZVByZWZpeH1fcnVuc2AsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogcnVuc1NjaGVtYS5wYXJ0aXRpb25LZXksXG4gICAgICAgIHR5cGU6IGdldER5bmFtb0RCQXR0cmlidXRlVHlwZShcInN0cmluZ1wiKSxcbiAgICAgIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeTogaXNQcm9kLFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEdTSXMgYmFzZWQgb24gc2NoZW1hIGRlZmluaXRpb25cbiAgICBmb3IgKGNvbnN0IGluZGV4IG9mIHJ1bnNTY2hlbWEuaW5kZXhlcykge1xuICAgICAgdGhpcy5ydW5zVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xuICAgICAgICBpbmRleE5hbWU6IGluZGV4Lm5hbWUsXG4gICAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICAgIG5hbWU6IGluZGV4LnBhcnRpdGlvbktleSxcbiAgICAgICAgICB0eXBlOiBnZXREeW5hbW9EQkF0dHJpYnV0ZVR5cGUoXCJzdHJpbmdcIiksXG4gICAgICAgIH0sXG4gICAgICAgIC4uLihpbmRleC5zb3J0S2V5ICYmIHtcbiAgICAgICAgICBzb3J0S2V5OiB7XG4gICAgICAgICAgICBuYW1lOiBpbmRleC5zb3J0S2V5LFxuICAgICAgICAgICAgdHlwZTogZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFwic3RyaW5nXCIpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gV29ya2Zsb3cgU3RlcHMgVGFibGVcbiAgICBjb25zdCBzdGVwc1NjaGVtYSA9IFRhYmxlU2NoZW1hcy5zdGVwcztcbiAgICB0aGlzLnN0ZXBzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJXb3JrZmxvd1N0ZXBzVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lOiBgJHt0YWJsZVByZWZpeH1fc3RlcHNgLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IHN0ZXBzU2NoZW1hLnBhcnRpdGlvbktleSxcbiAgICAgICAgdHlwZTogZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFwic3RyaW5nXCIpLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiBpc1Byb2QsXG4gICAgICByZW1vdmFsUG9saWN5OiBpc1Byb2RcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIEdTSXMgYmFzZWQgb24gc2NoZW1hIGRlZmluaXRpb25cbiAgICBmb3IgKGNvbnN0IGluZGV4IG9mIHN0ZXBzU2NoZW1hLmluZGV4ZXMpIHtcbiAgICAgIHRoaXMuc3RlcHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICAgIGluZGV4TmFtZTogaW5kZXgubmFtZSxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgICAgbmFtZTogaW5kZXgucGFydGl0aW9uS2V5LFxuICAgICAgICAgIHR5cGU6IGdldER5bmFtb0RCQXR0cmlidXRlVHlwZShcInN0cmluZ1wiKSxcbiAgICAgICAgfSxcbiAgICAgICAgLi4uKGluZGV4LnNvcnRLZXkgJiYge1xuICAgICAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgICAgIG5hbWU6IGluZGV4LnNvcnRLZXksXG4gICAgICAgICAgICB0eXBlOiBnZXREeW5hbW9EQkF0dHJpYnV0ZVR5cGUoXCJzdHJpbmdcIiksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBXb3JrZmxvdyBFdmVudHMgVGFibGVcbiAgICBjb25zdCBldmVudHNTY2hlbWEgPSBUYWJsZVNjaGVtYXMuZXZlbnRzO1xuICAgIHRoaXMuZXZlbnRzVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJXb3JrZmxvd0V2ZW50c1RhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZTogYCR7dGFibGVQcmVmaXh9X2V2ZW50c2AsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogZXZlbnRzU2NoZW1hLnBhcnRpdGlvbktleSxcbiAgICAgICAgdHlwZTogZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFwic3RyaW5nXCIpLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiBpc1Byb2QsXG4gICAgICByZW1vdmFsUG9saWN5OiBpc1Byb2RcbiAgICAgICAgPyBjZGsuUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICAgICAgOiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIiwgLy8gT3B0aW9uYWw6IGF1dG8tZXhwaXJlIG9sZCBldmVudHNcbiAgICB9KTtcblxuICAgIC8vIEFkZCBHU0lzIGJhc2VkIG9uIHNjaGVtYSBkZWZpbml0aW9uXG4gICAgZm9yIChjb25zdCBpbmRleCBvZiBldmVudHNTY2hlbWEuaW5kZXhlcykge1xuICAgICAgdGhpcy5ldmVudHNUYWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICAgIGluZGV4TmFtZTogaW5kZXgubmFtZSxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgICAgbmFtZTogaW5kZXgucGFydGl0aW9uS2V5LFxuICAgICAgICAgIHR5cGU6IGdldER5bmFtb0RCQXR0cmlidXRlVHlwZShcInN0cmluZ1wiKSxcbiAgICAgICAgfSxcbiAgICAgICAgLi4uKGluZGV4LnNvcnRLZXkgJiYge1xuICAgICAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgICAgIG5hbWU6IGluZGV4LnNvcnRLZXksXG4gICAgICAgICAgICB0eXBlOiBnZXREeW5hbW9EQkF0dHJpYnV0ZVR5cGUoXCJzdHJpbmdcIiksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBXb3JrZmxvdyBIb29rcyBUYWJsZVxuICAgIGNvbnN0IGhvb2tzU2NoZW1hID0gVGFibGVTY2hlbWFzLmhvb2tzO1xuICAgIHRoaXMuaG9va3NUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIldvcmtmbG93SG9va3NUYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWU6IGAke3RhYmxlUHJlZml4fV9ob29rc2AsXG4gICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgbmFtZTogaG9va3NTY2hlbWEucGFydGl0aW9uS2V5LFxuICAgICAgICB0eXBlOiBnZXREeW5hbW9EQkF0dHJpYnV0ZVR5cGUoXCJzdHJpbmdcIiksXG4gICAgICB9LFxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IGlzUHJvZCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGlzUHJvZFxuICAgICAgICA/IGNkay5SZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAgICA6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgR1NJcyBiYXNlZCBvbiBzY2hlbWEgZGVmaW5pdGlvblxuICAgIGZvciAoY29uc3QgaW5kZXggb2YgaG9va3NTY2hlbWEuaW5kZXhlcykge1xuICAgICAgdGhpcy5ob29rc1RhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgICAgaW5kZXhOYW1lOiBpbmRleC5uYW1lLFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHtcbiAgICAgICAgICBuYW1lOiBpbmRleC5wYXJ0aXRpb25LZXksXG4gICAgICAgICAgdHlwZTogZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFwic3RyaW5nXCIpLFxuICAgICAgICB9LFxuICAgICAgICAuLi4oaW5kZXguc29ydEtleSAmJiB7XG4gICAgICAgICAgc29ydEtleToge1xuICAgICAgICAgICAgbmFtZTogaW5kZXguc29ydEtleSxcbiAgICAgICAgICAgIHR5cGU6IGdldER5bmFtb0RCQXR0cmlidXRlVHlwZShcInN0cmluZ1wiKSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFdvcmtmbG93IFN0cmVhbSBDaHVua3MgVGFibGUgKG1ldGFkYXRhKVxuICAgIGNvbnN0IHN0cmVhbXNTY2hlbWEgPSBUYWJsZVNjaGVtYXMuc3RyZWFtcztcbiAgICB0aGlzLnN0cmVhbXNUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIldvcmtmbG93U3RyZWFtc1RhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZTogYCR7dGFibGVQcmVmaXh9X3N0cmVhbV9jaHVua3NgLFxuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6IHN0cmVhbXNTY2hlbWEucGFydGl0aW9uS2V5LFxuICAgICAgICB0eXBlOiBnZXREeW5hbW9EQkF0dHJpYnV0ZVR5cGUoXCJzdHJpbmdcIiksXG4gICAgICB9LFxuICAgICAgLi4uKHN0cmVhbXNTY2hlbWEuc29ydEtleSAmJiB7XG4gICAgICAgIHNvcnRLZXk6IHtcbiAgICAgICAgICBuYW1lOiBzdHJlYW1zU2NoZW1hLnNvcnRLZXksXG4gICAgICAgICAgdHlwZTogZ2V0RHluYW1vREJBdHRyaWJ1dGVUeXBlKFwic3RyaW5nXCIpLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeTogaXNQcm9kLFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBTMyBCVUNLRVQgRk9SIFNUUkVBTUlOR1xuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIHRoaXMuc3RyZWFtQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIldvcmtmbG93U3RyZWFtQnVja2V0XCIsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGAke3RhYmxlUHJlZml4fS1zdHJlYW1zLSR7Y2RrLkF3cy5BQ0NPVU5UX0lEfS0ke2Nkay5Bd3MuUkVHSU9OfWAsXG4gICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgdmVyc2lvbmVkOiBpc1Byb2QsXG4gICAgICBsaWZlY3ljbGVSdWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiRGVsZXRlT2xkU3RyZWFtc1wiLFxuICAgICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgZXhwaXJhdGlvbjogY2RrLkR1cmF0aW9uLmRheXMoaXNQcm9kID8gOTAgOiAzMCksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogaXNQcm9kXG4gICAgICAgID8gY2RrLlJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICAgIDogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiAhaXNQcm9kLFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFNRUyBRVUVVRVNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBEZWFkIExldHRlciBRdWV1ZVxuICAgIHRoaXMuZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBcIldvcmtmbG93RGVhZExldHRlclF1ZXVlXCIsIHtcbiAgICAgIHF1ZXVlTmFtZTogYCR7cXVldWVQcmVmaXh9LWRscWAsXG4gICAgICByZXRlbnRpb25QZXJpb2Q6IGNkay5EdXJhdGlvbi5kYXlzKDE0KSxcbiAgICAgIGVuY3J5cHRpb246IHNxcy5RdWV1ZUVuY3J5cHRpb24uU1FTX01BTkFHRUQsXG4gICAgfSk7XG5cbiAgICAvLyBXb3JrZmxvdyBRdWV1ZSAoZm9yIHdvcmtmbG93IGludm9jYXRpb25zKVxuICAgIHRoaXMud29ya2Zsb3dRdWV1ZSA9IG5ldyBzcXMuUXVldWUodGhpcywgXCJXb3JrZmxvd1F1ZXVlXCIsIHtcbiAgICAgIHF1ZXVlTmFtZTogYCR7cXVldWVQcmVmaXh9LWZsb3dzYCxcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg5MDApLCAvLyAxNSBtaW51dGVzXG4gICAgICByZWNlaXZlTWVzc2FnZVdhaXRUaW1lOiBjZGsuRHVyYXRpb24uc2Vjb25kcygyMCksIC8vIExvbmcgcG9sbGluZ1xuICAgICAgZW5jcnlwdGlvbjogc3FzLlF1ZXVlRW5jcnlwdGlvbi5TUVNfTUFOQUdFRCxcbiAgICAgIGRlYWRMZXR0ZXJRdWV1ZToge1xuICAgICAgICBxdWV1ZTogdGhpcy5kZWFkTGV0dGVyUXVldWUsXG4gICAgICAgIG1heFJlY2VpdmVDb3VudDogMyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBTdGVwIFF1ZXVlIChmb3Igc3RlcCBleGVjdXRpb25zKVxuICAgIHRoaXMuc3RlcFF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBcIldvcmtmbG93U3RlcFF1ZXVlXCIsIHtcbiAgICAgIHF1ZXVlTmFtZTogYCR7cXVldWVQcmVmaXh9LXN0ZXBzYCxcbiAgICAgIHZpc2liaWxpdHlUaW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg5MDApLCAvLyAxNSBtaW51dGVzXG4gICAgICByZWNlaXZlTWVzc2FnZVdhaXRUaW1lOiBjZGsuRHVyYXRpb24uc2Vjb25kcygyMCksIC8vIExvbmcgcG9sbGluZ1xuICAgICAgZW5jcnlwdGlvbjogc3FzLlF1ZXVlRW5jcnlwdGlvbi5TUVNfTUFOQUdFRCxcbiAgICAgIGRlYWRMZXR0ZXJRdWV1ZToge1xuICAgICAgICBxdWV1ZTogdGhpcy5kZWFkTGV0dGVyUXVldWUsXG4gICAgICAgIG1heFJlY2VpdmVDb3VudDogMyxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gTEFNQkRBIEZVTkNUSU9OIChXb3JrZXIgLSBQbGFjZWhvbGRlcilcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGV4ZWN1dGlvbiByb2xlXG4gICAgY29uc3QgbGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIldvcmtmbG93V29ya2VyUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImxhbWJkYS5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgZGVzY3JpcHRpb246IFwiRXhlY3V0aW9uIHJvbGUgZm9yIFdvcmtmbG93IHdvcmtlciBMYW1iZGFcIixcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXG4gICAgICAgICAgXCJzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCJcbiAgICAgICAgKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwiQVdTWFJheURhZW1vbldyaXRlQWNjZXNzXCIpLFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIExhbWJkYVxuICAgIHRoaXMucnVuc1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShsYW1iZGFSb2xlKTtcbiAgICB0aGlzLnN0ZXBzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGxhbWJkYVJvbGUpO1xuICAgIHRoaXMuZXZlbnRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGxhbWJkYVJvbGUpO1xuICAgIHRoaXMuaG9va3NUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEobGFtYmRhUm9sZSk7XG4gICAgdGhpcy5zdHJlYW1zVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGxhbWJkYVJvbGUpO1xuICAgIHRoaXMuc3RyZWFtQnVja2V0LmdyYW50UmVhZFdyaXRlKGxhbWJkYVJvbGUpO1xuICAgIHRoaXMud29ya2Zsb3dRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyhsYW1iZGFSb2xlKTtcbiAgICB0aGlzLnN0ZXBRdWV1ZS5ncmFudENvbnN1bWVNZXNzYWdlcyhsYW1iZGFSb2xlKTtcbiAgICB0aGlzLndvcmtmbG93UXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMobGFtYmRhUm9sZSk7XG4gICAgdGhpcy5zdGVwUXVldWUuZ3JhbnRTZW5kTWVzc2FnZXMobGFtYmRhUm9sZSk7XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGZ1bmN0aW9uIHdpdGggYWN0dWFsIHdvcmtmbG93IHByb2Nlc3NpbmdcbiAgICB0aGlzLndvcmtlckZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIldvcmtmbG93V29ya2VyXCIsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYCR7cXVldWVQcmVmaXh9LXdvcmtlcmAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFwiY2RrLm91dC9sYW1iZGEtd29ya2VyXCIsIHtcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBpbWFnZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1guYnVuZGxpbmdJbWFnZSxcbiAgICAgICAgICBjb21tYW5kOiBbXG4gICAgICAgICAgICBcImJhc2hcIixcbiAgICAgICAgICAgIFwiLWNcIixcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCJjcCAtciAvYXNzZXQtaW5wdXQvKiAvYXNzZXQtb3V0cHV0L1wiLFxuICAgICAgICAgICAgICBcImNkIC9hc3NldC1vdXRwdXRcIixcbiAgICAgICAgICAgICAgXCJucG0gaW5zdGFsbCAtLW9taXQ9ZGV2IC0tcHJvZHVjdGlvblwiLFxuICAgICAgICAgICAgXS5qb2luKFwiICYmIFwiKSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg5MDApLCAvLyAxNSBtaW51dGVzXG4gICAgICBtZW1vcnlTaXplOiA1MTIsXG4gICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUlVOU19UQUJMRV9OQU1FOiB0aGlzLnJ1bnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFNURVBTX1RBQkxFX05BTUU6IHRoaXMuc3RlcHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIEVWRU5UU19UQUJMRV9OQU1FOiB0aGlzLmV2ZW50c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgSE9PS1NfVEFCTEVfTkFNRTogdGhpcy5ob29rc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgU1RSRUFNU19UQUJMRV9OQU1FOiB0aGlzLnN0cmVhbXNUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFNUUkVBTV9CVUNLRVRfTkFNRTogdGhpcy5zdHJlYW1CdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgV09SS0ZMT1dfUVVFVUVfVVJMOiB0aGlzLndvcmtmbG93UXVldWUucXVldWVVcmwsXG4gICAgICAgIFNURVBfUVVFVUVfVVJMOiB0aGlzLnN0ZXBRdWV1ZS5xdWV1ZVVybCxcbiAgICAgICAgRU5WSVJPTk1FTlQ6IHByb3BzLmVudmlyb25tZW50LFxuICAgICAgICBBV1NfTk9ERUpTX0NPTk5FQ1RJT05fUkVVU0VfRU5BQkxFRDogXCIxXCIsXG4gICAgICAgIE5PREVfT1BUSU9OUzogXCItLWVuYWJsZS1zb3VyY2UtbWFwc1wiLFxuICAgICAgfSxcbiAgICAgIHRyYWNpbmc6IGxhbWJkYS5UcmFjaW5nLkFDVElWRSxcbiAgICAgIGxvZ1JldGVudGlvbjogaXNQcm9kXG4gICAgICAgID8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgICAgICA6IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6XG4gICAgICAgIHByb3BzLmVudmlyb25tZW50ID09PSBcImRldlwiID8gMTAgOiB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgU1FTIGV2ZW50IHNvdXJjZXMgdG8gTGFtYmRhXG4gICAgdGhpcy53b3JrZXJGdW5jdGlvbi5hZGRFdmVudFNvdXJjZShcbiAgICAgIG5ldyBTcXNFdmVudFNvdXJjZSh0aGlzLndvcmtmbG93UXVldWUsIHtcbiAgICAgICAgYmF0Y2hTaXplOiAxMCxcbiAgICAgICAgbWF4QmF0Y2hpbmdXaW5kb3c6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICByZXBvcnRCYXRjaEl0ZW1GYWlsdXJlczogdHJ1ZSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIHRoaXMud29ya2VyRnVuY3Rpb24uYWRkRXZlbnRTb3VyY2UoXG4gICAgICBuZXcgU3FzRXZlbnRTb3VyY2UodGhpcy5zdGVwUXVldWUsIHtcbiAgICAgICAgYmF0Y2hTaXplOiAxMCxcbiAgICAgICAgbWF4QmF0Y2hpbmdXaW5kb3c6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxuICAgICAgICByZXBvcnRCYXRjaEl0ZW1GYWlsdXJlczogdHJ1ZSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBPVVRQVVRTXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJSdW5zVGFibGVOYW1lXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJ1bnNUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJEeW5hbW9EQiB0YWJsZSBmb3Igd29ya2Zsb3cgcnVuc1wiLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJvcHMuc3RhY2tOYW1lfS1ydW5zLXRhYmxlYCxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU3RlcHNUYWJsZU5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuc3RlcHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJEeW5hbW9EQiB0YWJsZSBmb3Igd29ya2Zsb3cgc3RlcHNcIixcbiAgICAgIGV4cG9ydE5hbWU6IGAke3Byb3BzLnN0YWNrTmFtZX0tc3RlcHMtdGFibGVgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJFdmVudHNUYWJsZU5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuZXZlbnRzVGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246IFwiRHluYW1vREIgdGFibGUgZm9yIHdvcmtmbG93IGV2ZW50c1wiLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJvcHMuc3RhY2tOYW1lfS1ldmVudHMtdGFibGVgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJIb29rc1RhYmxlTmFtZVwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5ob29rc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkR5bmFtb0RCIHRhYmxlIGZvciB3b3JrZmxvdyBob29rc1wiLFxuICAgICAgZXhwb3J0TmFtZTogYCR7cHJvcHMuc3RhY2tOYW1lfS1ob29rcy10YWJsZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlN0cmVhbXNUYWJsZU5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuc3RyZWFtc1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkR5bmFtb0RCIHRhYmxlIGZvciBzdHJlYW0gY2h1bmsgbWV0YWRhdGFcIixcbiAgICAgIGV4cG9ydE5hbWU6IGAke3Byb3BzLnN0YWNrTmFtZX0tc3RyZWFtcy10YWJsZWAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlN0cmVhbUJ1Y2tldE5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuc3RyZWFtQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJTMyBidWNrZXQgZm9yIHN0cmVhbSBjaHVua3NcIixcbiAgICAgIGV4cG9ydE5hbWU6IGAke3Byb3BzLnN0YWNrTmFtZX0tc3RyZWFtLWJ1Y2tldGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIldvcmtmbG93UXVldWVVcmxcIiwge1xuICAgICAgdmFsdWU6IHRoaXMud29ya2Zsb3dRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIlNRUyBxdWV1ZSBVUkwgZm9yIHdvcmtmbG93IGludm9jYXRpb25zXCIsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcm9wcy5zdGFja05hbWV9LXdvcmtmbG93LXF1ZXVlLXVybGAsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlN0ZXBRdWV1ZVVybFwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5zdGVwUXVldWUucXVldWVVcmwsXG4gICAgICBkZXNjcmlwdGlvbjogXCJTUVMgcXVldWUgVVJMIGZvciBzdGVwIGV4ZWN1dGlvbnNcIixcbiAgICAgIGV4cG9ydE5hbWU6IGAke3Byb3BzLnN0YWNrTmFtZX0tc3RlcC1xdWV1ZS11cmxgLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJXb3JrZXJGdW5jdGlvbkFyblwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy53b3JrZXJGdW5jdGlvbi5mdW5jdGlvbkFybixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkxhbWJkYSB3b3JrZXIgZnVuY3Rpb24gQVJOXCIsXG4gICAgICBleHBvcnROYW1lOiBgJHtwcm9wcy5zdGFja05hbWV9LXdvcmtlci1mdW5jdGlvbi1hcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJSZWdpb25cIiwge1xuICAgICAgdmFsdWU6IGNkay5Bd3MuUkVHSU9OLFxuICAgICAgZGVzY3JpcHRpb246IFwiQVdTIFJlZ2lvblwiLFxuICAgIH0pO1xuICB9XG59XG4iXX0=
