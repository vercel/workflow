import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { SQSClientConfig } from '@aws-sdk/client-sqs';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

export interface AwsWorldConfig {
  /** AWS region (default: from AWS_REGION env var or 'us-east-1') */
  region?: string;

  /** Prefix for all DynamoDB table names (default: 'workflow') */
  tablePrefix?: string;

  /**
   * SQS queue URLs. If not provided, they will be derived from the queue prefix
   * and region. For FIFO queues, append '.fifo' to the URL.
   */
  sqsWorkflowQueueUrl?: string;
  sqsStepQueueUrl?: string;

  /** Concurrency limit for SQS message polling (default: 10) */
  queueConcurrency?: number;

  /** Polling interval in milliseconds for SQS long-polling (default: 1000) */
  pollIntervalMs?: number;

  /** Optional custom DynamoDB client configuration */
  dynamoDbConfig?: DynamoDBClientConfig;

  /** Optional custom SQS client configuration */
  sqsConfig?: SQSClientConfig;

  /** Optional custom S3 client configuration (for stream chunks, optional) */
  s3Config?: S3ClientConfig;

  /**
   * Optional DynamoDB endpoint override (useful for local development with
   * DynamoDB Local or LocalStack)
   */
  dynamoDbEndpoint?: string;

  /** Optional SQS endpoint override */
  sqsEndpoint?: string;
}

export function resolveConfig(
  config?: Partial<AwsWorldConfig>
): Required<
  Pick<
    AwsWorldConfig,
    'region' | 'tablePrefix' | 'queueConcurrency' | 'pollIntervalMs'
  >
> &
  AwsWorldConfig {
  const region =
    config?.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    'us-east-1';

  const tablePrefix =
    config?.tablePrefix || process.env.WORKFLOW_AWS_TABLE_PREFIX || 'workflow';

  const queueConcurrency =
    config?.queueConcurrency ||
    parseInt(process.env.WORKFLOW_AWS_QUEUE_CONCURRENCY || '10', 10) ||
    10;

  const pollIntervalMs =
    config?.pollIntervalMs ||
    parseInt(process.env.WORKFLOW_AWS_POLL_INTERVAL_MS || '1000', 10) ||
    1000;

  return {
    ...config,
    region,
    tablePrefix,
    queueConcurrency,
    pollIntervalMs,
    sqsWorkflowQueueUrl:
      config?.sqsWorkflowQueueUrl ||
      process.env.WORKFLOW_AWS_SQS_WORKFLOW_QUEUE_URL,
    sqsStepQueueUrl:
      config?.sqsStepQueueUrl || process.env.WORKFLOW_AWS_SQS_STEP_QUEUE_URL,
    dynamoDbEndpoint:
      config?.dynamoDbEndpoint || process.env.WORKFLOW_AWS_DYNAMODB_ENDPOINT,
    sqsEndpoint: config?.sqsEndpoint || process.env.WORKFLOW_AWS_SQS_ENDPOINT,
  };
}

/** DynamoDB table names derived from a prefix. */
export function tableNames(prefix: string) {
  return {
    runs: `${prefix}_runs`,
    events: `${prefix}_events`,
    steps: `${prefix}_steps`,
    hooks: `${prefix}_hooks`,
    waits: `${prefix}_waits`,
    streams: `${prefix}_streams`,
  } as const;
}
