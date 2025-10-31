import {
  QueryCommand as DocQueryCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { WorkflowAPIError } from '@workflow/errors';
import {
  type Event,
  type Hook,
  type PaginatedResponse,
  type Step,
  StepSchema,
  type Storage,
  type WorkflowRun,
  WorkflowRunSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import type { AWSWorldConfig } from './config.js';

export function createStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage {
  return {
    runs: createRunsStorage(client, config),
    steps: createStepsStorage(client, config),
    events: createEventsStorage(client, config),
    hooks: createHooksStorage(client, config),
  };
}

function createRunsStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage['runs'] {
  const tableName = config.tables.runs;
  const ulid = monotonicFactory();

  return {
    async create(data): Promise<WorkflowRun> {
      const runId = `run_${ulid()}`;
      const now = new Date().toISOString();

      const run: WorkflowRun = {
        runId,
        workflowName: data.workflowName,
        status: 'running',
        input: data.input,
        deploymentId: 'default',
        createdAt: now as any, // Store as ISO string for DynamoDB
        updatedAt: now as any, // Store as ISO string for DynamoDB
        startedAt: now as any, // Store as ISO string for DynamoDB
      };

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: run,
        })
      );

      return run;
    },

    async get(id): Promise<WorkflowRun> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { runId: id },
        })
      );

      if (!result.Item) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Parse through schema to convert ISO strings to Date objects
      return WorkflowRunSchema.parse(result.Item);
    },

    async update(id, data): Promise<WorkflowRun> {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      // Build update expression dynamically
      if (data.status !== undefined) {
        updateExpressions.push('#status = :status');
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = data.status;

        // Automatically set startedAt when transitioning to 'running'
        if (data.status === 'running' && !(data as any).startedAt) {
          (data as any).startedAt = new Date().toISOString();
        }
      }

      if (data.output !== undefined) {
        updateExpressions.push('#output = :output');
        expressionAttributeNames['#output'] = 'output';
        expressionAttributeValues[':output'] = data.output;
      }

      if (data.error !== undefined) {
        updateExpressions.push('#error = :error');
        expressionAttributeNames['#error'] = 'error';
        expressionAttributeValues[':error'] = data.error;
      }

      if ((data as any).startedAt !== undefined) {
        updateExpressions.push('#startedAt = :startedAt');
        expressionAttributeNames['#startedAt'] = 'startedAt';
        const startedAt = (data as any).startedAt;
        expressionAttributeValues[':startedAt'] =
          startedAt instanceof Date ? startedAt.toISOString() : startedAt;
      }

      if ((data as any).finishedAt !== undefined) {
        updateExpressions.push('#finishedAt = :finishedAt');
        expressionAttributeNames['#finishedAt'] = 'finishedAt';
        const finishedAt = (data as any).finishedAt;
        expressionAttributeValues[':finishedAt'] =
          finishedAt instanceof Date ? finishedAt.toISOString() : finishedAt;
      }

      // Always update updatedAt
      updateExpressions.push('#updatedAt = :updatedAt');
      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { runId: id },
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }

      // Parse through schema to convert ISO strings to Date objects
      return WorkflowRunSchema.parse(result.Attributes);
    },

    async list(params): Promise<PaginatedResponse<WorkflowRun>> {
      const limit = params?.pagination?.limit ?? 20;
      const queryParams: any = {
        TableName: tableName,
        Limit: limit,
      };

      if (params?.pagination?.cursor) {
        queryParams.ExclusiveStartKey = { runId: params.pagination.cursor };
      }

      if (params?.workflowName) {
        // If querying by workflow name, we need a GSI
        queryParams.IndexName = 'workflowName-index';
        queryParams.KeyConditionExpression = 'workflowName = :workflowName';
        queryParams.ExpressionAttributeValues = {
          ':workflowName': params.workflowName,
        };
        queryParams.ScanIndexForward = true;
      }

      const result = params?.workflowName
        ? await client.send(new DocQueryCommand(queryParams))
        : await client.send(
            new DocQueryCommand({
              ...queryParams,
              // For scan operations when no workflow name is provided
            })
          );

      const items = (result.Items || []) as WorkflowRun[];

      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: (result.LastEvaluatedKey?.runId as string | null) ?? null,
      };
    },

    async cancel(id): Promise<WorkflowRun> {
      return this.update(id, {
        status: 'cancelled',
      });
    },

    async pause(id): Promise<WorkflowRun> {
      return this.update(id, {
        status: 'paused',
      });
    },

    async resume(id): Promise<WorkflowRun> {
      const run = await this.get(id);
      if (run.status !== 'paused') {
        throw new WorkflowAPIError(`Run is not paused: ${id}`, { status: 400 });
      }
      return this.update(id, {
        status: 'running',
      });
    },
  };
}

function createStepsStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage['steps'] {
  const tableName = config.tables.steps;
  const ulid = monotonicFactory();

  return {
    async create(runId, data): Promise<Step> {
      // Preserve runtime-provided stepId (correlationId) for deterministic replay
      // Fallback to a new ULID if not provided
      const stepId = (data as any).stepId ?? `step_${ulid()}`;
      const now = new Date().toISOString();

      const step: Step = {
        stepId,
        runId,
        stepName: data.stepName,
        status: 'pending',
        input: data.input,
        attempt: 0,
        createdAt: now as any, // Store as ISO string for DynamoDB
        updatedAt: now as any,
      };

      // Ensure idempotency: don't overwrite if the step already exists
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: step,
            ConditionExpression: 'attribute_not_exists(stepId)',
          })
        );
      } catch (err: any) {
        // ConditionalCheckFailedException → step already exists
        if (err && err.name === 'ConditionalCheckFailedException') {
          throw new WorkflowAPIError(`Step already exists: ${stepId}`, {
            status: 409,
          });
        }
        throw err;
      }

      return step;
    },

    async get(runId, stepId): Promise<Step> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { stepId, runId },
        })
      );

      if (!result.Item) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      // Parse through schema to convert ISO strings to Date objects
      return StepSchema.parse(result.Item);
    },

    async update(runId, stepId, data): Promise<Step> {
      const updateExpressions: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      if (data.status !== undefined) {
        updateExpressions.push('#status = :status');
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = data.status;

        // Automatically set startedAt when transitioning to 'running'
        if (data.status === 'running' && !(data as any).startedAt) {
          (data as any).startedAt = new Date().toISOString();
        }
      }

      if (data.attempt !== undefined) {
        updateExpressions.push('#attempt = :attempt');
        expressionAttributeNames['#attempt'] = 'attempt';
        expressionAttributeValues[':attempt'] = data.attempt;
      }

      if ((data as any).startedAt !== undefined) {
        updateExpressions.push('#startedAt = :startedAt');
        expressionAttributeNames['#startedAt'] = 'startedAt';
        const startedAt = (data as any).startedAt;
        expressionAttributeValues[':startedAt'] =
          startedAt instanceof Date ? startedAt.toISOString() : startedAt;
      }

      if (data.output !== undefined) {
        updateExpressions.push('#output = :output');
        expressionAttributeNames['#output'] = 'output';
        expressionAttributeValues[':output'] = data.output;
      }

      if (data.error !== undefined) {
        updateExpressions.push('#error = :error');
        expressionAttributeNames['#error'] = 'error';
        expressionAttributeValues[':error'] = data.error;
      }

      updateExpressions.push('#updatedAt = :updatedAt');
      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();

      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { stepId, runId },
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }

      // Parse through schema to convert ISO strings to Date objects
      return StepSchema.parse(result.Attributes);
    },

    async list(params): Promise<PaginatedResponse<Step>> {
      const limit = params?.pagination?.limit ?? 20;

      const result = await client.send(
        new DocQueryCommand({
          TableName: tableName,
          IndexName: 'runId-createdAt-index',
          KeyConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: {
            ':runId': params.runId,
          },
          Limit: limit,
          ExclusiveStartKey: params?.pagination?.cursor
            ? { runId: params.runId, stepId: params.pagination.cursor }
            : undefined,
          ScanIndexForward: true,
        })
      );

      const items = (result.Items || []) as Step[];

      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: (result.LastEvaluatedKey?.stepId as string | null) ?? null,
      };
    },
  };
}

function createEventsStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage['events'] {
  const tableName = config.tables.events;
  const ulid = monotonicFactory();

  return {
    async create(runId, data): Promise<Event> {
      const eventId = `evt_${ulid()}`;
      const now = new Date().toISOString();

      const event: Event = {
        ...(data as any),
        eventId,
        runId,
        createdAt: now as any, // Store as ISO string for DynamoDB
      };

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: event,
        })
      );

      return event;
    },

    async list(params): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 20;

      const result = await client.send(
        new DocQueryCommand({
          TableName: tableName,
          IndexName: 'runId-createdAt-index',
          KeyConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: {
            ':runId': params.runId,
          },
          Limit: limit,
          ExclusiveStartKey: params?.pagination?.cursor
            ? { runId: params.runId, eventId: params.pagination.cursor }
            : undefined,
          ScanIndexForward: true,
        })
      );

      const items = (result.Items || []) as Event[];

      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: (result.LastEvaluatedKey?.eventId as string | null) ?? null,
      };
    },

    async listByCorrelationId(params): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 20;

      const result = await client.send(
        new DocQueryCommand({
          TableName: tableName,
          IndexName: 'correlationId-index',
          KeyConditionExpression: 'correlationId = :correlationId',
          ExpressionAttributeValues: {
            ':correlationId': params.correlationId,
          },
          Limit: limit,
          ExclusiveStartKey: params?.pagination?.cursor
            ? {
                correlationId: params.correlationId,
                eventId: params.pagination.cursor,
              }
            : undefined,
        })
      );

      const items = (result.Items || []) as Event[];

      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: (result.LastEvaluatedKey?.eventId as string | null) ?? null,
      };
    },
  };
}

function createHooksStorage(
  client: DynamoDBDocumentClient,
  config: AWSWorldConfig
): Storage['hooks'] {
  const tableName = config.tables.hooks;
  const ulid = monotonicFactory();

  function generateToken(): string {
    return `tok_${ulid()}`;
  }

  return {
    async create(runId, _data): Promise<Hook> {
      const hookId = `hook_${ulid()}`;
      const token = generateToken();
      const now = new Date().toISOString();

      const hook: Hook = {
        hookId,
        runId,
        token,
        ownerId: 'aws',
        projectId: 'default',
        environment: 'production',
        createdAt: now as any, // Store as ISO string for DynamoDB
      };

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: hook,
        })
      );

      return hook;
    },

    async get(hookId): Promise<Hook> {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { hookId },
        })
      );

      if (!result.Item) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }

      return result.Item as Hook;
    },

    async getByToken(token): Promise<Hook> {
      const result = await client.send(
        new DocQueryCommand({
          TableName: tableName,
          IndexName: 'token-index',
          KeyConditionExpression: 'token = :token',
          ExpressionAttributeValues: {
            ':token': token,
          },
          Limit: 1,
        })
      );

      const item = result.Items?.[0];
      if (!item) {
        throw new WorkflowAPIError(`Hook not found for token`, { status: 404 });
      }

      return item as Hook;
    },

    async dispose(hookId): Promise<Hook> {
      const hook = await this.get(hookId);
      // In DynamoDB, we just return the hook as-is since we can't update it
      // (Hook type doesn't have a status field anymore)
      return hook;
    },

    async list(params): Promise<PaginatedResponse<Hook>> {
      const limit = params?.pagination?.limit ?? 20;

      const result = await client.send(
        new DocQueryCommand({
          TableName: tableName,
          IndexName: 'runId-createdAt-index',
          KeyConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: {
            ':runId': params.runId,
          },
          Limit: limit,
          ExclusiveStartKey: params?.pagination?.cursor
            ? { runId: params.runId, hookId: params.pagination.cursor }
            : undefined,
          ScanIndexForward: true,
        })
      );

      const items = (result.Items || []) as Hook[];

      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: (result.LastEvaluatedKey?.hookId as string | null) ?? null,
      };
    },
  };
}
