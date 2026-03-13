import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { resolveConfig, tableNames } from './config.js';
import { ensureTables } from './dynamo.js';

async function main() {
  console.log('[workflow-aws-setup] Setting up DynamoDB tables...');

  const config = resolveConfig();
  const tables = tableNames(config.tablePrefix);

  console.log(`[workflow-aws-setup] Region: ${config.region}`);
  console.log(`[workflow-aws-setup] Table prefix: ${config.tablePrefix}`);
  if (config.dynamoDbEndpoint) {
    console.log(
      `[workflow-aws-setup] DynamoDB endpoint: ${config.dynamoDbEndpoint}`
    );
  }
  console.log('[workflow-aws-setup] Tables to create:');
  for (const [key, name] of Object.entries(tables)) {
    console.log(`  - ${key}: ${name}`);
  }

  const client = new DynamoDBClient({
    region: config.region,
    endpoint: config.dynamoDbEndpoint,
    ...config.dynamoDbConfig,
  });

  try {
    await ensureTables(client, config.tablePrefix);
    console.log('[workflow-aws-setup] All tables created successfully.');
  } catch (err) {
    console.error('[workflow-aws-setup] Failed to create tables:', err);
    process.exit(1);
  } finally {
    client.destroy();
  }
}

main();
