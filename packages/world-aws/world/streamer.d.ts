import { type S3Client } from '@aws-sdk/client-s3';
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Streamer } from '@workflow/world';
import type { AWSWorldConfig } from './config.js';
export declare function createStreamer(
  s3Client: S3Client,
  dynamoClient: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Streamer;
