import {
  CreateTableCommand,
  type CreateTableInput,
  DescribeTableCommand,
  DynamoDBClient,
  type GlobalSecondaryIndex,
} from '@aws-sdk/client-dynamodb';
import type { AwsWorldConfig } from './config.js';
import { tableNames } from './config.js';

export function createDynamoClient(config: AwsWorldConfig): DynamoDBClient {
  return new DynamoDBClient({
    region: config.region,
    endpoint: config.dynamoDbEndpoint,
    ...config.dynamoDbConfig,
  });
}

/**
 * Table definitions for all DynamoDB tables used by the AWS world.
 * Uses on-demand (PAY_PER_REQUEST) billing by default.
 */
export function getTableDefinitions(prefix: string): CreateTableInput[] {
  const names = tableNames(prefix);

  return [
    // Runs table
    {
      TableName: names.runs,
      KeySchema: [{ AttributeName: 'runId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'runId', AttributeType: 'S' },
        { AttributeName: 'workflowName', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        gsi('gsi_workflowName', 'workflowName', 'createdAt'),
        gsi('gsi_status', 'status', 'createdAt'),
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },

    // Events table
    {
      TableName: names.events,
      KeySchema: [
        { AttributeName: 'runId', KeyType: 'HASH' },
        { AttributeName: 'eventId', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'runId', AttributeType: 'S' },
        { AttributeName: 'eventId', AttributeType: 'S' },
        { AttributeName: 'correlationId', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        gsi('gsi_correlationId', 'correlationId', 'createdAt'),
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },

    // Steps table
    {
      TableName: names.steps,
      KeySchema: [{ AttributeName: 'stepId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'stepId', AttributeType: 'S' },
        { AttributeName: 'runId', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        gsi('gsi_runId', 'runId', 'stepId'),
        gsi('gsi_status', 'status', 'stepId'),
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },

    // Hooks table
    {
      TableName: names.hooks,
      KeySchema: [{ AttributeName: 'hookId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'hookId', AttributeType: 'S' },
        { AttributeName: 'runId', AttributeType: 'S' },
        { AttributeName: 'token', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        gsi('gsi_runId', 'runId', 'hookId'),
        gsi('gsi_token', 'token', 'hookId'),
      ],
      BillingMode: 'PAY_PER_REQUEST',
    },

    // Waits table
    {
      TableName: names.waits,
      KeySchema: [{ AttributeName: 'waitId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'waitId', AttributeType: 'S' },
        { AttributeName: 'runId', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [gsi('gsi_runId', 'runId', 'waitId')],
      BillingMode: 'PAY_PER_REQUEST',
    },

    // Streams table
    {
      TableName: names.streams,
      KeySchema: [
        { AttributeName: 'streamId', KeyType: 'HASH' },
        { AttributeName: 'chunkId', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'streamId', AttributeType: 'S' },
        { AttributeName: 'chunkId', AttributeType: 'S' },
        { AttributeName: 'runId', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [gsi('gsi_runId', 'runId', 'streamId')],
      BillingMode: 'PAY_PER_REQUEST',
    },
  ];
}

function gsi(
  name: string,
  hashKey: string,
  rangeKey: string
): GlobalSecondaryIndex {
  return {
    IndexName: name,
    KeySchema: [
      { AttributeName: hashKey, KeyType: 'HASH' },
      { AttributeName: rangeKey, KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  };
}

/** Create all DynamoDB tables if they don't already exist. */
export async function ensureTables(
  client: DynamoDBClient,
  prefix: string
): Promise<void> {
  const definitions = getTableDefinitions(prefix);

  for (const def of definitions) {
    try {
      await client.send(new DescribeTableCommand({ TableName: def.TableName }));
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        await client.send(new CreateTableCommand(def));
        // Wait for table to become active
        await waitForTable(client, def.TableName!);
      } else {
        throw err;
      }
    }
  }
}

async function waitForTable(
  client: DynamoDBClient,
  tableName: string,
  maxAttempts = 30
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const { Table } = await client.send(
      new DescribeTableCommand({ TableName: tableName })
    );
    if (Table?.TableStatus === 'ACTIVE') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Table ${tableName} did not become ACTIVE`);
}
