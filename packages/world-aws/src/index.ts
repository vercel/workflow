import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Storage, World } from '@workflow/world';
import type { AwsWorldConfig } from './config.js';
import { resolveConfig, tableNames } from './config.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): Storage {
  return {
    runs: createRunsStorage(dynamo, tables),
    events: createEventsStorage(dynamo, tables),
    hooks: createHooksStorage(dynamo, tables),
    steps: createStepsStorage(dynamo, tables),
  };
}

export function createWorld(
  config?: Partial<AwsWorldConfig>
): World & { start(): Promise<void> } {
  const resolved = resolveConfig(config);
  const tables = tableNames(resolved.tablePrefix);

  const dynamo = new DynamoDBClient({
    region: resolved.region,
    endpoint: resolved.dynamoDbEndpoint,
    ...config?.dynamoDbConfig,
  });

  const sqs = new SQSClient({
    region: resolved.region,
    endpoint: resolved.sqsEndpoint,
    ...config?.sqsConfig,
  });

  const storage = createStorage(dynamo, tables);
  const queue = createQueue(resolved, sqs);
  const streamer = createStreamer(dynamo, tables);

  return {
    ...storage,
    ...streamer,
    ...queue,
    async start() {
      await queue.start();
    },
    async close() {
      await streamer.close();
      await queue.close();
      dynamo.destroy();
      sqs.destroy();
    },
  };
}

export type { AwsWorldConfig } from './config.js';
export { ensureTables } from './dynamo.js';
export { tableNames } from './config.js';
