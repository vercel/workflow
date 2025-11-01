import { type SQSClient } from '@aws-sdk/client-sqs';
import { type Queue } from '@workflow/world';
import type { AWSWorldConfig } from './config.js';
export declare function createQueue(
  client: SQSClient,
  config: AWSWorldConfig
): Queue & {
  start(): Promise<void>;
};
