import {
  HookNotFoundError,
  RunNotSupportedError,
  WorkflowAPIError,
} from '@workflow/errors';
import type {
  Event,
  EventResult,
  GetEventParams,
  Hook,
  ListEventsParams,
  ListEventsByCorrelationIdParams,
  ListHooksParams,
  PaginatedResponse,
  ResolveData,
  Step,
  StepWithoutData,
  Storage,
  StructuredError,
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  StepSchema,
  validateUlidTimestamp,
  WaitSchema,
  WorkflowRunSchema,
} from '@workflow/world';
import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { monotonicFactory } from 'ulid';
import { tableNames } from './config.js';
import { cborDecode, cborEncode, compact, fromIso, toIso } from './util.js';

// ============================================================
// DynamoDB Item marshalling helpers
// ============================================================

// Marshall a JS object into DynamoDB attribute map, stripping undefined values
function marshallItem(item: Record<string, unknown>) {
  return marshall(item, { removeUndefinedValues: true });
}

// ============================================================
// Run serialization helpers
// ============================================================

function dynamoToRun(item: Record<string, any>): WorkflowRun {
  const raw = {
    runId: item.runId,
    deploymentId: item.deploymentId,
    workflowName: item.workflowName,
    status: item.status,
    specVersion: item.specVersion,
    input: item.input ? cborDecode(item.input) : undefined,
    output: item.output ? cborDecode(item.output) : undefined,
    error: item.error ? cborDecode<StructuredError>(item.error) : undefined,
    executionContext: item.executionContext
      ? cborDecode(item.executionContext)
      : undefined,
    createdAt: item.createdAt ? fromIso(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? fromIso(item.updatedAt) : new Date(),
    startedAt: item.startedAt ? fromIso(item.startedAt) : undefined,
    completedAt: item.completedAt ? fromIso(item.completedAt) : undefined,
    expiredAt: item.expiredAt ? fromIso(item.expiredAt) : undefined,
  };
  return WorkflowRunSchema.parse(compact(raw));
}

function dynamoToStep(item: Record<string, any>): Step {
  const raw = {
    runId: item.runId,
    stepId: item.stepId,
    stepName: item.stepName,
    status: item.status,
    attempt: item.attempt ?? 0,
    specVersion: item.specVersion,
    input: item.input ? cborDecode(item.input) : undefined,
    output: item.output ? cborDecode(item.output) : undefined,
    error: item.error ? cborDecode<StructuredError>(item.error) : undefined,
    createdAt: item.createdAt ? fromIso(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? fromIso(item.updatedAt) : new Date(),
    startedAt: item.startedAt ? fromIso(item.startedAt) : undefined,
    completedAt: item.completedAt ? fromIso(item.completedAt) : undefined,
    retryAfter: item.retryAfter ? fromIso(item.retryAfter) : undefined,
  };
  return StepSchema.parse(compact(raw));
}

function dynamoToEvent(item: Record<string, any>): Event {
  const raw = {
    runId: item.runId,
    eventId: item.eventId,
    eventType: item.eventType,
    correlationId: item.correlationId,
    eventData: item.eventData ? cborDecode(item.eventData) : undefined,
    specVersion: item.specVersion,
    createdAt: item.createdAt ? fromIso(item.createdAt) : new Date(),
  };
  return EventSchema.parse(compact(raw));
}

function dynamoToHook(item: Record<string, any>): Hook {
  const raw = {
    runId: item.runId,
    hookId: item.hookId,
    token: item.token,
    ownerId: item.ownerId ?? '',
    projectId: item.projectId ?? '',
    environment: item.environment ?? '',
    metadata: item.metadata ? cborDecode(item.metadata) : undefined,
    specVersion: item.specVersion,
    isWebhook: item.isWebhook ?? true,
    createdAt: item.createdAt ? fromIso(item.createdAt) : new Date(),
  };
  const parsed = HookSchema.parse(compact(raw));
  parsed.isWebhook ??= true;
  return parsed;
}

function dynamoToWait(item: Record<string, any>): Wait {
  const raw = {
    waitId: item.waitId,
    runId: item.runId,
    status: item.status,
    resumeAt: item.resumeAt ? fromIso(item.resumeAt) : undefined,
    completedAt: item.completedAt ? fromIso(item.completedAt) : undefined,
    createdAt: item.createdAt ? fromIso(item.createdAt) : new Date(),
    updatedAt: item.updatedAt ? fromIso(item.updatedAt) : new Date(),
    specVersion: item.specVersion,
  };
  return WaitSchema.parse(compact(raw));
}

// ============================================================
// Data filtering helpers
// ============================================================

function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = run;
    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

function filterStepData(
  step: Step,
  resolveData: ResolveData
): Step | StepWithoutData {
  if (resolveData === 'none') {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}

function filterEventData(event: Event, resolveData: ResolveData): Event {
  if (resolveData === 'none' && 'eventData' in event) {
    const { eventData: _, ...rest } = event;
    return rest as Event;
  }
  return event;
}

// ============================================================
// Runs Storage
// ============================================================

export function createRunsStorage(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): Storage['runs'] {
  return {
    get: (async (id: string, params?: any) => {
      const result = await dynamo.send(
        new GetItemCommand({
          TableName: tables.runs,
          Key: marshall({ runId: id }),
        })
      );
      if (!result.Item) {
        throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
      }
      const item = unmarshall(result.Item);
      const run = dynamoToRun(item);
      const resolveData = params?.resolveData ?? 'all';
      return filterRunData(run, resolveData);
    }) as Storage['runs']['get'],

    list: (async (params?: any) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;
      const resolveData = params?.resolveData ?? 'all';

      // Build query or scan depending on filters
      let items: Record<string, any>[];

      if (params?.workflowName) {
        // Use GSI on workflowName
        const queryParams: any = {
          TableName: tables.runs,
          IndexName: 'gsi_workflowName',
          KeyConditionExpression: 'workflowName = :wn',
          ExpressionAttributeValues: marshall({
            ':wn': params.workflowName,
          }),
          ScanIndexForward: false,
          Limit: limit + 1,
        };
        if (fromCursor) {
          queryParams.ExclusiveStartKey = marshall({
            runId: fromCursor,
            workflowName: params.workflowName,
            createdAt: '', // DynamoDB needs all key attributes
          });
        }
        const result = await dynamo.send(new QueryCommand(queryParams));
        items = (result.Items ?? []).map((i) => unmarshall(i));
      } else if (params?.status) {
        // Use GSI on status
        const queryParams: any = {
          TableName: tables.runs,
          IndexName: 'gsi_status',
          KeyConditionExpression: '#s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: marshall({ ':status': params.status }),
          ScanIndexForward: false,
          Limit: limit + 1,
        };
        if (fromCursor) {
          queryParams.ExclusiveStartKey = marshall({
            runId: fromCursor,
            status: params.status,
            createdAt: '',
          });
        }
        const result = await dynamo.send(new QueryCommand(queryParams));
        items = (result.Items ?? []).map((i) => unmarshall(i));
      } else {
        // Scan (no filter) - sorted by runId descending
        const scanParams: any = {
          TableName: tables.runs,
          Limit: limit + 1,
        };
        if (fromCursor) {
          scanParams.ExclusiveStartKey = marshall({ runId: fromCursor });
        }
        const result = await dynamo.send(new ScanCommand(scanParams));
        items = (result.Items ?? [])
          .map((i) => unmarshall(i))
          .sort((a, b) => (b.runId > a.runId ? 1 : -1));
      }

      const values = items.slice(0, limit);
      const hasMore = items.length > limit;

      return {
        data: values.map((item) =>
          filterRunData(dynamoToRun(item), resolveData)
        ),
        hasMore,
        cursor: values.at(-1)?.runId ?? null,
      };
    }) as Storage['runs']['list'],
  };
}

// ============================================================
// Events Storage
// ============================================================

export function createEventsStorage(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): Storage['events'] {
  const ulid = monotonicFactory();

  // Helper to get run for validation
  async function getRunForValidation(
    runId: string
  ): Promise<{ status: string; specVersion: number | null } | null> {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: tables.runs,
        Key: marshall({ runId }),
        ProjectionExpression: '#s, specVersion',
        ExpressionAttributeNames: { '#s': 'status' },
      })
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item);
    return { status: item.status, specVersion: item.specVersion ?? null };
  }

  // Helper to get step for validation
  async function getStepForValidation(stepId: string): Promise<{
    status: string;
    startedAt: Date | null;
    retryAfter: Date | null;
  } | null> {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: tables.steps,
        Key: marshall({ stepId }),
        ProjectionExpression: '#s, startedAt, retryAfter',
        ExpressionAttributeNames: { '#s': 'status' },
      })
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item);
    return {
      status: item.status,
      startedAt: item.startedAt ? fromIso(item.startedAt) : null,
      retryAfter: item.retryAfter ? fromIso(item.retryAfter) : null,
    };
  }

  // Helper to get hook by token
  async function getHookByToken(
    token: string
  ): Promise<{ hookId: string } | null> {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tables.hooks,
        IndexName: 'gsi_token',
        KeyConditionExpression: '#t = :token',
        ExpressionAttributeNames: { '#t': 'token' },
        ExpressionAttributeValues: marshall({ ':token': token }),
        Limit: 1,
      })
    );
    if (!result.Items?.length) return null;
    const item = unmarshall(result.Items[0]);
    return { hookId: item.hookId };
  }

  // Helper to get wait for validation
  async function getWaitForValidation(
    waitId: string
  ): Promise<{ status: string } | null> {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: tables.waits,
        Key: marshall({ waitId }),
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'status' },
      })
    );
    if (!result.Item) return null;
    const item = unmarshall(result.Item);
    return { status: item.status };
  }

  // Helper to insert an event into the events table
  async function insertEvent(
    runId: string,
    eventId: string,
    data: any,
    specVersion: number
  ): Promise<Date> {
    const now = new Date();
    await dynamo.send(
      new PutItemCommand({
        TableName: tables.events,
        Item: marshallItem({
          runId,
          eventId,
          eventType: data.eventType,
          correlationId: data.correlationId,
          eventData:
            'eventData' in data && data.eventData != null
              ? cborEncode(data.eventData)
              : undefined,
          specVersion,
          createdAt: toIso(now),
        }),
      })
    );
    return now;
  }

  // Helper to delete all hooks for a run
  async function deleteHooksForRun(runId: string): Promise<void> {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tables.hooks,
        IndexName: 'gsi_runId',
        KeyConditionExpression: 'runId = :runId',
        ExpressionAttributeValues: marshall({ ':runId': runId }),
        ProjectionExpression: 'hookId',
      })
    );
    if (result.Items?.length) {
      // DynamoDB BatchWriteItem supports up to 25 items
      const items = result.Items.map((i) => unmarshall(i));
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await dynamo.send(
          new BatchWriteItemCommand({
            RequestItems: {
              [tables.hooks]: batch.map((item) => ({
                DeleteRequest: {
                  Key: marshall({ hookId: item.hookId }),
                },
              })),
            },
          })
        );
      }
    }
  }

  // Helper to delete all waits for a run
  async function deleteWaitsForRun(runId: string): Promise<void> {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tables.waits,
        IndexName: 'gsi_runId',
        KeyConditionExpression: 'runId = :runId',
        ExpressionAttributeValues: marshall({ ':runId': runId }),
        ProjectionExpression: 'waitId',
      })
    );
    if (result.Items?.length) {
      const items = result.Items.map((i) => unmarshall(i));
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await dynamo.send(
          new BatchWriteItemCommand({
            RequestItems: {
              [tables.waits]: batch.map((item) => ({
                DeleteRequest: {
                  Key: marshall({ waitId: item.waitId }),
                },
              })),
            },
          })
        );
      }
    }
  }

  const isRunTerminal = (status: string) =>
    ['completed', 'failed', 'cancelled'].includes(status);

  const isStepTerminal = (status: string) =>
    ['completed', 'failed'].includes(status);

  return {
    async create(runId: any, data: any, params?: any): Promise<EventResult> {
      const eventId = `wevt_${ulid()}`;

      // For run_created events, use client-provided runId or generate one
      let effectiveRunId: string;
      if (data.eventType === 'run_created' && (!runId || runId === '')) {
        effectiveRunId = `wrun_${ulid()}`;
      } else if (!runId) {
        throw new Error('runId is required for non-run_created events');
      } else {
        effectiveRunId = runId;
      }

      // Validate client-provided runId timestamp
      if (data.eventType === 'run_created' && runId && runId !== '') {
        const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
        if (validationError) {
          throw new WorkflowAPIError(validationError, { status: 400 });
        }
      }

      const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
      const now = new Date();
      const nowIso = toIso(now);

      let run: WorkflowRun | undefined;
      let step: Step | undefined;
      let hook: Hook | undefined;
      let wait: Wait | undefined;

      // ============================================================
      // VALIDATION
      // ============================================================

      let currentRun: { status: string; specVersion: number | null } | null =
        null;
      const skipRunValidationEvents = ['step_completed', 'step_retrying'];
      if (
        data.eventType !== 'run_created' &&
        !skipRunValidationEvents.includes(data.eventType)
      ) {
        currentRun = await getRunForValidation(effectiveRunId);
      }

      // Version compatibility check
      if (currentRun) {
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT
          );
        }

        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(
            dynamo,
            tables,
            effectiveRunId,
            eventId,
            data,
            currentRun,
            params
          );
        }
      }

      // Run terminal state validation
      if (currentRun && isRunTerminal(currentRun.status)) {
        const runTerminalEvents = [
          'run_started',
          'run_completed',
          'run_failed',
        ];

        // Idempotent: run_cancelled on already cancelled run
        if (
          data.eventType === 'run_cancelled' &&
          currentRun.status === 'cancelled'
        ) {
          const runResult = await dynamo.send(
            new GetItemCommand({
              TableName: tables.runs,
              Key: marshall({ runId: effectiveRunId }),
            })
          );
          const createdAt = await insertEvent(
            effectiveRunId,
            eventId,
            data,
            effectiveSpecVersion
          );
          const result = {
            ...data,
            createdAt,
            runId: effectiveRunId,
            eventId,
          };
          const parsed = EventSchema.parse(result);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsed, resolveData),
            run: runResult.Item
              ? dynamoToRun(unmarshall(runResult.Item))
              : undefined,
          };
        }

        if (
          runTerminalEvents.includes(data.eventType) ||
          data.eventType === 'run_cancelled'
        ) {
          throw new WorkflowAPIError(
            `Cannot transition run from terminal state "${currentRun.status}"`,
            { status: 409 }
          );
        }

        if (
          data.eventType === 'step_created' ||
          data.eventType === 'hook_created' ||
          data.eventType === 'wait_created'
        ) {
          throw new WorkflowAPIError(
            `Cannot create new entities on run in terminal state "${currentRun.status}"`,
            { status: 409 }
          );
        }
      }

      // Step-related event validation
      let validatedStep: {
        status: string;
        startedAt: Date | null;
        retryAfter: Date | null;
      } | null = null;
      const stepEventsNeedingValidation = ['step_started', 'step_retrying'];
      if (
        stepEventsNeedingValidation.includes(data.eventType) &&
        data.correlationId
      ) {
        validatedStep = await getStepForValidation(data.correlationId);
        if (!validatedStep) {
          throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
            status: 404,
          });
        }
        if (isStepTerminal(validatedStep.status)) {
          throw new WorkflowAPIError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
            { status: 409 }
          );
        }
        if (currentRun && isRunTerminal(currentRun.status)) {
          if (validatedStep.status !== 'running') {
            throw new WorkflowAPIError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              { status: 410 }
            );
          }
        }
      }

      // Hook-related event validation
      const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
      if (
        hookEventsRequiringExistence.includes(data.eventType) &&
        data.correlationId
      ) {
        const existingHook = await dynamo.send(
          new GetItemCommand({
            TableName: tables.hooks,
            Key: marshall({ hookId: data.correlationId }),
            ProjectionExpression: 'hookId',
          })
        );
        if (!existingHook.Item) {
          throw new WorkflowAPIError(`Hook "${data.correlationId}" not found`, {
            status: 404,
          });
        }
      }

      // ============================================================
      // Entity creation/updates based on event type
      // ============================================================

      if (data.eventType === 'run_created') {
        const eventData = data.eventData as {
          deploymentId: string;
          workflowName: string;
          input: any;
          executionContext?: Record<string, any>;
        };
        try {
          await dynamo.send(
            new PutItemCommand({
              TableName: tables.runs,
              Item: marshallItem({
                runId: effectiveRunId,
                deploymentId: eventData.deploymentId,
                workflowName: eventData.workflowName,
                specVersion: effectiveSpecVersion,
                input: cborEncode(eventData.input),
                executionContext: eventData.executionContext
                  ? cborEncode(eventData.executionContext)
                  : undefined,
                status: 'pending',
                createdAt: nowIso,
                updatedAt: nowIso,
              }),
              ConditionExpression: 'attribute_not_exists(runId)',
            })
          );
          // Retrieve the created run
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.runs,
              Key: marshall({ runId: effectiveRunId }),
            })
          );
          if (result.Item) {
            run = dynamoToRun(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // Run already exists, idempotent
          } else {
            throw err;
          }
        }
      }

      if (data.eventType === 'run_started') {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
            UpdateExpression:
              'SET #s = :status, startedAt = :startedAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: marshall({
              ':status': 'running',
              ':startedAt': nowIso,
              ':updatedAt': nowIso,
            }),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
          })
        );
        if (result.Item) {
          run = dynamoToRun(unmarshall(result.Item));
        }
      }

      if (data.eventType === 'run_completed') {
        const eventData = data.eventData as { output?: any };
        const updateExpr =
          eventData.output !== undefined
            ? 'SET #s = :status, #out = :output, completedAt = :completedAt, updatedAt = :updatedAt'
            : 'SET #s = :status, completedAt = :completedAt, updatedAt = :updatedAt';
        const exprNames: Record<string, string> = { '#s': 'status' };
        const exprValues: Record<string, any> = {
          ':status': 'completed',
          ':completedAt': nowIso,
          ':updatedAt': nowIso,
        };
        if (eventData.output !== undefined) {
          exprNames['#out'] = 'output';
          exprValues[':output'] = cborEncode(eventData.output);
        }
        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
            UpdateExpression: updateExpr,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: marshall(exprValues),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
          })
        );
        if (result.Item) {
          run = dynamoToRun(unmarshall(result.Item));
        }
        await Promise.all([
          deleteHooksForRun(effectiveRunId),
          deleteWaitsForRun(effectiveRunId),
        ]);
      }

      if (data.eventType === 'run_failed') {
        const eventData = data.eventData as {
          error: any;
          errorCode?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');
        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
            UpdateExpression:
              'SET #s = :status, #err = :error, completedAt = :completedAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
            ExpressionAttributeValues: marshall({
              ':status': 'failed',
              ':error': cborEncode({
                message: errorMessage,
                stack: eventData.error?.stack,
                code: eventData.errorCode,
              }),
              ':completedAt': nowIso,
              ':updatedAt': nowIso,
            }),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
          })
        );
        if (result.Item) {
          run = dynamoToRun(unmarshall(result.Item));
        }
        await Promise.all([
          deleteHooksForRun(effectiveRunId),
          deleteWaitsForRun(effectiveRunId),
        ]);
      }

      if (data.eventType === 'run_cancelled') {
        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
            UpdateExpression:
              'SET #s = :status, completedAt = :completedAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: marshall({
              ':status': 'cancelled',
              ':completedAt': nowIso,
              ':updatedAt': nowIso,
            }),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.runs,
            Key: marshall({ runId: effectiveRunId }),
          })
        );
        if (result.Item) {
          run = dynamoToRun(unmarshall(result.Item));
        }
        await Promise.all([
          deleteHooksForRun(effectiveRunId),
          deleteWaitsForRun(effectiveRunId),
        ]);
      }

      if (data.eventType === 'step_created') {
        const eventData = data.eventData as {
          stepName: string;
          input: any;
        };
        try {
          await dynamo.send(
            new PutItemCommand({
              TableName: tables.steps,
              Item: marshallItem({
                runId: effectiveRunId,
                stepId: data.correlationId!,
                stepName: eventData.stepName,
                input: cborEncode(eventData.input),
                status: 'pending',
                attempt: 0,
                specVersion: effectiveSpecVersion,
                createdAt: nowIso,
                updatedAt: nowIso,
              }),
              ConditionExpression: 'attribute_not_exists(stepId)',
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.steps,
              Key: marshall({ stepId: data.correlationId! }),
            })
          );
          if (result.Item) {
            step = dynamoToStep(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // Step already exists, idempotent
          } else {
            throw err;
          }
        }
      }

      if (data.eventType === 'step_started') {
        // Check if retryAfter timestamp hasn't been reached yet
        if (
          validatedStep?.retryAfter &&
          validatedStep.retryAfter.getTime() > Date.now()
        ) {
          const err = new WorkflowAPIError(
            `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
            { status: 425 }
          );
          (err as any).meta = {
            stepId: data.correlationId,
            retryAfter: validatedStep.retryAfter.toISOString(),
          };
          throw err;
        }

        const isFirstStart = !validatedStep?.startedAt;
        const hadRetryAfter = !!validatedStep?.retryAfter;

        let updateExpr =
          'SET #s = :status, attempt = attempt + :one, updatedAt = :updatedAt';
        const exprNames: Record<string, string> = { '#s': 'status' };
        const exprValues: Record<string, any> = {
          ':status': 'running',
          ':one': 1,
          ':updatedAt': nowIso,
        };

        if (isFirstStart) {
          updateExpr += ', startedAt = :startedAt';
          exprValues[':startedAt'] = nowIso;
        }
        if (hadRetryAfter) {
          updateExpr += ' REMOVE retryAfter';
        }

        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.steps,
            Key: marshall({ stepId: data.correlationId! }),
            UpdateExpression: updateExpr,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: marshall(exprValues),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.steps,
            Key: marshall({ stepId: data.correlationId! }),
          })
        );
        if (result.Item) {
          step = dynamoToStep(unmarshall(result.Item));
        }
      }

      if (data.eventType === 'step_completed') {
        const eventData = data.eventData as { result?: any };
        try {
          const updateExpr =
            eventData.result !== undefined
              ? 'SET #s = :status, #out = :output, completedAt = :completedAt, updatedAt = :updatedAt'
              : 'SET #s = :status, completedAt = :completedAt, updatedAt = :updatedAt';
          const exprNames: Record<string, string> = { '#s': 'status' };
          const exprValues: Record<string, any> = {
            ':status': 'completed',
            ':completedAt': nowIso,
            ':updatedAt': nowIso,
            ':terminalCompleted': 'completed',
            ':terminalFailed': 'failed',
          };
          if (eventData.result !== undefined) {
            exprNames['#out'] = 'output';
            exprValues[':output'] = cborEncode(eventData.result);
          }
          await dynamo.send(
            new UpdateItemCommand({
              TableName: tables.steps,
              Key: marshall({ stepId: data.correlationId! }),
              UpdateExpression: updateExpr,
              ConditionExpression:
                '#s <> :terminalCompleted AND #s <> :terminalFailed',
              ExpressionAttributeNames: exprNames,
              ExpressionAttributeValues: marshall(exprValues),
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.steps,
              Key: marshall({ stepId: data.correlationId! }),
            })
          );
          if (result.Item) {
            step = dynamoToStep(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // Check why it failed
            const existing = await getStepForValidation(data.correlationId!);
            if (!existing) {
              throw new WorkflowAPIError(
                `Step "${data.correlationId}" not found`,
                { status: 404 }
              );
            }
            if (isStepTerminal(existing.status)) {
              throw new WorkflowAPIError(
                `Cannot modify step in terminal state "${existing.status}"`,
                { status: 409 }
              );
            }
          } else {
            throw err;
          }
        }
      }

      if (data.eventType === 'step_failed') {
        const eventData = data.eventData as {
          error?: any;
          stack?: string;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        try {
          await dynamo.send(
            new UpdateItemCommand({
              TableName: tables.steps,
              Key: marshall({ stepId: data.correlationId! }),
              UpdateExpression:
                'SET #s = :status, #err = :error, completedAt = :completedAt, updatedAt = :updatedAt',
              ConditionExpression:
                '#s <> :terminalCompleted AND #s <> :terminalFailed',
              ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
              ExpressionAttributeValues: marshall({
                ':status': 'failed',
                ':error': cborEncode({
                  message: errorMessage,
                  stack: eventData.stack,
                }),
                ':completedAt': nowIso,
                ':updatedAt': nowIso,
                ':terminalCompleted': 'completed',
                ':terminalFailed': 'failed',
              }),
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.steps,
              Key: marshall({ stepId: data.correlationId! }),
            })
          );
          if (result.Item) {
            step = dynamoToStep(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            const existing = await getStepForValidation(data.correlationId!);
            if (!existing) {
              throw new WorkflowAPIError(
                `Step "${data.correlationId}" not found`,
                { status: 404 }
              );
            }
            if (isStepTerminal(existing.status)) {
              throw new WorkflowAPIError(
                `Cannot modify step in terminal state "${existing.status}"`,
                { status: 409 }
              );
            }
          } else {
            throw err;
          }
        }
      }

      if (data.eventType === 'step_retrying') {
        const eventData = data.eventData as {
          error?: any;
          stack?: string;
          retryAfter?: Date;
        };
        const errorMessage =
          typeof eventData.error === 'string'
            ? eventData.error
            : (eventData.error?.message ?? 'Unknown error');

        let updateExpr =
          'SET #s = :status, #err = :error, updatedAt = :updatedAt';
        const exprNames: Record<string, string> = {
          '#s': 'status',
          '#err': 'error',
        };
        const exprValues: Record<string, any> = {
          ':status': 'pending',
          ':error': cborEncode({
            message: errorMessage,
            stack: eventData.stack,
          }),
          ':updatedAt': nowIso,
        };

        if (eventData.retryAfter) {
          updateExpr += ', retryAfter = :retryAfter';
          exprValues[':retryAfter'] = toIso(
            eventData.retryAfter instanceof Date
              ? eventData.retryAfter
              : new Date(eventData.retryAfter)
          );
        }

        await dynamo.send(
          new UpdateItemCommand({
            TableName: tables.steps,
            Key: marshall({ stepId: data.correlationId! }),
            UpdateExpression: updateExpr,
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: marshall(exprValues),
          })
        );
        const result = await dynamo.send(
          new GetItemCommand({
            TableName: tables.steps,
            Key: marshall({ stepId: data.correlationId! }),
          })
        );
        if (result.Item) {
          step = dynamoToStep(unmarshall(result.Item));
        }
      }

      if (data.eventType === 'hook_created') {
        const eventData = data.eventData as {
          token: string;
          metadata?: any;
          isWebhook?: boolean;
        };

        // Check for duplicate token
        const existingHookResult = await getHookByToken(eventData.token);
        if (existingHookResult) {
          // Create hook_conflict event
          const conflictEventData = { token: eventData.token };
          const createdAt = await insertEvent(
            effectiveRunId,
            eventId,
            {
              eventType: 'hook_conflict',
              correlationId: data.correlationId,
              eventData: conflictEventData,
            },
            effectiveSpecVersion
          );
          const conflictResult = {
            eventType: 'hook_conflict' as const,
            correlationId: data.correlationId,
            eventData: conflictEventData,
            createdAt,
            runId: effectiveRunId,
            eventId,
          };
          const parsedConflict = EventSchema.parse(conflictResult);
          const resolveData = params?.resolveData ?? 'all';
          return {
            event: filterEventData(parsedConflict, resolveData),
            run,
            step,
            hook: undefined,
          };
        }

        try {
          await dynamo.send(
            new PutItemCommand({
              TableName: tables.hooks,
              Item: marshallItem({
                runId: effectiveRunId,
                hookId: data.correlationId!,
                token: eventData.token,
                metadata: eventData.metadata
                  ? cborEncode(eventData.metadata)
                  : undefined,
                ownerId: '',
                projectId: '',
                environment: '',
                specVersion: effectiveSpecVersion,
                isWebhook: eventData.isWebhook,
                createdAt: nowIso,
              }),
              ConditionExpression: 'attribute_not_exists(hookId)',
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.hooks,
              Key: marshall({ hookId: data.correlationId! }),
            })
          );
          if (result.Item) {
            hook = dynamoToHook(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // Hook already exists, idempotent
          } else {
            throw err;
          }
        }
      }

      if (data.eventType === 'hook_disposed' && data.correlationId) {
        await dynamo.send(
          new DeleteItemCommand({
            TableName: tables.hooks,
            Key: marshall({ hookId: data.correlationId }),
          })
        );
      }

      if (data.eventType === 'wait_created') {
        const eventData = data.eventData as { resumeAt?: Date };
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        try {
          await dynamo.send(
            new PutItemCommand({
              TableName: tables.waits,
              Item: marshallItem({
                waitId,
                runId: effectiveRunId,
                status: 'waiting',
                resumeAt: eventData.resumeAt
                  ? toIso(
                      eventData.resumeAt instanceof Date
                        ? eventData.resumeAt
                        : new Date(eventData.resumeAt)
                    )
                  : undefined,
                specVersion: effectiveSpecVersion,
                createdAt: nowIso,
                updatedAt: nowIso,
              }),
              ConditionExpression: 'attribute_not_exists(waitId)',
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.waits,
              Key: marshall({ waitId }),
            })
          );
          if (result.Item) {
            wait = dynamoToWait(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            throw new WorkflowAPIError(
              `Wait "${data.correlationId}" already exists`,
              { status: 409 }
            );
          }
          throw err;
        }
      }

      if (data.eventType === 'wait_completed') {
        const waitId = `${effectiveRunId}-${data.correlationId}`;
        try {
          await dynamo.send(
            new UpdateItemCommand({
              TableName: tables.waits,
              Key: marshall({ waitId }),
              UpdateExpression:
                'SET #s = :status, completedAt = :completedAt, updatedAt = :updatedAt',
              ConditionExpression: '#s = :waiting',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: marshall({
                ':status': 'completed',
                ':completedAt': nowIso,
                ':updatedAt': nowIso,
                ':waiting': 'waiting',
              }),
            })
          );
          const result = await dynamo.send(
            new GetItemCommand({
              TableName: tables.waits,
              Key: marshall({ waitId }),
            })
          );
          if (result.Item) {
            wait = dynamoToWait(unmarshall(result.Item));
          }
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            const existing = await getWaitForValidation(waitId);
            if (!existing) {
              throw new WorkflowAPIError(
                `Wait "${data.correlationId}" not found`,
                { status: 404 }
              );
            }
            if (existing.status === 'completed') {
              throw new WorkflowAPIError(
                `Wait "${data.correlationId}" already completed`,
                { status: 409 }
              );
            }
          }
          throw err;
        }
      }

      // Insert the event
      const eventCreatedAt = await insertEvent(
        effectiveRunId,
        eventId,
        data,
        effectiveSpecVersion
      );

      const result = {
        ...data,
        createdAt: eventCreatedAt,
        runId: effectiveRunId,
        eventId,
      };
      const parsed = EventSchema.parse(result);
      const resolveData = params?.resolveData ?? 'all';
      return {
        event: filterEventData(parsed, resolveData),
        run,
        step,
        hook,
        wait,
      };
    },

    async get(
      runId: string,
      eventId: string,
      params?: GetEventParams
    ): Promise<Event> {
      const result = await dynamo.send(
        new GetItemCommand({
          TableName: tables.events,
          Key: marshall({ runId, eventId }),
        })
      );
      if (!result.Item) {
        throw new WorkflowAPIError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const item = unmarshall(result.Item);
      const event = dynamoToEvent(item);
      const resolveData = params?.resolveData ?? 'all';
      return filterEventData(event, resolveData);
    },

    async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      const queryParams: any = {
        TableName: tables.events,
        KeyConditionExpression: params.pagination?.cursor
          ? sortOrder === 'desc'
            ? 'runId = :runId AND eventId < :cursor'
            : 'runId = :runId AND eventId > :cursor'
          : 'runId = :runId',
        ExpressionAttributeValues: marshall(
          params.pagination?.cursor
            ? { ':runId': params.runId, ':cursor': params.pagination.cursor }
            : { ':runId': params.runId }
        ),
        ScanIndexForward: sortOrder !== 'desc',
        Limit: limit + 1,
      };

      const result = await dynamo.send(new QueryCommand(queryParams));
      const items = (result.Items ?? []).map((i) => unmarshall(i));
      const values = items.slice(0, limit);
      const hasMore = items.length > limit;

      return {
        data: values.map((item) =>
          filterEventData(dynamoToEvent(item), resolveData)
        ),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams
    ): Promise<PaginatedResponse<Event>> {
      const limit = params?.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || 'asc';
      const resolveData = params?.resolveData ?? 'all';

      const queryParams: any = {
        TableName: tables.events,
        IndexName: 'gsi_correlationId',
        KeyConditionExpression: params.pagination?.cursor
          ? sortOrder === 'desc'
            ? 'correlationId = :cid AND createdAt < :cursor'
            : 'correlationId = :cid AND createdAt > :cursor'
          : 'correlationId = :cid',
        ExpressionAttributeValues: marshall(
          params.pagination?.cursor
            ? {
                ':cid': params.correlationId,
                ':cursor': params.pagination.cursor,
              }
            : { ':cid': params.correlationId }
        ),
        ScanIndexForward: sortOrder !== 'desc',
        Limit: limit + 1,
      };

      const result = await dynamo.send(new QueryCommand(queryParams));
      const items = (result.Items ?? []).map((i) => unmarshall(i));
      const values = items.slice(0, limit);
      const hasMore = items.length > limit;

      return {
        data: values.map((item) =>
          filterEventData(dynamoToEvent(item), resolveData)
        ),
        cursor: values.at(-1)?.eventId ?? null,
        hasMore,
      };
    },
  };
}

// ============================================================
// Hooks Storage
// ============================================================

export function createHooksStorage(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): Storage['hooks'] {
  return {
    async get(hookId: string, params?: any): Promise<Hook> {
      const result = await dynamo.send(
        new GetItemCommand({
          TableName: tables.hooks,
          Key: marshall({ hookId }),
        })
      );
      if (!result.Item) {
        throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
          status: 404,
        });
      }
      const hook = dynamoToHook(unmarshall(result.Item));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },

    async getByToken(token: string, params?: any): Promise<Hook> {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: tables.hooks,
          IndexName: 'gsi_token',
          KeyConditionExpression: '#t = :token',
          ExpressionAttributeNames: { '#t': 'token' },
          ExpressionAttributeValues: marshall({ ':token': token }),
          Limit: 1,
        })
      );
      if (!result.Items?.length) {
        throw new HookNotFoundError(token);
      }
      const hook = dynamoToHook(unmarshall(result.Items[0]));
      const resolveData = params?.resolveData ?? 'all';
      return filterHookData(hook, resolveData);
    },

    async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
      const limit = params?.pagination?.limit ?? 100;
      const resolveData = params?.resolveData ?? 'all';

      let items: Record<string, any>[];

      if (params.runId) {
        const queryParams: any = {
          TableName: tables.hooks,
          IndexName: 'gsi_runId',
          KeyConditionExpression: 'runId = :runId',
          ExpressionAttributeValues: marshall({ ':runId': params.runId }),
          Limit: limit + 1,
        };
        if (params.pagination?.cursor) {
          queryParams.KeyConditionExpression += ' AND hookId > :cursor';
          queryParams.ExpressionAttributeValues = marshall({
            ':runId': params.runId,
            ':cursor': params.pagination.cursor,
          });
        }
        const result = await dynamo.send(new QueryCommand(queryParams));
        items = (result.Items ?? []).map((i) => unmarshall(i));
      } else {
        const scanParams: any = {
          TableName: tables.hooks,
          Limit: limit + 1,
        };
        const result = await dynamo.send(new ScanCommand(scanParams));
        items = (result.Items ?? []).map((i) => unmarshall(i));
      }

      const values = items.slice(0, limit);
      const hasMore = items.length > limit;

      return {
        data: values.map((item) =>
          filterHookData(dynamoToHook(item), resolveData)
        ),
        cursor: values.at(-1)?.hookId ?? null,
        hasMore,
      };
    },
  };
}

// ============================================================
// Steps Storage
// ============================================================

export function createStepsStorage(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>
): Storage['steps'] {
  return {
    get: (async (runId: string | undefined, stepId: string, params?: any) => {
      const result = await dynamo.send(
        new GetItemCommand({
          TableName: tables.steps,
          Key: marshall({ stepId }),
        })
      );
      if (!result.Item) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      const item = unmarshall(result.Item);
      // If runId was provided, verify it matches
      if (runId && item.runId !== runId) {
        throw new WorkflowAPIError(`Step not found: ${stepId}`, {
          status: 404,
        });
      }
      const step = dynamoToStep(item);
      const resolveData = params?.resolveData ?? 'all';
      return filterStepData(step, resolveData);
    }) as Storage['steps']['get'],

    list: (async (params: any) => {
      const limit = params?.pagination?.limit ?? 20;
      const resolveData = params?.resolveData ?? 'all';

      const queryParams: any = {
        TableName: tables.steps,
        IndexName: 'gsi_runId',
        KeyConditionExpression: 'runId = :runId',
        ExpressionAttributeValues: marshall({ ':runId': params.runId }),
        ScanIndexForward: false,
        Limit: limit + 1,
      };
      if (params.pagination?.cursor) {
        queryParams.KeyConditionExpression += ' AND stepId < :cursor';
        queryParams.ExpressionAttributeValues = marshall({
          ':runId': params.runId,
          ':cursor': params.pagination.cursor,
        });
      }

      const result = await dynamo.send(new QueryCommand(queryParams));
      const items = (result.Items ?? []).map((i) => unmarshall(i));
      const values = items.slice(0, limit);
      const hasMore = items.length > limit;

      return {
        data: values.map((item) =>
          filterStepData(dynamoToStep(item), resolveData)
        ),
        hasMore,
        cursor: values.at(-1)?.stepId ?? null,
      };
    }) as Storage['steps']['list'],
  };
}

// ============================================================
// Legacy event handler (pre-event-sourcing runs)
// ============================================================

async function handleLegacyEvent(
  dynamo: DynamoDBClient,
  tables: ReturnType<typeof tableNames>,
  runId: string,
  eventId: string,
  data: any,
  currentRun: { status: string; specVersion: number | null },
  params?: { resolveData?: ResolveData }
): Promise<EventResult> {
  const resolveData = params?.resolveData ?? 'all';
  const now = new Date();
  const nowIso = toIso(now);

  switch (data.eventType) {
    case 'run_cancelled': {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: tables.runs,
          Key: marshall({ runId }),
          UpdateExpression:
            'SET #s = :status, completedAt = :completedAt, updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: marshall({
            ':status': 'cancelled',
            ':completedAt': nowIso,
            ':updatedAt': nowIso,
          }),
        })
      );
      const result = await dynamo.send(
        new GetItemCommand({
          TableName: tables.runs,
          Key: marshall({ runId }),
        })
      );
      return {
        run: result.Item
          ? (filterRunData(
              dynamoToRun(unmarshall(result.Item)),
              resolveData
            ) as WorkflowRun)
          : undefined,
      };
    }

    case 'wait_completed':
    case 'hook_received': {
      await dynamo.send(
        new PutItemCommand({
          TableName: tables.events,
          Item: marshallItem({
            runId,
            eventId,
            correlationId: data.correlationId,
            eventType: data.eventType,
            eventData:
              'eventData' in data && data.eventData != null
                ? cborEncode(data.eventData)
                : undefined,
            specVersion: SPEC_VERSION_CURRENT,
            createdAt: nowIso,
          }),
        })
      );
      const event = EventSchema.parse({
        ...data,
        createdAt: now,
        runId,
        eventId,
      });
      return { event: filterEventData(event, resolveData) };
    }

    default:
      throw new Error(
        `Event type '${data.eventType}' not supported for legacy runs ` +
          `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
          `Please upgrade @workflow packages.`
      );
  }
}
