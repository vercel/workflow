import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Storage } from '@workflow/world';
import type { AWSWorldConfig } from './config.js';
export declare function createStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage;
