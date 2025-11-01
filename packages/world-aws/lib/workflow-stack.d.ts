import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
export interface WorkflowStackProps extends cdk.StackProps {
  stackName: string;
  environment: 'dev' | 'staging' | 'prod';
  tablePrefix?: string;
  queuePrefix?: string;
}
export declare class WorkflowStack extends cdk.Stack {
  readonly runsTable: dynamodb.Table;
  readonly stepsTable: dynamodb.Table;
  readonly eventsTable: dynamodb.Table;
  readonly hooksTable: dynamodb.Table;
  readonly streamsTable: dynamodb.Table;
  readonly workflowQueue: sqs.Queue;
  readonly stepQueue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly streamBucket: s3.Bucket;
  readonly workerFunction: lambda.Function;
  constructor(scope: Construct, id: string, props: WorkflowStackProps);
}
