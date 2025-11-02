import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { World } from '@workflow/world';
import { getDefaultConfig, type AWSWorldConfig } from './config.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export type { AWSWorldConfig } from './config.js';

export function createWorld(config: Partial<AWSWorldConfig> = {}): World {
  const fullConfig: AWSWorldConfig = {
    ...getDefaultConfig(),
    ...config,
  };

  // Create AWS SDK clients
  // Only include credentials if explicitly provided, otherwise use Lambda's IAM role
  const clientConfig: {
    region: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
  } = {
    region: fullConfig.region,
  };
  if (fullConfig.credentials) {
    clientConfig.credentials = fullConfig.credentials;
    console.log(
      '🔐 Using explicit credentials (first 4 chars):',
      fullConfig.credentials.accessKeyId?.substring(0, 4)
    );
  } else {
    console.log(
      '🔐 Using Lambda IAM role credentials (no explicit credentials provided)'
    );
  }
  console.log('🌍 AWS Region:', clientConfig.region);

  const dynamoClient = new DynamoDBClient(clientConfig);
  const dynamoDocClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
  const sqsClient = new SQSClient(clientConfig);
  const s3Client = new S3Client(clientConfig);

  // Create world components
  const storage = createStorage(dynamoDocClient, fullConfig);
  const queue = createQueue(sqsClient, fullConfig);
  const streamer = createStreamer(s3Client, dynamoDocClient, fullConfig);

  return {
    ...storage,
    ...streamer,
    ...queue,
  };
}
