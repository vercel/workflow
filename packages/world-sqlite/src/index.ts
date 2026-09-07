import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  EntityConflictError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import { createWorkflowUrl, globalSingleton } from '@workflow/utils';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  MessageId,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  RunCreatedEventRequest,
  Step,
  ValidQueueName as ValidQueueNameType,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  MessageId as MessageIdSchema,
  mintedSpecVersion,
  stripEventDataRefs,
  ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import {
  type NativeEvent,
  type NativeEventData,
  type NativeEventResult,
  type NativePage,
  type NativeRun,
  NativeSqliteWorld,
  type NativeStep,
  nativeInfo,
} from './native.js';
import {
  deserializeQueuePayload,
  serializeQueuePayload,
} from './typed-json.js';

const DATABASE_FILENAME = 'workflow.sqlite';
const DEFAULT_DATABASE_DIRECTORY = '.workflow-database';
const DEFAULT_DEPLOYMENT_ID = 'local-js';
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
const MAX_QUEUE_VISIBILITY_SECONDS = 2_147_483.647;
const MAX_UINT32 = 4_294_967_295;

export interface SqliteWorldConfig {
  /** SQLite directory. Overrides WORKFLOW_LOCAL_DATABASE_DIR. */
  databaseDir?: string;
  /** Stable local compatible-worker-group target. */
  deploymentId?: string;
  /** Exact queue names this process is allowed to consume. */
  queueNames?: ValidQueueNameType[];
  /** Full loopback flow URL. No port discovery is performed. */
  flowUrl?: string;
  /** Base URL used to derive the standard flow route when flowUrl is absent. */
  baseUrl?: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

export type SqliteWorld = World & {
  readonly databasePath: string;
  /** Apply SQLite schema migrations explicitly. */
  migrate(): Promise<void>;
};

interface EngineConfig {
  target: string;
  queueNames: string[];
  flowUrl?: string;
  leaseDurationMs: number;
  pollIntervalMs: number;
  retryDelayMs: number;
  requestTimeoutMs: number;
}

interface SharedEngine {
  native: InstanceType<typeof NativeSqliteWorld>;
  references: number;
  started: boolean;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  config?: EngineConfig;
}

const state = globalSingleton('@workflow/world-sqlite//engines', 1, () => ({
  engines: new Map<string, SharedEngine>(),
  nextRunId: monotonicFactory(),
  nextMessageId: monotonicFactory(),
}));

interface NativeErrorEnvelope {
  code: string;
  kind: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

const ERROR_MARKER = 'WORKFLOW_NATIVE_ERROR:';

function parseNativeError(error: unknown): NativeErrorEnvelope | undefined {
  if (!(error instanceof Error)) return undefined;
  const markerIndex = error.message.indexOf(ERROR_MARKER);
  if (markerIndex < 0) return undefined;
  try {
    const parsed = JSON.parse(
      error.message.slice(markerIndex + ERROR_MARKER.length)
    ) as Partial<NativeErrorEnvelope>;
    if (
      typeof parsed.code === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.message === 'string' &&
      typeof parsed.retryable === 'boolean' &&
      parsed.details !== null &&
      typeof parsed.details === 'object'
    ) {
      return parsed as NativeErrorEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function runIdFromMessage(message: string): string {
  return message.match(/workflow run "([^"]+)"/)?.[1] ?? 'unknown';
}

function mapNativeError(error: unknown): Error {
  const envelope = parseNativeError(error);
  if (!envelope) {
    return new WorkflowWorldError('SQLite World native operation failed', {
      code: 'NATIVE_FAILURE',
      cause: error,
    });
  }
  switch (envelope.kind) {
    case 'run_not_found':
      return new WorkflowRunNotFoundError(runIdFromMessage(envelope.message));
    case 'entity_conflict':
      return new EntityConflictError(envelope.message);
    case 'run_expired':
      return new RunExpiredError(envelope.message);
    case 'too_early':
      return new TooEarlyError(envelope.message, {
        retryAfter:
          typeof envelope.details.retryAfter === 'number'
            ? envelope.details.retryAfter
            : undefined,
      });
    default:
      return new WorkflowWorldError(envelope.message, {
        code: envelope.code,
        status: envelope.retryable ? 503 : undefined,
        cause: error,
      });
  }
}

async function nativeCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapNativeError(error);
  }
}

function unsupported(capability: string): Promise<never> {
  return Promise.reject(
    new WorkflowWorldError(
      `@workflow/world-sqlite does not implement ${capability} in Phase 1`,
      { code: 'UNSUPPORTED_OPERATION' }
    )
  );
}

function asDate(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

function toRun(run: NativeRun, resolveData: 'none' | 'all' = 'all') {
  return {
    runId: run.runId,
    status: run.status,
    deploymentId: run.deploymentId,
    workflowName: run.workflowName,
    specVersion: run.specVersion,
    executionContext: run.executionContext,
    input: resolveData === 'none' ? undefined : run.input,
    output: resolveData === 'none' ? undefined : run.output,
    error: run.error,
    errorCode: run.errorCode,
    attributes: run.attributes,
    encryptionPublicKey: run.encryptionPublicKey,
    startedAt: asDate(run.startedAtMs),
    completedAt: asDate(run.completedAtMs),
    createdAt: new Date(run.createdAtMs),
    updatedAt: new Date(run.updatedAtMs),
  } as WorkflowRun;
}

function toStep(step: NativeStep, resolveData: 'none' | 'all' = 'all') {
  return {
    runId: step.runId,
    stepId: step.stepId,
    stepName: step.stepName,
    status: step.status,
    input: resolveData === 'none' ? undefined : step.input,
    output: resolveData === 'none' ? undefined : step.output,
    error: step.error,
    attempt: step.attempt,
    startedAt: asDate(step.startedAtMs),
    completedAt: asDate(step.completedAtMs),
    createdAt: new Date(step.createdAtMs),
    updatedAt: new Date(step.updatedAtMs),
    retryAfter: asDate(step.retryAfterMs),
    specVersion: step.specVersion,
  } as Step;
}

function toEventData(data: NativeEventData | undefined) {
  if (!data) return undefined;
  const { retryAfterMs, ...rest } = data;
  return {
    ...rest,
    ...(retryAfterMs !== undefined && { retryAfter: new Date(retryAfterMs) }),
  };
}

function toEvent(event: NativeEvent, resolveData: 'none' | 'all' = 'all') {
  const converted = {
    eventType: event.eventType,
    runId: event.runId,
    eventId: event.eventId,
    specVersion: event.specVersion,
    createdAt: new Date(event.createdAtMs),
    occurredAt: asDate(event.occurredAtMs),
    correlationId: event.correlationId,
    eventData: toEventData(event.eventData),
  } as Event;
  return stripEventDataRefs(converted, resolveData);
}

function toPage<T, U>(
  page: NativePage<T>,
  convert: (value: T) => U
): { data: U[]; cursor: string | null; hasMore: boolean } {
  return {
    data: page.data.map(convert),
    cursor: page.cursor ?? null,
    hasMore: page.hasMore,
  };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new WorkflowWorldError(
      'pagination.limit must be between 1 and 1000',
      {
        code: 'INVALID_ARGUMENT',
      }
    );
  }
  return value;
}

function resolveDatabasePath(databaseDir?: string): string {
  const directory =
    databaseDir ??
    process.env.WORKFLOW_LOCAL_DATABASE_DIR ??
    DEFAULT_DATABASE_DIRECTORY;
  const unresolved = path.resolve(directory);
  const suffix: string[] = [];
  let existingAncestor = unresolved;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    suffix.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  return path.join(canonicalAncestor, ...suffix, DATABASE_FILENAME);
}

function resolveFlowUrl(config: SqliteWorldConfig): string | undefined {
  if (config.flowUrl !== undefined) return new URL(config.flowUrl).toString();
  const baseUrl = config.baseUrl ?? process.env.WORKFLOW_LOCAL_BASE_URL;
  return baseUrl === undefined
    ? undefined
    : createWorkflowUrl(baseUrl, { type: 'flow' });
}

function durationOption(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false
): number {
  const resolved = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > MAX_UINT32
  ) {
    throw new WorkflowWorldError(
      `${name} must be an integer between ${minimum} and ${MAX_UINT32}`,
      { code: 'INVALID_ARGUMENT' }
    );
  }
  return resolved;
}

function normalizedEngineConfig(config: SqliteWorldConfig): EngineConfig {
  const queueNames = (config.queueNames ?? []).map((name) =>
    ValidQueueName.parse(name)
  );
  const target = config.deploymentId ?? DEFAULT_DEPLOYMENT_ID;
  if (target.length === 0) {
    throw new WorkflowWorldError('deploymentId must not be empty', {
      code: 'INVALID_ARGUMENT',
    });
  }
  const leaseDurationMs = durationOption(
    config.leaseDurationMs,
    30_000,
    'leaseDurationMs'
  );
  const requestTimeoutMs = durationOption(
    config.requestTimeoutMs,
    10_000,
    'requestTimeoutMs'
  );
  if (requestTimeoutMs >= leaseDurationMs) {
    throw new WorkflowWorldError(
      'requestTimeoutMs must be shorter than leaseDurationMs',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  return {
    target,
    queueNames: [...new Set(queueNames)].sort(),
    flowUrl: resolveFlowUrl(config),
    leaseDurationMs,
    pollIntervalMs: durationOption(config.pollIntervalMs, 25, 'pollIntervalMs'),
    retryDelayMs: durationOption(
      config.retryDelayMs,
      100,
      'retryDelayMs',
      true
    ),
    requestTimeoutMs,
  };
}

function queueAvailableAt(delaySeconds: number | undefined): number {
  const delay = delaySeconds ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new WorkflowWorldError(
      'delaySeconds must be a finite nonnegative number',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  const availableAt = Date.now() + Math.ceil(delay * 1000);
  if (!Number.isSafeInteger(availableAt)) {
    throw new WorkflowWorldError('delaySeconds exceeds the timestamp range', {
      code: 'INVALID_ARGUMENT',
    });
  }
  return availableAt;
}

function sameEngineConfig(left: EngineConfig, right: EngineConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asPayload(value: unknown, field: string): Uint8Array | undefined {
  if (value === undefined || value instanceof Uint8Array) return value;
  throw new WorkflowWorldError(
    `${field} must be a Uint8Array for persisted spec ${mintedSpecVersion()}`,
    { code: 'INVALID_ARGUMENT' }
  );
}

function payloadForEvent(
  data: CreateEventRequest | RunCreatedEventRequest
): Uint8Array | undefined {
  switch (data.eventType) {
    case 'run_created':
    case 'run_started':
    case 'step_created':
    case 'step_started':
      return asPayload(
        data.eventData?.input,
        `${data.eventType}.eventData.input`
      );
    case 'run_completed':
      return asPayload(data.eventData.output, 'run_completed.eventData.output');
    case 'run_failed':
    case 'step_failed':
    case 'step_retrying':
      return asPayload(
        data.eventData.error,
        `${data.eventType}.eventData.error`
      );
    case 'step_completed':
      return asPayload(
        data.eventData.result,
        'step_completed.eventData.result'
      );
    case 'run_cancelled':
      return undefined;
    default:
      throw new WorkflowWorldError(
        `event type ${JSON.stringify(data.eventType)} is outside the Phase 1 run/step slice`,
        { code: 'UNSUPPORTED_OPERATION' }
      );
  }
}

interface NativeEventFields {
  payload?: Uint8Array;
  deploymentId?: string;
  workflowName?: string;
  executionContext?: Record<string, unknown>;
  attributes?: Record<string, string>;
  allowReservedAttributes: boolean;
  encryptionPublicKey?: string;
  stepName?: string;
  attempt?: number;
  retryAfterMs?: number;
  ownerMessageId?: string;
  errorCode?: string;
  cancelReason?: string;
}

function eventDataField<T>(
  eventData: Record<string, unknown> | undefined,
  name: string
): T | undefined {
  return eventData?.[name] as T | undefined;
}

function nativeEventFields(
  data: CreateEventRequest | RunCreatedEventRequest
): NativeEventFields {
  const eventData = data.eventData as Record<string, unknown> | undefined;
  const retryAfter = eventDataField<Date>(eventData, 'retryAfter');
  return {
    payload: payloadForEvent(data),
    deploymentId: eventDataField(eventData, 'deploymentId'),
    workflowName: eventDataField(eventData, 'workflowName'),
    executionContext: eventDataField(eventData, 'executionContext'),
    attributes: eventDataField(eventData, 'attributes'),
    allowReservedAttributes:
      eventDataField(eventData, 'allowReservedAttributes') === true,
    encryptionPublicKey: eventDataField(eventData, 'encryptionPublicKey'),
    stepName: eventDataField(eventData, 'stepName'),
    attempt: eventDataField(eventData, 'attempt'),
    retryAfterMs: retryAfter?.getTime(),
    ownerMessageId: eventDataField(eventData, 'ownerMessageId'),
    errorCode: eventDataField(eventData, 'errorCode'),
    cancelReason: eventDataField(eventData, 'cancelReason'),
  };
}

function makeEventResult(
  result: NativeEventResult,
  resolveData: 'none' | 'all'
): EventResult {
  return {
    ...(result.event && { event: toEvent(result.event, resolveData) }),
    ...(result.run && { run: toRun(result.run, resolveData) }),
    ...(result.step && { step: toStep(result.step, resolveData) }),
    ...(result.stepCreated && { stepCreated: true as const }),
    ...(result.events && {
      events: result.events.map((event) => toEvent(event, resolveData)),
      cursor: result.cursor ?? null,
      hasMore: result.hasMore ?? false,
    }),
  } as EventResult;
}

type QueueHandler = Parameters<World['createQueueHandler']>[1];

interface QueueRequestMetadata {
  attempt: number;
  queueName: ValidQueueNameType;
  messageId: MessageId;
}

function parseQueueRequestMetadata(
  request: Request,
  queueNamePrefix: QueuePrefix
): QueueRequestMetadata | Response {
  if (!request.body) {
    return Response.json({ error: 'Missing request body' }, { status: 400 });
  }
  const queueName = request.headers.get('x-vqs-queue-name');
  const messageId = request.headers.get('x-vqs-message-id');
  const attempt = Number(request.headers.get('x-vqs-message-attempt'));
  if (
    queueName === null ||
    messageId === null ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    return Response.json(
      { error: 'Missing required headers' },
      { status: 400 }
    );
  }
  const parsedQueueName = ValidQueueName.safeParse(queueName);
  const parsedMessageId = MessageIdSchema.safeParse(messageId);
  if (
    !parsedQueueName.success ||
    !parsedMessageId.success ||
    !queueName.startsWith(queueNamePrefix)
  ) {
    return Response.json({ error: 'Unhandled queue' }, { status: 400 });
  }
  return {
    attempt,
    queueName: parsedQueueName.data,
    messageId: parsedMessageId.data,
  };
}

function queueHandlerResultResponse(result: unknown): Response {
  const timeout = (result as { timeoutSeconds?: unknown } | undefined)
    ?.timeoutSeconds;
  if (typeof timeout !== 'number') {
    return Response.json({ ok: true });
  }
  const timeoutSeconds = Math.min(
    Math.max(0, timeout),
    MAX_QUEUE_VISIBILITY_SECONDS
  );
  return Response.json({ timeoutSeconds });
}

async function handleQueueRequest(
  request: Request,
  queueNamePrefix: QueuePrefix,
  handler: QueueHandler
): Promise<Response> {
  const metadata = parseQueueRequestMetadata(request, queueNamePrefix);
  if (metadata instanceof Response) return metadata;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    const result = await handler(deserializeQueuePayload(body), metadata);
    return queueHandlerResultResponse(result);
  } catch (error) {
    return Response.json(String(error), { status: 500 });
  }
}

/**
 * Create the opt-in Phase 1 native SQLite World.
 *
 * Construction does not create or migrate the database. Call `migrate()`
 * explicitly during setup, then `start()` when the host is ready to consume
 * the exact `queueNames` supplied in configuration.
 */
// @lat: [[rust-portability#Delivery Sequence#Phase 1: Node.js and SQLite Walking Skeleton]]
export function createWorld(config: SqliteWorldConfig = {}): SqliteWorld {
  const databasePath = resolveDatabasePath(config.databaseDir);
  const engineConfig = normalizedEngineConfig(config);
  const engineKey = JSON.stringify([databasePath, engineConfig.target]);
  let engine = state.engines.get(engineKey);
  if (!engine) {
    engine = {
      native: new NativeSqliteWorld(databasePath),
      references: 0,
      started: false,
    };
    state.engines.set(engineKey, engine);
  }
  engine.references += 1;
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();

  const assertOpen = () => {
    if (closed) {
      throw new WorkflowWorldError('SQLite World instance is closed', {
        code: 'CLOSED',
      });
    }
  };

  const track = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
    return tracked;
  };

  const runNative = <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen();
    return track(nativeCall(operation));
  };

  const createEvent = (async (
    suppliedRunId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
    params: CreateEventParams = {}
  ) => {
    assertOpen();
    const runId = suppliedRunId ?? `wrun_${state.nextRunId()}`;
    if (suppliedRunId === null && data.eventType !== 'run_created') {
      throw new WorkflowWorldError(
        'only run_created may request a generated run ID',
        { code: 'INVALID_ARGUMENT' }
      );
    }
    const fields = nativeEventFields(data);
    const result = await runNative(() =>
      engine.native.createEvent(
        runId,
        data.eventType,
        data.specVersion ?? mintedSpecVersion(),
        params.eventCount,
        params.occurredAt?.getTime(),
        data.correlationId,
        fields.payload,
        fields.deploymentId,
        fields.workflowName,
        fields.executionContext,
        fields.attributes,
        fields.allowReservedAttributes,
        fields.encryptionPublicKey,
        fields.stepName,
        fields.attempt,
        fields.retryAfterMs,
        fields.ownerMessageId,
        fields.errorCode,
        fields.cancelReason
      )
    );
    return makeEventResult(result, params.resolveData ?? 'all');
  }) as World['events']['create'];

  const world: SqliteWorld = {
    databasePath,
    specVersion: mintedSpecVersion(),
    capabilities: {},
    async migrate() {
      assertOpen();
      await runNative(() => engine.native.migrate());
    },
    runs: {
      get: (async (
        runId: string,
        params?: { resolveData?: 'none' | 'all' }
      ) => {
        assertOpen();
        const run = await runNative(() => engine.native.getRun(runId));
        return toRun(run, params?.resolveData ?? 'all');
      }) as World['runs']['get'],
      list: (async (params) => {
        assertOpen();
        const resolveData = params?.resolveData ?? 'all';
        const page = await runNative(() =>
          engine.native.listRuns(
            params?.workflowName,
            params?.status,
            params?.pagination?.cursor,
            pageLimit(params?.pagination?.limit),
            (params?.pagination?.sortOrder ?? 'desc') === 'desc'
          )
        );
        return toPage(page, (run) => toRun(run, resolveData));
      }) as World['runs']['list'],
    },
    steps: {
      get: (async (
        runId: string,
        stepId: string,
        params?: { resolveData?: 'none' | 'all' }
      ) => {
        assertOpen();
        const step = await runNative(() =>
          engine.native.getStep(runId, stepId)
        );
        return toStep(step, params?.resolveData ?? 'all');
      }) as World['steps']['get'],
      list: (async (params) => {
        assertOpen();
        const resolveData = params.resolveData ?? 'all';
        const page = await runNative(() =>
          engine.native.listSteps(
            params.runId,
            params.pagination?.cursor,
            pageLimit(params.pagination?.limit),
            (params.pagination?.sortOrder ?? 'desc') === 'desc'
          )
        );
        return toPage(page, (step) => toStep(step, resolveData));
      }) as World['steps']['list'],
    },
    events: {
      create: createEvent,
      async get(runId, eventId, params) {
        assertOpen();
        const event = await runNative(() =>
          engine.native.getEvent(runId, eventId)
        );
        return toEvent(event, params?.resolveData ?? 'all');
      },
      async list(params) {
        assertOpen();
        const page = await runNative(() =>
          engine.native.listEvents(
            params.runId,
            undefined,
            params.pagination?.cursor,
            pageLimit(params.pagination?.limit),
            (params.pagination?.sortOrder ?? 'asc') === 'desc'
          )
        );
        return toPage(page, (event) =>
          toEvent(event, params.resolveData ?? 'all')
        );
      },
      async listByCorrelationId(params) {
        assertOpen();
        const page = await runNative(() =>
          engine.native.listEvents(
            params.runId,
            params.correlationId,
            params.pagination?.cursor,
            pageLimit(params.pagination?.limit),
            (params.pagination?.sortOrder ?? 'asc') === 'desc'
          )
        );
        return toPage(page, (event) =>
          toEvent(event, params.resolveData ?? 'all')
        );
      },
    },
    hooks: {
      get: () => unsupported('hooks'),
      getByToken: () => unsupported('hooks'),
      list: () => unsupported('hooks'),
    },
    streams: {
      write: () => unsupported('streams'),
      close: () => unsupported('streams'),
      get: () => unsupported('streams'),
      list: () => unsupported('streams'),
      getChunks: () => unsupported('streams'),
      getInfo: () => unsupported('streams'),
    },
    async getDeploymentId() {
      assertOpen();
      return engineConfig.target;
    },
    async queue(
      queueName: ValidQueueNameType,
      message: QueuePayload,
      options: QueueOptions = {}
    ) {
      assertOpen();
      ValidQueueName.parse(queueName);
      if (options.headers && Object.keys(options.headers).length > 0) {
        throw new WorkflowWorldError(
          'custom queue headers are not supported by SQLite World Phase 1',
          { code: 'UNSUPPORTED_OPERATION' }
        );
      }
      const messageId = MessageIdSchema.parse(
        `msg_${state.nextMessageId()}`
      ) as MessageId;
      const result = await runNative(() =>
        engine.native.enqueue(
          messageId,
          options.deploymentId ?? engineConfig.target,
          queueName,
          options.idempotencyKey ?? messageId,
          serializeQueuePayload(message),
          queueAvailableAt(options.delaySeconds)
        )
      );
      return { messageId: MessageIdSchema.parse(result.messageId) };
    },
    createQueueHandler(queueNamePrefix: QueuePrefix, handler: QueueHandler) {
      return (request) => handleQueueRequest(request, queueNamePrefix, handler);
    },
    async start() {
      assertOpen();
      if (engine.config && !sameEngineConfig(engine.config, engineConfig)) {
        throw new WorkflowWorldError(
          `SQLite database ${databasePath} is already active with conflicting worker configuration`,
          { code: 'CONFIGURATION_CONFLICT' }
        );
      }
      if (engine.started) return;
      if (engine.startPromise) return track(engine.startPromise);
      engine.config = engineConfig;
      engine.startPromise = (async () => {
        await nativeCall(() => engine.native.ensureReady());
        if (engineConfig.queueNames.length > 0) {
          if (!engineConfig.flowUrl) {
            throw new WorkflowWorldError(
              'flowUrl or baseUrl is required when queueNames are configured',
              { code: 'INVALID_ARGUMENT' }
            );
          }
          try {
            engine.native.startQueueWorker(
              engineConfig.target,
              engineConfig.queueNames,
              engineConfig.flowUrl,
              `node-${process.pid}`,
              engineConfig.leaseDurationMs,
              engineConfig.pollIntervalMs,
              engineConfig.retryDelayMs,
              engineConfig.requestTimeoutMs
            );
          } catch (error) {
            throw mapNativeError(error);
          }
        }
        engine.started = true;
      })();
      try {
        await track(engine.startPromise);
      } catch (error) {
        engine.config = undefined;
        throw error;
      } finally {
        engine.startPromise = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...inFlight]);
      engine.references -= 1;
      if (engine.references > 0) return;
      if (!engine.stopPromise) {
        if (state.engines.get(engineKey) === engine) {
          state.engines.delete(engineKey);
        }
        engine.stopPromise = (async () => {
          if (engine.started && engine.config?.queueNames.length) {
            await nativeCall(() => engine.native.stopQueueWorker());
          }
          try {
            engine.native.close();
          } catch (error) {
            throw mapNativeError(error);
          }
        })();
      }
      await engine.stopPromise;
    },
  };

  return world;
}

export { nativeInfo };
