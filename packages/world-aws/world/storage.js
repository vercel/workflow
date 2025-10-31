'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createStorage = void 0;
const lib_dynamodb_1 = require('@aws-sdk/lib-dynamodb');
const errors_1 = require('@workflow/errors');
const ulid_1 = require('ulid');
function createStorage(client, config) {
  return {
    runs: createRunsStorage(client, config),
    steps: createStepsStorage(client, config),
    events: createEventsStorage(client, config),
    hooks: createHooksStorage(client, config),
  };
}
exports.createStorage = createStorage;
function createRunsStorage(client, config) {
  const tableName = config.tables.runs;
  const ulid = (0, ulid_1.monotonicFactory)();
  return {
    async create(data) {
      const runId = `run_${ulid()}`;
      const now = new Date().toISOString();
      const run = {
        runId,
        workflowName: data.workflowName,
        status: 'running',
        input: data.input,
        deploymentId: 'default',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };
      await client.send(
        new lib_dynamodb_1.PutCommand({
          TableName: tableName,
          Item: run,
        })
      );
      return run;
    },
    async get(id) {
      const result = await client.send(
        new lib_dynamodb_1.GetCommand({
          TableName: tableName,
          Key: { runId: id },
        })
      );
      if (!result.Item) {
        throw new errors_1.WorkflowAPIError(`Run not found: ${id}`, {
          status: 404,
        });
      }
      return result.Item;
    },
    async update(id, data) {
      const updateExpressions = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      // Build update expression dynamically
      if (data.status !== undefined) {
        updateExpressions.push('#status = :status');
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = data.status;
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
      if (data.startedAt !== undefined) {
        updateExpressions.push('#startedAt = :startedAt');
        expressionAttributeNames['#startedAt'] = 'startedAt';
        const startedAt = data.startedAt;
        expressionAttributeValues[':startedAt'] =
          startedAt instanceof Date ? startedAt.toISOString() : startedAt;
      }
      if (data.finishedAt !== undefined) {
        updateExpressions.push('#finishedAt = :finishedAt');
        expressionAttributeNames['#finishedAt'] = 'finishedAt';
        const finishedAt = data.finishedAt;
        expressionAttributeValues[':finishedAt'] =
          finishedAt instanceof Date ? finishedAt.toISOString() : finishedAt;
      }
      // Always update updatedAt
      updateExpressions.push('#updatedAt = :updatedAt');
      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      expressionAttributeValues[':updatedAt'] = new Date().toISOString();
      const result = await client.send(
        new lib_dynamodb_1.UpdateCommand({
          TableName: tableName,
          Key: { runId: id },
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        })
      );
      if (!result.Attributes) {
        throw new errors_1.WorkflowAPIError(`Run not found: ${id}`, {
          status: 404,
        });
      }
      return result.Attributes;
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const queryParams = {
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
        ? await client.send(new lib_dynamodb_1.QueryCommand(queryParams))
        : await client.send(
            new lib_dynamodb_1.QueryCommand({
              ...queryParams,
              // For scan operations when no workflow name is provided
            })
          );
      const items = result.Items || [];
      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: result.LastEvaluatedKey?.runId ?? null,
      };
    },
    async cancel(id) {
      return this.update(id, {
        status: 'cancelled',
      });
    },
    async pause(id) {
      return this.update(id, {
        status: 'paused',
      });
    },
    async resume(id) {
      const run = await this.get(id);
      if (run.status !== 'paused') {
        throw new errors_1.WorkflowAPIError(`Run is not paused: ${id}`, {
          status: 400,
        });
      }
      return this.update(id, {
        status: 'running',
      });
    },
  };
}
function createStepsStorage(client, config) {
  const tableName = config.tables.steps;
  const ulid = (0, ulid_1.monotonicFactory)();
  return {
    async create(runId, data) {
      const stepId = `step_${ulid()}`;
      const now = new Date().toISOString();
      const step = {
        stepId,
        runId,
        stepName: data.stepName,
        status: 'pending',
        input: data.input,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      };
      await client.send(
        new lib_dynamodb_1.PutCommand({
          TableName: tableName,
          Item: step,
        })
      );
      return step;
    },
    async get(runId, stepId) {
      const result = await client.send(
        new lib_dynamodb_1.GetCommand({
          TableName: tableName,
          Key: { stepId, runId },
        })
      );
      if (!result.Item) {
        throw new errors_1.WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return result.Item;
    },
    async update(runId, stepId, data) {
      const updateExpressions = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      if (data.status !== undefined) {
        updateExpressions.push('#status = :status');
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = data.status;
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
        new lib_dynamodb_1.UpdateCommand({
          TableName: tableName,
          Key: { stepId, runId },
          UpdateExpression: `SET ${updateExpressions.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        })
      );
      if (!result.Attributes) {
        throw new errors_1.WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      return result.Attributes;
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const result = await client.send(
        new lib_dynamodb_1.QueryCommand({
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
      const items = result.Items || [];
      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: result.LastEvaluatedKey?.stepId ?? null,
      };
    },
  };
}
function createEventsStorage(client, config) {
  const tableName = config.tables.events;
  const ulid = (0, ulid_1.monotonicFactory)();
  return {
    async create(runId, data) {
      const eventId = `evt_${ulid()}`;
      const now = new Date().toISOString();
      const event = {
        ...data,
        eventId,
        runId,
        createdAt: now,
      };
      await client.send(
        new lib_dynamodb_1.PutCommand({
          TableName: tableName,
          Item: event,
        })
      );
      return event;
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const result = await client.send(
        new lib_dynamodb_1.QueryCommand({
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
      const items = result.Items || [];
      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: result.LastEvaluatedKey?.eventId ?? null,
      };
    },
    async listByCorrelationId(params) {
      const limit = params?.pagination?.limit ?? 20;
      const result = await client.send(
        new lib_dynamodb_1.QueryCommand({
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
      const items = result.Items || [];
      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: result.LastEvaluatedKey?.eventId ?? null,
      };
    },
  };
}
function createHooksStorage(client, config) {
  const tableName = config.tables.hooks;
  const ulid = (0, ulid_1.monotonicFactory)();
  function generateToken() {
    return `tok_${ulid()}`;
  }
  return {
    async create(runId, data) {
      const hookId = `hook_${ulid()}`;
      const token = generateToken();
      const now = new Date().toISOString();
      const hook = {
        hookId,
        runId,
        token,
        ownerId: 'aws',
        projectId: 'default',
        environment: 'production',
        createdAt: now,
      };
      await client.send(
        new lib_dynamodb_1.PutCommand({
          TableName: tableName,
          Item: hook,
        })
      );
      return hook;
    },
    async get(hookId) {
      const result = await client.send(
        new lib_dynamodb_1.GetCommand({
          TableName: tableName,
          Key: { hookId },
        })
      );
      if (!result.Item) {
        throw new errors_1.WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      return result.Item;
    },
    async getByToken(token) {
      const result = await client.send(
        new lib_dynamodb_1.QueryCommand({
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
        throw new errors_1.WorkflowAPIError(`Hook not found for token`, {
          status: 404,
        });
      }
      return item;
    },
    async dispose(hookId) {
      const hook = await this.get(hookId);
      // In DynamoDB, we just return the hook as-is since we can't update it
      // (Hook type doesn't have a status field anymore)
      return hook;
    },
    async list(params) {
      const limit = params?.pagination?.limit ?? 20;
      const result = await client.send(
        new lib_dynamodb_1.QueryCommand({
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
      const items = result.Items || [];
      return {
        data: items,
        hasMore: !!result.LastEvaluatedKey,
        cursor: result.LastEvaluatedKey?.hookId ?? null,
      };
    },
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RvcmFnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0b3JhZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsd0RBTStCO0FBQy9CLDZDQUFvRDtBQVNwRCwrQkFBd0M7QUFHeEMsU0FBZ0IsYUFBYSxDQUMzQixNQUE4QixFQUM5QixNQUFzQjtJQUV0QixPQUFPO1FBQ0wsSUFBSSxFQUFFLGlCQUFpQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7UUFDdkMsS0FBSyxFQUFFLGtCQUFrQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7UUFDekMsTUFBTSxFQUFFLG1CQUFtQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7UUFDM0MsS0FBSyxFQUFFLGtCQUFrQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7S0FDMUMsQ0FBQztBQUNKLENBQUM7QUFWRCxzQ0FVQztBQUVELFNBQVMsaUJBQWlCLENBQ3hCLE1BQThCLEVBQzlCLE1BQXNCO0lBRXRCLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ3JDLE1BQU0sSUFBSSxHQUFHLElBQUEsdUJBQWdCLEdBQUUsQ0FBQztJQUVoQyxPQUFPO1FBQ0wsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJO1lBQ2YsTUFBTSxLQUFLLEdBQUcsT0FBTyxJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQzlCLE1BQU0sR0FBRyxHQUFHLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7WUFFckMsTUFBTSxHQUFHLEdBQWdCO2dCQUN2QixLQUFLO2dCQUNMLFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWTtnQkFDL0IsTUFBTSxFQUFFLFNBQVM7Z0JBQ2pCLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSztnQkFDakIsWUFBWSxFQUFFLFNBQVM7Z0JBQ3ZCLFNBQVMsRUFBRSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUM7Z0JBQ3hCLFNBQVMsRUFBRSxJQUFJLElBQUks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T0FBTztnQkFDTCxJQUFJLEVBQUUsS0FBSztnQkFDWCxPQUFPLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0I7Z0JBQ2xDLE1BQU0sRUFBRyxNQUFNLENBQUMsZ0JBQWdCLEVBQUUsTUFBd0IsSUFBSSxJQUFJO2FBQ25FLENBQUM7UUFDSixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBRdWVyeUNvbW1hbmQgYXMgRG9jUXVlcnlDb21tYW5kLFxuICBHZXRDb21tYW5kLFxuICBQdXRDb21tYW5kLFxuICBVcGRhdGVDb21tYW5kLFxuICB0eXBlIER5bmFtb0RCRG9jdW1lbnRDbGllbnQsXG59IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgeyBXb3JrZmxvd0FQSUVycm9yIH0gZnJvbSAnQHdvcmtmbG93L2Vycm9ycyc7XG5pbXBvcnQgdHlwZSB7XG4gIEV2ZW50LFxuICBIb29rLFxuICBQYWdpbmF0ZWRSZXNwb25zZSxcbiAgU3RlcCxcbiAgU3RvcmFnZSxcbiAgV29ya2Zsb3dSdW4sXG59IGZyb20gJ0B3b3JrZmxvdy93b3JsZCc7XG5pbXBvcnQgeyBtb25vdG9uaWNGYWN0b3J5IH0gZnJvbSAndWxpZCc7XG5pbXBvcnQgdHlwZSB7IEFXU1dvcmxkQ29uZmlnIH0gZnJvbSAnLi9jb25maWcuanMnO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3RvcmFnZShcbiAgY2xpZW50OiBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LFxuICBjb25maWc6IEFXU1dvcmxkQ29uZmlnXG4pOiBTdG9yYWdlIHtcbiAgcmV0dXJuIHtcbiAgICBydW5zOiBjcmVhdGVSdW5zU3RvcmFnZShjbGllbnQsIGNvbmZpZyksXG4gICAgc3RlcHM6IGNyZWF0ZVN0ZXBzU3RvcmFnZShjbGllbnQsIGNvbmZpZyksXG4gICAgZXZlbnRzOiBjcmVhdGVFdmVudHNTdG9yYWdlKGNsaWVudCwgY29uZmlnKSxcbiAgICBob29rczogY3JlYXRlSG9va3NTdG9yYWdlKGNsaWVudCwgY29uZmlnKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlUnVuc1N0b3JhZ2UoXG4gIGNsaWVudDogRHluYW1vREJEb2N1bWVudENsaWVudCxcbiAgY29uZmlnOiBBV1NXb3JsZENvbmZpZ1xuKTogU3RvcmFnZVsncnVucyddIHtcbiAgY29uc3QgdGFibGVOYW1lID0gY29uZmlnLnRhYmxlcy5ydW5zO1xuICBjb25zdCB1bGlkID0gbW9ub3RvbmljRmFjdG9yeSgpO1xuXG4gIHJldHVybiB7XG4gICAgYXN5bmMgY3JlYXRlKGRhdGEpOiBQcm9taXNlPFdvcmtmbG93UnVuPiB7XG4gICAgICBjb25zdCBydW5JZCA9IGBydW5fJHt1bGlkKCl9YDtcbiAgICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICAgICAgY29uc3QgcnVuOiBXb3JrZmxvd1J1biA9IHtcbiAgICAgICAgcnVuSWQsXG4gICAgICAgIHdvcmtmbG93TmFtZTogZGF0YS53b3JrZmxvd05hbWUsXG4gICAgICAgIHN0YXR1czogJ3J1bm5pbmcnLFxuICAgICAgICBpbnB1dDogZGF0YS5pbnB1dCxcbiAgICAgICAgZGVwbG95bWVudElkOiAnZGVmYXVsdCcsXG4gICAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUobm93KSxcbiAgICAgICAgdXBkYXRlZEF0OiBuZXcgRGF0ZShub3cpLFxuICAgICAgfTtcblxuICAgICAgYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBQdXRDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IHRhYmxlTmFtZSxcbiAgICAgICAgICBJdGVtOiBydW4sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICByZXR1cm4gcnVuO1xuICAgIH0sXG5cbiAgICBhc3luYyBnZXQoaWQpOiBQcm9taXNlPFdvcmtmbG93UnVuPiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc2VuZChcbiAgICAgICAgbmV3IEdldENvbW1hbmQoe1xuICAgICAgICAgIFRhYmxlTmFtZTogdGFibGVOYW1lLFxuICAgICAgICAgIEtleTogeyBydW5JZDogaWQgfSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIGlmICghcmVzdWx0Lkl0ZW0pIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93QVBJRXJyb3IoYFJ1biBub3QgZm91bmQ6ICR7aWR9YCwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc3VsdC5JdGVtIGFzIFdvcmtmbG93UnVuO1xuICAgIH0sXG5cbiAgICBhc3luYyB1cGRhdGUoaWQsIGRhdGEpOiBQcm9taXNlPFdvcmtmbG93UnVuPiB7XG4gICAgICBjb25zdCB1cGRhdGVFeHByZXNzaW9uczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gICAgICAvLyBCdWlsZCB1cGRhdGUgZXhwcmVzc2lvbiBkeW5hbWljYWxseVxuICAgICAgaWYgKGRhdGEuc3RhdHVzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3N0YXR1cyA9IDpzdGF0dXMnKTtcbiAgICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjc3RhdHVzJ10gPSAnc3RhdHVzJztcbiAgICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnN0YXR1cyddID0gZGF0YS5zdGF0dXM7XG4gICAgICB9XG5cbiAgICAgIGlmIChkYXRhLm91dHB1dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNvdXRwdXQgPSA6b3V0cHV0Jyk7XG4gICAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI291dHB1dCddID0gJ291dHB1dCc7XG4gICAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXNbJzpvdXRwdXQnXSA9IGRhdGEub3V0cHV0O1xuICAgICAgfVxuXG4gICAgICBpZiAoZGF0YS5lcnJvciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyNlcnJvciA9IDplcnJvcicpO1xuICAgICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNlcnJvciddID0gJ2Vycm9yJztcbiAgICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOmVycm9yJ10gPSBkYXRhLmVycm9yO1xuICAgICAgfVxuXG4gICAgICAvLyBBbHdheXMgdXBkYXRlIHVwZGF0ZWRBdFxuICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI3VwZGF0ZWRBdCA9IDp1cGRhdGVkQXQnKTtcbiAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI3VwZGF0ZWRBdCddID0gJ3VwZGF0ZWRBdCc7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6dXBkYXRlZEF0J10gPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5zZW5kKFxuICAgICAgICBuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiB0YWJsZU5hbWUsXG4gICAgICAgICAgS2V5OiB7IHJ1bklkOiBpZCB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246IGBTRVQgJHt1cGRhdGVFeHByZXNzaW9ucy5qb2luKCcsICcpfWAsXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiBleHByZXNzaW9uQXR0cmlidXRlTmFtZXMsXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcyxcbiAgICAgICAgICBSZXR1cm5WYWx1ZXM6ICdBTExfTkVXJyxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIGlmICghcmVzdWx0LkF0dHJpYnV0ZXMpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93QVBJRXJyb3IoYFJ1biBub3QgZm91bmQ6ICR7aWR9YCwgeyBzdGF0dXM6IDQwNCB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc3VsdC5BdHRyaWJ1dGVzIGFzIFdvcmtmbG93UnVuO1xuICAgIH0sXG5cbiAgICBhc3luYyBsaXN0KHBhcmFtcyk6IFByb21pc2U8UGFnaW5hdGVkUmVzcG9uc2U8V29ya2Zsb3dSdW4+PiB7XG4gICAgICBjb25zdCBsaW1pdCA9IHBhcmFtcz8ucGFnaW5hdGlvbj8ubGltaXQgPz8gMjA7XG4gICAgICBjb25zdCBxdWVyeVBhcmFtczogYW55ID0ge1xuICAgICAgICBUYWJsZU5hbWU6IHRhYmxlTmFtZSxcbiAgICAgICAgTGltaXQ6IGxpbWl0LFxuICAgICAgfTtcblxuICAgICAgaWYgKHBhcmFtcz8ucGFnaW5hdGlvbj8uY3Vyc29yKSB7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLkV4Y2x1c2l2ZVN0YXJ0S2V5ID0geyBydW5JZDogcGFyYW1zLnBhZ2luYXRpb24uY3Vyc29yIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChwYXJhbXM/LndvcmtmbG93TmFtZSkge1xuICAgICAgICAvLyBJZiBxdWVyeWluZyBieSB3b3JrZmxvdyBuYW1lLCB3ZSBuZWVkIGEgR1NJXG4gICAgICAgIHF1ZXJ5UGFyYW1zLkluZGV4TmFtZSA9ICd3b3JrZmxvd05hbWUtaW5kZXgnO1xuICAgICAgICBxdWVyeVBhcmFtcy5LZXlDb25kaXRpb25FeHByZXNzaW9uID0gJ3dvcmtmbG93TmFtZSA9IDp3b3JrZmxvd05hbWUnO1xuICAgICAgICBxdWVyeVBhcmFtcy5FeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzID0ge1xuICAgICAgICAgICc6d29ya2Zsb3dOYW1lJzogcGFyYW1zLndvcmtmbG93TmFtZSxcbiAgICAgICAgfTtcbiAgICAgICAgcXVlcnlQYXJhbXMuU2NhbkluZGV4Rm9yd2FyZCA9IHRydWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHBhcmFtcz8ud29ya2Zsb3dOYW1lXG4gICAgICAgID8gYXdhaXQgY2xpZW50LnNlbmQobmV3IERvY1F1ZXJ5Q29tbWFuZChxdWVyeVBhcmFtcykpXG4gICAgICAgIDogYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgICAgICBuZXcgRG9jUXVlcnlDb21tYW5kKHtcbiAgICAgICAgICAgICAgLi4ucXVlcnlQYXJhbXMsXG4gICAgICAgICAgICAgIC8vIEZvciBzY2FuIG9wZXJhdGlvbnMgd2hlbiBubyB3b3JrZmxvdyBuYW1lIGlzIHByb3ZpZGVkXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICk7XG5cbiAgICAgIGNvbnN0IGl0ZW1zID0gKHJlc3VsdC5JdGVtcyB8fCBbXSkgYXMgV29ya2Zsb3dSdW5bXTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGF0YTogaXRlbXMsXG4gICAgICAgIGhhc01vcmU6ICEhcmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXksXG4gICAgICAgIGN1cnNvcjogKHJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5Py5ydW5JZCBhcyBzdHJpbmcgfCBudWxsKSA/PyBudWxsLFxuICAgICAgfTtcbiAgICB9LFxuXG4gICAgYXN5bmMgY2FuY2VsKGlkKTogUHJvbWlzZTxXb3JrZmxvd1J1bj4ge1xuICAgICAgcmV0dXJuIHRoaXMudXBkYXRlKGlkLCB7XG4gICAgICAgIHN0YXR1czogJ2NhbmNlbGxlZCcsXG4gICAgICB9KTtcbiAgICB9LFxuXG4gICAgYXN5bmMgcGF1c2UoaWQpOiBQcm9taXNlPFdvcmtmbG93UnVuPiB7XG4gICAgICByZXR1cm4gdGhpcy51cGRhdGUoaWQsIHtcbiAgICAgICAgc3RhdHVzOiAncGF1c2VkJyxcbiAgICAgIH0pO1xuICAgIH0sXG5cbiAgICBhc3luYyByZXN1bWUoaWQpOiBQcm9taXNlPFdvcmtmbG93UnVuPiB7XG4gICAgICBjb25zdCBydW4gPSBhd2FpdCB0aGlzLmdldChpZCk7XG4gICAgICBpZiAocnVuLnN0YXR1cyAhPT0gJ3BhdXNlZCcpIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93QVBJRXJyb3IoYFJ1biBpcyBub3QgcGF1c2VkOiAke2lkfWAsIHsgc3RhdHVzOiA0MDAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy51cGRhdGUoaWQsIHtcbiAgICAgICAgc3RhdHVzOiAncnVubmluZycsXG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVTdGVwc1N0b3JhZ2UoXG4gIGNsaWVudDogRHluYW1vREJEb2N1bWVudENsaWVudCxcbiAgY29uZmlnOiBBV1NXb3JsZENvbmZpZ1xuKTogU3RvcmFnZVsnc3RlcHMnXSB7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IGNvbmZpZy50YWJsZXMuc3RlcHM7XG4gIGNvbnN0IHVsaWQgPSBtb25vdG9uaWNGYWN0b3J5KCk7XG5cbiAgcmV0dXJuIHtcbiAgICBhc3luYyBjcmVhdGUocnVuSWQsIGRhdGEpOiBQcm9taXNlPFN0ZXA+IHtcbiAgICAgIGNvbnN0IHN0ZXBJZCA9IGBzdGVwXyR7dWxpZCgpfWA7XG4gICAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cbiAgICAgIGNvbnN0IHN0ZXA6IFN0ZXAgPSB7XG4gICAgICAgIHN0ZXBJZCxcbiAgICAgICAgcnVuSWQsXG4gICAgICAgIHN0ZXBOYW1lOiBkYXRhLnN0ZXBOYW1lLFxuICAgICAgICBzdGF0dXM6ICdwZW5kaW5nJyxcbiAgICAgICAgaW5wdXQ6IGRhdGEuaW5wdXQsXG4gICAgICAgIGF0dGVtcHQ6IDAsXG4gICAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUobm93KSxcbiAgICAgICAgdXBkYXRlZEF0OiBuZXcgRGF0ZShub3cpLFxuICAgICAgfTtcblxuICAgICAgYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBQdXRDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IHRhYmxlTmFtZSxcbiAgICAgICAgICBJdGVtOiBzdGVwLFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgcmV0dXJuIHN0ZXA7XG4gICAgfSxcblxuICAgIGFzeW5jIGdldChydW5JZCwgc3RlcElkKTogUHJvbWlzZTxTdGVwPiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc2VuZChcbiAgICAgICAgbmV3IEdldENvbW1hbmQoe1xuICAgICAgICAgIFRhYmxlTmFtZTogdGFibGVOYW1lLFxuICAgICAgICAgIEtleTogeyBzdGVwSWQsIHJ1bklkIH0sXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICBpZiAoIXJlc3VsdC5JdGVtKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3JrZmxvd0FQSUVycm9yKGBTdGVwIG5vdCBmb3VuZDogJHtzdGVwSWR9YCwge1xuICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc3VsdC5JdGVtIGFzIFN0ZXA7XG4gICAgfSxcblxuICAgIGFzeW5jIHVwZGF0ZShydW5JZCwgc3RlcElkLCBkYXRhKTogUHJvbWlzZTxTdGVwPiB7XG4gICAgICBjb25zdCB1cGRhdGVFeHByZXNzaW9uczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgY29uc3QgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gICAgICBpZiAoZGF0YS5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB1cGRhdGVFeHByZXNzaW9ucy5wdXNoKCcjc3RhdHVzID0gOnN0YXR1cycpO1xuICAgICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyNzdGF0dXMnXSA9ICdzdGF0dXMnO1xuICAgICAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6c3RhdHVzJ10gPSBkYXRhLnN0YXR1cztcbiAgICAgIH1cblxuICAgICAgaWYgKGRhdGEub3V0cHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI291dHB1dCA9IDpvdXRwdXQnKTtcbiAgICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzWycjb3V0cHV0J10gPSAnb3V0cHV0JztcbiAgICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOm91dHB1dCddID0gZGF0YS5vdXRwdXQ7XG4gICAgICB9XG5cbiAgICAgIGlmIChkYXRhLmVycm9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdXBkYXRlRXhwcmVzc2lvbnMucHVzaCgnI2Vycm9yID0gOmVycm9yJyk7XG4gICAgICAgIGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lc1snI2Vycm9yJ10gPSAnZXJyb3InO1xuICAgICAgICBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzWyc6ZXJyb3InXSA9IGRhdGEuZXJyb3I7XG4gICAgICB9XG5cbiAgICAgIHVwZGF0ZUV4cHJlc3Npb25zLnB1c2goJyN1cGRhdGVkQXQgPSA6dXBkYXRlZEF0Jyk7XG4gICAgICBleHByZXNzaW9uQXR0cmlidXRlTmFtZXNbJyN1cGRhdGVkQXQnXSA9ICd1cGRhdGVkQXQnO1xuICAgICAgZXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlc1snOnVwZGF0ZWRBdCddID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc2VuZChcbiAgICAgICAgbmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgICAgIFRhYmxlTmFtZTogdGFibGVOYW1lLFxuICAgICAgICAgIEtleTogeyBzdGVwSWQsIHJ1bklkIH0sXG4gICAgICAgICAgVXBkYXRlRXhwcmVzc2lvbjogYFNFVCAke3VwZGF0ZUV4cHJlc3Npb25zLmpvaW4oJywgJyl9YCxcbiAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IGV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcyxcbiAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uQXR0cmlidXRlVmFsdWVzLFxuICAgICAgICAgIFJldHVyblZhbHVlczogJ0FMTF9ORVcnLFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgaWYgKCFyZXN1bHQuQXR0cmlidXRlcykge1xuICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dBUElFcnJvcihgU3RlcCBub3QgZm91bmQ6ICR7c3RlcElkfWAsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXN1bHQuQXR0cmlidXRlcyBhcyBTdGVwO1xuICAgIH0sXG5cbiAgICBhc3luYyBsaXN0KHBhcmFtcyk6IFByb21pc2U8UGFnaW5hdGVkUmVzcG9uc2U8U3RlcD4+IHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5saW1pdCA/PyAyMDtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBEb2NRdWVyeUNvbW1hbmQoe1xuICAgICAgICAgIFRhYmxlTmFtZTogdGFibGVOYW1lLFxuICAgICAgICAgIEluZGV4TmFtZTogJ3J1bklkLWluZGV4JyxcbiAgICAgICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAncnVuSWQgPSA6cnVuSWQnLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICc6cnVuSWQnOiBwYXJhbXMucnVuSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBMaW1pdDogbGltaXQsXG4gICAgICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IHBhcmFtcz8ucGFnaW5hdGlvbj8uY3Vyc29yXG4gICAgICAgICAgICA/IHsgcnVuSWQ6IHBhcmFtcy5ydW5JZCwgc3RlcElkOiBwYXJhbXMucGFnaW5hdGlvbi5jdXJzb3IgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgU2NhbkluZGV4Rm9yd2FyZDogdHJ1ZSxcbiAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGl0ZW1zID0gKHJlc3VsdC5JdGVtcyB8fCBbXSkgYXMgU3RlcFtdO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYXRhOiBpdGVtcyxcbiAgICAgICAgaGFzTW9yZTogISFyZXN1bHQuTGFzdEV2YWx1YXRlZEtleSxcbiAgICAgICAgY3Vyc29yOiAocmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXk/LnN0ZXBJZCBhcyBzdHJpbmcgfCBudWxsKSA/PyBudWxsLFxuICAgICAgfTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVFdmVudHNTdG9yYWdlKFxuICBjbGllbnQ6IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsXG4gIGNvbmZpZzogQVdTV29ybGRDb25maWdcbik6IFN0b3JhZ2VbJ2V2ZW50cyddIHtcbiAgY29uc3QgdGFibGVOYW1lID0gY29uZmlnLnRhYmxlcy5ldmVudHM7XG4gIGNvbnN0IHVsaWQgPSBtb25vdG9uaWNGYWN0b3J5KCk7XG5cbiAgcmV0dXJuIHtcbiAgICBhc3luYyBjcmVhdGUocnVuSWQsIGRhdGEpOiBQcm9taXNlPEV2ZW50PiB7XG4gICAgICBjb25zdCBldmVudElkID0gYGV2dF8ke3VsaWQoKX1gO1xuICAgICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gICAgICBjb25zdCBldmVudCA9IHtcbiAgICAgICAgLi4uZGF0YSxcbiAgICAgICAgZXZlbnRJZCxcbiAgICAgICAgcnVuSWQsXG4gICAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUobm93KSxcbiAgICAgIH0gYXMgRXZlbnQ7XG5cbiAgICAgIGF3YWl0IGNsaWVudC5zZW5kKFxuICAgICAgICBuZXcgUHV0Q29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiB0YWJsZU5hbWUsXG4gICAgICAgICAgSXRlbTogZXZlbnQsXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICByZXR1cm4gZXZlbnQ7XG4gICAgfSxcblxuICAgIGFzeW5jIGxpc3QocGFyYW1zKTogUHJvbWlzZTxQYWdpbmF0ZWRSZXNwb25zZTxFdmVudD4+IHtcbiAgICAgIGNvbnN0IGxpbWl0ID0gcGFyYW1zPy5wYWdpbmF0aW9uPy5saW1pdCA/PyAyMDtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBEb2NRdWVyeUNvbW1hbmQoe1xuICAgICAgICAgIFRhYmxlTmFtZTogdGFibGVOYW1lLFxuICAgICAgICAgIEluZGV4TmFtZTogJ3J1bklkLWluZGV4JyxcbiAgICAgICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAncnVuSWQgPSA6cnVuSWQnLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICc6cnVuSWQnOiBwYXJhbXMucnVuSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBMaW1pdDogbGltaXQsXG4gICAgICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IHBhcmFtcz8ucGFnaW5hdGlvbj8uY3Vyc29yXG4gICAgICAgICAgICA/IHsgcnVuSWQ6IHBhcmFtcy5ydW5JZCwgZXZlbnRJZDogcGFyYW1zLnBhZ2luYXRpb24uY3Vyc29yIH1cbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICBjb25zdCBpdGVtcyA9IChyZXN1bHQuSXRlbXMgfHwgW10pIGFzIEV2ZW50W107XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGRhdGE6IGl0ZW1zLFxuICAgICAgICBoYXNNb3JlOiAhIXJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5LFxuICAgICAgICBjdXJzb3I6IChyZXN1bHQuTGFzdEV2YWx1YXRlZEtleT8uZXZlbnRJZCBhcyBzdHJpbmcgfCBudWxsKSA/PyBudWxsLFxuICAgICAgfTtcbiAgICB9LFxuXG4gICAgYXN5bmMgbGlzdEJ5Q29ycmVsYXRpb25JZChwYXJhbXMpOiBQcm9taXNlPFBhZ2luYXRlZFJlc3BvbnNlPEV2ZW50Pj4ge1xuICAgICAgY29uc3QgbGltaXQgPSBwYXJhbXM/LnBhZ2luYXRpb24/LmxpbWl0ID8/IDIwO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc2VuZChcbiAgICAgICAgbmV3IERvY1F1ZXJ5Q29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiB0YWJsZU5hbWUsXG4gICAgICAgICAgSW5kZXhOYW1lOiAnY29ycmVsYXRpb25JZC1pbmRleCcsXG4gICAgICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2NvcnJlbGF0aW9uSWQgPSA6Y29ycmVsYXRpb25JZCcsXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgJzpjb3JyZWxhdGlvbklkJzogcGFyYW1zLmNvcnJlbGF0aW9uSWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBMaW1pdDogbGltaXQsXG4gICAgICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IHBhcmFtcz8ucGFnaW5hdGlvbj8uY3Vyc29yXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBjb3JyZWxhdGlvbklkOiBwYXJhbXMuY29ycmVsYXRpb25JZCxcbiAgICAgICAgICAgICAgICBldmVudElkOiBwYXJhbXMucGFnaW5hdGlvbi5jdXJzb3IsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgY29uc3QgaXRlbXMgPSAocmVzdWx0Lkl0ZW1zIHx8IFtdKSBhcyBFdmVudFtdO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYXRhOiBpdGVtcyxcbiAgICAgICAgaGFzTW9yZTogISFyZXN1bHQuTGFzdEV2YWx1YXRlZEtleSxcbiAgICAgICAgY3Vyc29yOiAocmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXk/LmV2ZW50SWQgYXMgc3RyaW5nIHwgbnVsbCkgPz8gbnVsbCxcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSG9va3NTdG9yYWdlKFxuICBjbGllbnQ6IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsXG4gIGNvbmZpZzogQVdTV29ybGRDb25maWdcbik6IFN0b3JhZ2VbJ2hvb2tzJ10ge1xuICBjb25zdCB0YWJsZU5hbWUgPSBjb25maWcudGFibGVzLmhvb2tzO1xuICBjb25zdCB1bGlkID0gbW9ub3RvbmljRmFjdG9yeSgpO1xuXG4gIGZ1bmN0aW9uIGdlbmVyYXRlVG9rZW4oKTogc3RyaW5nIHtcbiAgICByZXR1cm4gYHRva18ke3VsaWQoKX1gO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBhc3luYyBjcmVhdGUocnVuSWQsIGRhdGEpOiBQcm9taXNlPEhvb2s+IHtcbiAgICAgIGNvbnN0IGhvb2tJZCA9IGBob29rXyR7dWxpZCgpfWA7XG4gICAgICBjb25zdCB0b2tlbiA9IGdlbmVyYXRlVG9rZW4oKTtcbiAgICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICAgICAgY29uc3QgaG9vazogSG9vayA9IHtcbiAgICAgICAgaG9va0lkLFxuICAgICAgICBydW5JZCxcbiAgICAgICAgdG9rZW4sXG4gICAgICAgIG93bmVySWQ6ICdhd3MnLFxuICAgICAgICBwcm9qZWN0SWQ6ICdkZWZhdWx0JyxcbiAgICAgICAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgICAgICAgY3JlYXRlZEF0OiBuZXcgRGF0ZShub3cpLFxuICAgICAgfTtcblxuICAgICAgYXdhaXQgY2xpZW50LnNlbmQoXG4gICAgICAgIG5ldyBQdXRDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IHRhYmxlTmFtZSxcbiAgICAgICAgICBJdGVtOiBob29rLFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgcmV0dXJuIGhvb2s7XG4gICAgfSxcblxuICAgIGFzeW5jIGdldChob29rSWQpOiBQcm9taXNlPEhvb2s+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5zZW5kKFxuICAgICAgICBuZXcgR2V0Q29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiB0YWJsZU5hbWUsXG4gICAgICAgICAgS2V5OiB7IGhvb2tJZCB9LFxuICAgICAgICB9KVxuICAgICAgKTtcblxuICAgICAgaWYgKCFyZXN1bHQuSXRlbSkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya2Zsb3dBUElFcnJvcihgSG9vayBub3QgZm91bmQ6ICR7aG9va0lkfWAsIHtcbiAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXN1bHQuSXRlbSBhcyBIb29rO1xuICAgIH0sXG5cbiAgICBhc3luYyBnZXRCeVRva2VuKHRva2VuKTogUHJvbWlzZTxIb29rPiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbGllbnQuc2VuZChcbiAgICAgICAgbmV3IERvY1F1ZXJ5Q29tbWFuZCh7XG4gICAgICAgICAgVGFibGVOYW1lOiB0YWJsZU5hbWUsXG4gICAgICAgICAgSW5kZXhOYW1lOiAndG9rZW4taW5kZXgnLFxuICAgICAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICd0b2tlbiA9IDp0b2tlbicsXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgJzp0b2tlbic6IHRva2VuLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgTGltaXQ6IDEsXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICBjb25zdCBpdGVtID0gcmVzdWx0Lkl0ZW1zPy5bMF07XG4gICAgICBpZiAoIWl0ZW0pIHtcbiAgICAgICAgdGhyb3cgbmV3IFdvcmtmbG93QVBJRXJyb3IoYEhvb2sgbm90IGZvdW5kIGZvciB0b2tlbmAsIHsgc3RhdHVzOiA0MDQgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBpdGVtIGFzIEhvb2s7XG4gICAgfSxcblxuICAgIGFzeW5jIGRpc3Bvc2UoaG9va0lkKTogUHJvbWlzZTxIb29rPiB7XG4gICAgICBjb25zdCBob29rID0gYXdhaXQgdGhpcy5nZXQoaG9va0lkKTtcbiAgICAgIC8vIEluIER5bmFtb0RCLCB3ZSBqdXN0IHJldHVybiB0aGUgaG9vayBhcy1pcyBzaW5jZSB3ZSBjYW4ndCB1cGRhdGUgaXRcbiAgICAgIC8vIChIb29rIHR5cGUgZG9lc24ndCBoYXZlIGEgc3RhdHVzIGZpZWxkIGFueW1vcmUpXG4gICAgICByZXR1cm4gaG9vaztcbiAgICB9LFxuXG4gICAgYXN5bmMgbGlzdChwYXJhbXMpOiBQcm9taXNlPFBhZ2luYXRlZFJlc3BvbnNlPEhvb2s+PiB7XG4gICAgICBjb25zdCBsaW1pdCA9IHBhcmFtcz8ucGFnaW5hdGlvbj8ubGltaXQgPz8gMjA7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsaWVudC5zZW5kKFxuICAgICAgICBuZXcgRG9jUXVlcnlDb21tYW5kKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IHRhYmxlTmFtZSxcbiAgICAgICAgICBJbmRleE5hbWU6ICdydW5JZC1pbmRleCcsXG4gICAgICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ3J1bklkID0gOnJ1bklkJyxcbiAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgICAnOnJ1bklkJzogcGFyYW1zLnJ1bklkLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgTGltaXQ6IGxpbWl0LFxuICAgICAgICAgIEV4Y2x1c2l2ZVN0YXJ0S2V5OiBwYXJhbXM/LnBhZ2luYXRpb24/LmN1cnNvclxuICAgICAgICAgICAgPyB7IHJ1bklkOiBwYXJhbXMucnVuSWQsIGhvb2tJZDogcGFyYW1zLnBhZ2luYXRpb24uY3Vyc29yIH1cbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgIFNjYW5JbmRleEZvcndhcmQ6IHRydWUsXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICBjb25zdCBpdGVtcyA9IChyZXN1bHQuSXRlbXMgfHwgW10pIGFzIEhvb2tbXTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGF0YTogaXRlbXMsXG4gICAgICAgIGhhc01vcmU6ICEhcmVzdWx0Lkxhc3RFdmFsdWF0ZWRLZXksXG4gICAgICAgIGN1cnNvcjogKHJlc3VsdC5MYXN0RXZhbHVhdGVkS2V5Py5ob29rSWQgYXMgc3RyaW5nIHwgbnVsbCkgPz8gbnVsbCxcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cbiJdfQ==
