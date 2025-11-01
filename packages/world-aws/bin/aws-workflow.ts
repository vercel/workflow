#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { WorkflowStack } from '../lib/workflow-stack';

const app = new cdk.App();

// Get configuration from context or environment
const environment =
  app.node.tryGetContext('environment') || process.env.ENVIRONMENT || 'dev';
const stackName =
  app.node.tryGetContext('stackName') ||
  process.env.STACK_NAME ||
  'WorkflowStack';
const region =
  app.node.tryGetContext('region') || process.env.AWS_REGION || 'us-east-1';

// Use the stack name as both construct ID and CloudFormation stack name
new WorkflowStack(app, stackName, {
  stackName: stackName,
  description: 'AWS Workflow DevKit Infrastructure - DynamoDB, SQS, Lambda, S3',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: region,
  },
  // Configuration
  environment: environment as 'dev' | 'staging' | 'prod',
  tablePrefix: app.node.tryGetContext('tablePrefix') || 'workflow',
  queuePrefix: app.node.tryGetContext('queuePrefix') || 'workflow',
  tags: {
    Project: 'Workflow',
    Environment: environment,
    ManagedBy: 'CDK',
  },
});
