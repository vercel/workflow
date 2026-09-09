import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  EntityConflictError,
  HookNotFoundError,
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
  Hook,
  MessageId,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  RunCreatedEventRequest,
  Step,
  ValidQueueName as ValidQueueNameType,
  Wait,
  WorkflowRun,
  World,
} from '@workflow/world';
import {
  getMaxEventsPerRun,
  getQueueTopicPrefix,
  isTerminalWorkflowRunStatus,
  MessageId as MessageIdSchema,
  mintedSpecVersion,
  resolveQueueNamespace,
  stripEventDataRefs,
  ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import {
  type NativeEvent,
  type NativeEventData,
  type NativeEventResult,
  type NativeHook,
  type NativePage,
  type NativeRun,
  NativeSqliteWorld,
  type NativeStep,
  type NativeWait,
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
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SqliteWorldConfig {
  /** SQLite directory. Overrides WORKFLOW_LOCAL_DATABASE_DIR. */
  databaseDir?: string;
  /** @internal Exact database path for host-managed isolation (for example Vitest pools). */
  databaseFile?: string;
  /** @internal Open the database without write access for inspection tools. */
  readOnly?: boolean;
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
  /** Number of native loopback delivery workers. Defaults to 4. */
  workerConcurrency?: number;
  /** Re-enqueue pending/running runs when start() is called. Defaults to true. */
  recoverActiveRuns?: boolean;
  /** Maximum requested Hook retention in days. Defaults to 30. */
  hookRetentionLimitDays?: number;
}

export type SqliteWorld = World & {
  readonly databasePath: string;
  /** Validate the current schema without migrating or starting workers. */
  validate(): Promise<void>;
  /** Apply SQLite schema migrations explicitly. */
  migrate(): Promise<void>;
  /** Delete data from only this selected SQLite database, preserving its schema. */
  clear(): Promise<void>;
};

export interface SqliteHostRegistration {
  /** SQLite directory this registration serves. Overrides WORKFLOW_LOCAL_DATABASE_DIR. */
  databaseDir?: string;
  /** @internal Exact database path for host-managed isolation. */
  databaseFile?: string;
  /** Stable local compatible-worker-group target. */
  deploymentId?: string;
  /** Exact generated queue names this host can execute. */
  queueNames: ValidQueueNameType[];
  /** Full loopback flow URL. */
  flowUrl?: string;
  /** Base URL used to derive the standard flow route. */
  baseUrl?: string;
}

interface EngineConfig {
  target: string;
  queuePrefix: QueuePrefix;
  queueNames: string[];
  flowUrl?: string;
  leaseDurationMs: number;
  pollIntervalMs: number;
  retryDelayMs: number;
  requestTimeoutMs: number;
  workerConcurrency: number;
  recoverActiveRuns: boolean;
}

interface SharedEngine {
  native: InstanceType<typeof NativeSqliteWorld>;
  references: number;
  started: boolean;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  config?: EngineConfig;
}

interface LiveStream {
  stop(): void;
}

async function stopSharedEngine(engine: SharedEngine): Promise<void> {
  let shutdownError: unknown;
  try {
    if (engine.started && engine.config?.queueNames.length) {
      const report = await nativeCall(() => engine.native.stopQueueWorker());
      if (report.storageFailures > 0) {
        shutdownError = new WorkflowWorldError(
          `SQLite queue worker stopped after ${report.storageFailures} background storage failure(s) ` +
            `(${report.claims} claims, ${report.acknowledgements} acknowledgements, ` +
            `${report.reschedules} reschedules, ${report.deliveryFailures} delivery failures)`,
          {
            code: 'QUEUE_STORAGE_FAILURE',
            status: 503,
            cause: report,
          }
        );
      }
    }
  } catch (error) {
    shutdownError = error;
  }
  try {
    engine.native.close();
  } catch (error) {
    shutdownError ??= mapNativeError(error);
  }
  if (shutdownError !== undefined) throw shutdownError;
}

type SqliteHostRouting = Pick<
  SqliteHostRegistration,
  'queueNames' | 'flowUrl' | 'baseUrl'
>;

const state = globalSingleton('@workflow/world-sqlite//engines', 2, () => ({
  engines: new Map<string, SharedEngine>(),
  nextRunId: monotonicFactory(),
  nextMessageId: monotonicFactory(),
  hostRegistrations: new Map<string, SqliteHostRouting>(),
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
    case 'hook_not_found': {
      const identifier = envelope.details.identifier;
      return new HookNotFoundError(
        typeof identifier === 'string'
          ? identifier
          : (envelope.message.match(/Hook (?:token )?"([^"]+)"/)?.[1] ??
              'unknown')
      );
    }
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

function asDate(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

/**
 * N-API exposes Rust byte vectors as Node.js Buffers. Buffers are Uint8Array
 * subclasses, but their JSON toJSON hook leaks a different wire shape than the
 * other World implementations. Copy them at the public boundary so callers
 * consistently receive ordinary Uint8Arrays.
 */
function toBytes(value: Uint8Array): Uint8Array;
function toBytes(value: Uint8Array | undefined): Uint8Array | undefined;
function toBytes(value: Uint8Array | undefined): Uint8Array | undefined {
  return value === undefined ? undefined : Uint8Array.from(value);
}

function toPortableValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBytes(value);
  if (Array.isArray(value)) return value.map(toPortableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toPortableValue(item)])
    );
  }
  return value;
}

function toRun(run: NativeRun, resolveData: 'none' | 'all' = 'all') {
  return {
    runId: run.runId,
    status: run.status,
    deploymentId: run.deploymentId,
    workflowName: run.workflowName,
    specVersion: run.specVersion,
    executionContext:
      run.executionContext === undefined
        ? undefined
        : (toPortableValue(run.executionContext) as Record<string, unknown>),
    input: resolveData === 'none' ? undefined : toBytes(run.input),
    output: resolveData === 'none' ? undefined : toBytes(run.output),
    error: toBytes(run.error),
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
    input: resolveData === 'none' ? undefined : toBytes(step.input),
    output: resolveData === 'none' ? undefined : toBytes(step.output),
    error: toBytes(step.error),
    attempt: step.attempt,
    startedAt: asDate(step.startedAtMs),
    completedAt: asDate(step.completedAtMs),
    createdAt: new Date(step.createdAtMs),
    updatedAt: new Date(step.updatedAtMs),
    retryAfter: asDate(step.retryAfterMs),
    specVersion: step.specVersion,
  } as Step;
}

function toHook(hook: NativeHook, resolveData: 'none' | 'all' = 'all'): Hook {
  return {
    runId: hook.runId,
    hookId: hook.hookId,
    token: hook.token,
    ownerId: hook.ownerId,
    projectId: hook.projectId,
    environment: hook.environment,
    metadata: resolveData === 'none' ? undefined : toBytes(hook.metadata),
    createdAt: new Date(hook.createdAtMs),
    specVersion: hook.specVersion,
    isWebhook: hook.isWebhook,
    isSystem: hook.isSystem,
    tokenRetentionUntil: asDate(hook.tokenRetentionUntilMs),
  };
}

function toWait(wait: NativeWait): Wait {
  return {
    waitId: wait.waitId,
    runId: wait.runId,
    status: wait.status,
    resumeAt: asDate(wait.resumeAtMs),
    completedAt: asDate(wait.completedAtMs),
    createdAt: new Date(wait.createdAtMs),
    updatedAt: new Date(wait.updatedAtMs),
    specVersion: wait.specVersion,
  };
}

function toEventData(data: NativeEventData | undefined) {
  if (!data) return undefined;
  const {
    retryAfterMs,
    tokenRetentionUntilMs,
    resumeAtMs,
    input,
    output,
    error,
    result,
    metadata,
    payload,
    executionContext,
    ...rest
  } = data;
  return {
    ...rest,
    ...(input !== undefined && { input: toBytes(input) }),
    ...(output !== undefined && { output: toBytes(output) }),
    ...(error !== undefined && { error: toBytes(error) }),
    ...(result !== undefined && { result: toBytes(result) }),
    ...(metadata !== undefined && { metadata: toBytes(metadata) }),
    ...(payload !== undefined && { payload: toBytes(payload) }),
    ...(executionContext !== undefined && {
      executionContext: toPortableValue(executionContext) as Record<
        string,
        unknown
      >,
    }),
    ...(retryAfterMs !== undefined && { retryAfter: new Date(retryAfterMs) }),
    ...(tokenRetentionUntilMs !== undefined && {
      tokenRetentionUntil: new Date(tokenRetentionUntilMs),
    }),
    ...(resumeAtMs !== undefined && { resumeAt: new Date(resumeAtMs) }),
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
    resumeId: event.resumeId,
    correlationId: event.correlationId,
    eventData: toEventData(event.eventData),
  } as Event;
  return stripEventDataRefs(converted, resolveData);
}

function toStreamChunk(chunk: { index: number; data: Uint8Array }) {
  return { index: chunk.index, data: toBytes(chunk.data) };
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

function pageCursor(value: string | undefined): string | undefined {
  // The CLI's first page uses an empty-string flag default, and the mature
  // Worlds have always treated that value as an absent cursor.
  return value === '' ? undefined : value;
}

function canonicalizeDatabasePath(unresolvedPath: string): string {
  const unresolved = path.resolve(unresolvedPath);
  const suffix: string[] = [];
  let existingAncestor = unresolved;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    suffix.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  return path.join(canonicalAncestor, ...suffix);
}

function resolveDatabasePath(config: SqliteWorldConfig): string {
  if (config.databaseFile !== undefined) {
    return canonicalizeDatabasePath(config.databaseFile);
  }
  const directory =
    config.databaseDir ??
    process.env.WORKFLOW_LOCAL_DATABASE_DIR ??
    DEFAULT_DATABASE_DIRECTORY;
  return canonicalizeDatabasePath(path.join(directory, DATABASE_FILENAME));
}

function resolveFlowUrl(config: SqliteWorldConfig): string | undefined {
  if (config.flowUrl !== undefined) {
    return canonicalLoopbackHttpUrl(config.flowUrl, 'flowUrl');
  }
  const explicitPort = process.env.PORT;
  const baseUrl =
    config.baseUrl ??
    process.env.WORKFLOW_LOCAL_BASE_URL ??
    (explicitPort ? `http://127.0.0.1:${explicitPort}` : undefined);
  return baseUrl === undefined
    ? undefined
    : createWorkflowUrl(canonicalLoopbackHttpUrl(baseUrl, 'baseUrl'), {
        type: 'flow',
      });
}

function canonicalLoopbackHttpUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') {
      throw new Error('only http: is supported');
    }
    if (url.hostname === '0.0.0.0') {
      url.hostname = '127.0.0.1';
    } else if (url.hostname === '[::]') {
      url.hostname = '[::1]';
    }
    if (
      url.hostname !== '127.0.0.1' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '[::1]'
    ) {
      throw new Error('host must be loopback');
    }
    return url.toString();
  } catch (cause) {
    throw new WorkflowWorldError(
      `${field} must be an absolute loopback http URL`,
      {
        code: 'INVALID_ARGUMENT',
        cause,
      }
    );
  }
}

/**
 * Register process-local host routing before a zero-argument custom-world
 * factory is evaluated. Repeated identical registrations are harmless;
 * conflicting registrations fail before a worker can claim durable work.
 */
export function registerHost(registration: SqliteHostRegistration): void {
  if (
    registration.flowUrl !== undefined &&
    registration.baseUrl !== undefined
  ) {
    throw new WorkflowWorldError(
      'registerHost accepts either flowUrl or baseUrl, not both',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  const normalized: SqliteHostRouting = {
    queueNames: [
      ...new Set(
        registration.queueNames.map((name) => ValidQueueName.parse(name))
      ),
    ].sort(),
    ...(registration.flowUrl !== undefined && {
      flowUrl: canonicalLoopbackHttpUrl(registration.flowUrl, 'flowUrl'),
    }),
    ...(registration.baseUrl !== undefined && {
      baseUrl: canonicalLoopbackHttpUrl(registration.baseUrl, 'baseUrl'),
    }),
  };
  if (
    normalized.queueNames.length > 0 &&
    normalized.flowUrl === undefined &&
    normalized.baseUrl === undefined
  ) {
    throw new WorkflowWorldError(
      'registerHost requires flowUrl or baseUrl when queueNames are configured',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  const registrationKey = hostRegistrationKey(registration);
  const current = state.hostRegistrations.get(registrationKey);
  if (
    current !== undefined &&
    JSON.stringify(current) !== JSON.stringify(normalized)
  ) {
    throw new WorkflowWorldError(
      'SQLite World host is already registered with conflicting routing for this database and deployment target',
      { code: 'CONFIGURATION_CONFLICT' }
    );
  }
  state.hostRegistrations.set(registrationKey, normalized);
}

function hostRegistrationKey(
  config: Pick<
    SqliteWorldConfig,
    'databaseDir' | 'databaseFile' | 'deploymentId'
  >
): string {
  const target = config.deploymentId ?? DEFAULT_DEPLOYMENT_ID;
  if (target.length === 0) {
    throw new WorkflowWorldError('deploymentId must not be empty', {
      code: 'INVALID_ARGUMENT',
    });
  }
  return JSON.stringify([resolveDatabasePath(config), target]);
}

function withRegisteredHost(config: SqliteWorldConfig): SqliteWorldConfig {
  if (config.readOnly) return config;
  const registered = state.hostRegistrations.get(hostRegistrationKey(config));
  if (!registered) return config;
  const hasExplicitEndpoint =
    config.flowUrl !== undefined || config.baseUrl !== undefined;
  return {
    ...config,
    queueNames: config.queueNames ?? registered.queueNames,
    ...(!hasExplicitEndpoint && registered.flowUrl !== undefined
      ? { flowUrl: registered.flowUrl }
      : {}),
    ...(!hasExplicitEndpoint && registered.baseUrl !== undefined
      ? { baseUrl: registered.baseUrl }
      : {}),
  };
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

function resolveDeploymentTarget(config: SqliteWorldConfig): string {
  const target = config.deploymentId ?? DEFAULT_DEPLOYMENT_ID;
  if (target.length === 0) {
    throw new WorkflowWorldError('deploymentId must not be empty', {
      code: 'INVALID_ARGUMENT',
    });
  }
  return target;
}

function readOnlyEngineConfig(config: SqliteWorldConfig): EngineConfig {
  return {
    target: resolveDeploymentTarget(config),
    queuePrefix: getQueueTopicPrefix('workflow'),
    queueNames: [],
    leaseDurationMs: 30_000,
    pollIntervalMs: 25,
    retryDelayMs: 100,
    requestTimeoutMs: 10_000,
    workerConcurrency: 4,
    recoverActiveRuns: false,
  };
}

function normalizedEngineConfig(config: SqliteWorldConfig): EngineConfig {
  const queueNames = (config.queueNames ?? []).map((name) =>
    ValidQueueName.parse(name)
  );
  const target = resolveDeploymentTarget(config);
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
  const workerConcurrency = durationOption(
    config.workerConcurrency,
    4,
    'workerConcurrency'
  );
  if (workerConcurrency > 256) {
    throw new WorkflowWorldError(
      'workerConcurrency must be an integer between 1 and 256',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  return {
    target,
    queuePrefix: getQueueTopicPrefix('workflow', resolveQueueNamespace()),
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
    workerConcurrency,
    recoverActiveRuns: config.recoverActiveRuns ?? true,
  };
}

function resolveHookRetentionLimitMs(config: SqliteWorldConfig): number {
  const days = Number(
    config.hookRetentionLimitDays ??
      process.env.WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS ??
      30
  );
  if (
    !Number.isFinite(days) ||
    days <= 0 ||
    days * DAY_MS > Number.MAX_SAFE_INTEGER
  ) {
    throw new WorkflowWorldError(
      'hookRetentionLimitDays and WORKFLOW_LOCAL_HOOK_RETENTION_LIMIT_DAYS must be a positive, safe number',
      { code: 'INVALID_ARGUMENT' }
    );
  }
  return days * DAY_MS;
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

function waitForPoll(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function asPayload(value: unknown, field: string): Uint8Array | undefined {
  if (value === undefined || value instanceof Uint8Array) return value;
  throw new WorkflowWorldError(
    `${field} must be a Uint8Array for persisted spec ${mintedSpecVersion()}`,
    { code: 'INVALID_ARGUMENT' }
  );
}

function streamChunkBytes(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
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
    case 'hook_received':
      return asPayload(
        data.eventData.payload,
        'hook_received.eventData.payload'
      );
    case 'hook_created':
      return asPayload(
        data.eventData.metadata,
        'hook_created.eventData.metadata'
      );
    case 'run_cancelled':
    case 'attr_set':
    case 'hook_disposed':
    case 'wait_created':
    case 'wait_completed':
      return undefined;
    default:
      throw new WorkflowWorldError(
        `event type ${JSON.stringify((data as { eventType: string }).eventType)} is not user-creatable`,
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
  token?: string;
  tokenRetentionUntilMs?: number;
  isWebhook?: boolean;
  isSystem?: boolean;
  resumeAtMs?: number;
  attributeChanges?: Array<{ key: string; value: string | null }>;
  attributeWriterType?: string;
  attributeWriterStepId?: string;
  attributeWriterAttempt?: number;
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
  const tokenRetentionUntil = eventDataField<Date>(
    eventData,
    'tokenRetentionUntil'
  );
  const resumeAt = eventDataField<Date>(eventData, 'resumeAt');
  const writer = eventDataField<{
    type?: string;
    stepId?: string;
    attempt?: number;
  }>(eventData, 'writer');
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
    token: eventDataField(eventData, 'token'),
    tokenRetentionUntilMs: tokenRetentionUntil?.getTime(),
    isWebhook: eventDataField(eventData, 'isWebhook'),
    isSystem: eventDataField(eventData, 'isSystem'),
    resumeAtMs: resumeAt?.getTime(),
    attributeChanges: eventDataField(eventData, 'changes'),
    attributeWriterType: writer?.type,
    attributeWriterStepId: writer?.stepId,
    attributeWriterAttempt: writer?.attempt,
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
    ...(result.hook && { hook: toHook(result.hook, resolveData) }),
    ...(result.wait && { wait: toWait(result.wait) }),
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
 * Create the opt-in native SQLite World.
 *
 * Construction does not create or migrate the database. Call `migrate()`
 * explicitly during setup, then `start()` when the host is ready to consume
 * the exact `queueNames` supplied in configuration.
 */
// @lat: [[rust-portability#Delivery Sequence#Phase 1: Node.js and SQLite Walking Skeleton]]
export function createWorld(config: SqliteWorldConfig = {}): SqliteWorld {
  const effectiveConfig = withRegisteredHost(config);
  const databasePath = resolveDatabasePath(effectiveConfig);
  const readOnly = effectiveConfig.readOnly ?? false;
  const engineConfig = readOnly
    ? readOnlyEngineConfig(effectiveConfig)
    : normalizedEngineConfig(effectiveConfig);
  const hookRetentionLimitMs = readOnly
    ? 0
    : resolveHookRetentionLimitMs(effectiveConfig);
  const engineKey = JSON.stringify([
    databasePath,
    engineConfig.target,
    readOnly,
  ]);
  let engine = state.engines.get(engineKey);
  if (!engine) {
    engine = {
      native: new NativeSqliteWorld(databasePath, readOnly),
      references: 0,
      started: false,
    };
    state.engines.set(engineKey, engine);
  }
  engine.references += 1;
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const liveStreams = new Set<LiveStream>();

  const assertOpen = () => {
    if (closed) {
      throw new WorkflowWorldError('SQLite World instance is closed', {
        code: 'CLOSED',
      });
    }
  };

  const assertWritable = () => {
    if (readOnly) {
      throw new WorkflowWorldError(
        'SQLite World was opened for read-only observability',
        { code: 'READ_ONLY' }
      );
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
    assertWritable();
    const runId = suppliedRunId ?? `wrun_${state.nextRunId()}`;
    if (suppliedRunId === null && data.eventType !== 'run_created') {
      throw new WorkflowWorldError(
        'only run_created may request a generated run ID',
        { code: 'INVALID_ARGUMENT' }
      );
    }
    if (
      data.eventType === 'hook_created' &&
      data.eventData.tokenRetentionUntil !== undefined &&
      data.eventData.tokenRetentionUntil.getTime() >
        Date.now() + hookRetentionLimitMs
    ) {
      throw new WorkflowWorldError(
        `Hook minimum retention cannot exceed ${hookRetentionLimitMs / DAY_MS} days in the SQLite World.`,
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
        fields.cancelReason,
        params.resumeId,
        params.resumePayloadDigest,
        fields.token,
        fields.tokenRetentionUntilMs,
        fields.isWebhook,
        fields.isSystem,
        fields.resumeAtMs,
        fields.attributeChanges,
        fields.attributeWriterType,
        fields.attributeWriterStepId,
        fields.attributeWriterAttempt
      )
    );
    return makeEventResult(result, params.resolveData ?? 'all');
  }) as World['events']['create'];

  const world: SqliteWorld = {
    databasePath,
    specVersion: mintedSpecVersion(),
    capabilities: {
      hookRetention: { active: true },
      hookResumeDedup: true,
    },
    async validate() {
      assertOpen();
      await runNative(() => engine.native.ensureReady());
    },
    async migrate() {
      assertOpen();
      assertWritable();
      await runNative(() => engine.native.migrate());
    },
    async clear() {
      assertOpen();
      assertWritable();
      await runNative(() => engine.native.clear());
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
      waitForTerminalStatus: (async (
        runId: string,
        params?: {
          resolveData?: 'none' | 'all';
          timeoutMs?: number;
          signal?: AbortSignal;
        }
      ) => {
        const timeoutMs = params?.timeoutMs ?? 0;
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
          throw new WorkflowWorldError(
            'waitForTerminalStatus timeoutMs must be nonnegative',
            { code: 'INVALID_ARGUMENT' }
          );
        }
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const run = await world.runs.get(runId, params);
          if (isTerminalWorkflowRunStatus(run.status)) return run;
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0 || params?.signal?.aborted) return run;
          await waitForPoll(
            Math.min(remainingMs, engineConfig.pollIntervalMs),
            params?.signal
          );
        }
      }) as NonNullable<World['runs']['waitForTerminalStatus']>,
      list: (async (params) => {
        assertOpen();
        const resolveData = params?.resolveData ?? 'all';
        const page = await runNative(() =>
          engine.native.listRuns(
            params?.workflowName,
            params?.status,
            pageCursor(params?.pagination?.cursor),
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
            pageCursor(params.pagination?.cursor),
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
        const descending = (params.pagination?.sortOrder ?? 'asc') === 'desc';
        const requestedLimit = params.pagination?.limit;
        if (requestedLimit !== undefined) {
          const page = await runNative(() =>
            engine.native.listEvents(
              params.runId,
              undefined,
              pageCursor(params.pagination?.cursor),
              pageLimit(requestedLimit),
              descending
            )
          );
          return toPage(page, (event) =>
            toEvent(event, params.resolveData ?? 'all')
          );
        }

        const data: NativeEvent[] = [];
        const maxEvents = getMaxEventsPerRun();
        let cursor = pageCursor(params.pagination?.cursor);
        let resultCursor: string | undefined;
        let hasMore = true;
        while (hasMore && data.length < maxEvents) {
          const page = await runNative(() =>
            engine.native.listEvents(
              params.runId,
              undefined,
              cursor,
              Math.min(MAX_PAGE_LIMIT, maxEvents - data.length),
              descending
            )
          );
          data.push(...page.data);
          resultCursor = page.cursor;
          hasMore = page.hasMore;
          if (!hasMore || data.length >= maxEvents) break;
          if (!page.cursor) {
            throw new WorkflowWorldError(
              'SQLite World returned an event page without a continuation cursor',
              { code: 'NATIVE_FAILURE' }
            );
          }
          cursor = page.cursor;
        }
        return {
          data: data.map((event) =>
            toEvent(event, params.resolveData ?? 'all')
          ),
          cursor: resultCursor ?? null,
          hasMore,
        };
      },
      async listByCorrelationId(params) {
        assertOpen();
        const page = await runNative(() =>
          engine.native.listEvents(
            params.runId,
            params.correlationId,
            pageCursor(params.pagination?.cursor),
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
      get: (async (hookId, params) => {
        const hook = await runNative(() => engine.native.getHook(hookId));
        return toHook(hook, params?.resolveData ?? 'all');
      }) as World['hooks']['get'],
      getByToken: (async (token, params) => {
        const hook = await runNative(() => engine.native.getHookByToken(token));
        return toHook(hook, params?.resolveData ?? 'all');
      }) as World['hooks']['getByToken'],
      list: (async (params) => {
        const resolveData = params.resolveData ?? 'all';
        const page = await runNative(() =>
          engine.native.listHooks(
            params.runId,
            pageCursor(params.pagination?.cursor),
            pageLimit(params.pagination?.limit),
            (params.pagination?.sortOrder ?? 'asc') === 'desc'
          )
        );
        return toPage(page, (hook) => toHook(hook, resolveData));
      }) as World['hooks']['list'],
    },
    streams: {
      async write(runId, name, chunk) {
        assertOpen();
        assertWritable();
        await runNative(() =>
          engine.native.writeStreamChunks(runId, name, [
            streamChunkBytes(chunk),
          ])
        );
      },
      async writeMulti(runId, name, chunks) {
        assertOpen();
        assertWritable();
        if (chunks.length === 0) return;
        await runNative(() =>
          engine.native.writeStreamChunks(
            runId,
            name,
            chunks.map(streamChunkBytes)
          )
        );
      },
      async close(runId, name) {
        assertOpen();
        assertWritable();
        await runNative(() => engine.native.closeStream(runId, name));
      },
      async get(runId, name, startIndex = 0) {
        if (!Number.isSafeInteger(startIndex)) {
          throw new WorkflowWorldError(
            'stream startIndex must be a safe integer',
            { code: 'INVALID_ARGUMENT' }
          );
        }
        let nextIndex = startIndex;
        if (nextIndex < 0) {
          const info = await runNative(() =>
            engine.native.getStreamInfo(runId, name)
          );
          nextIndex = Math.max(0, info.tailIndex + 1 + nextIndex);
        }
        let cursor = `index:${nextIndex}`;
        let stopped = false;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const abort = new AbortController();
        const liveStream: LiveStream = {
          stop() {
            if (stopped) return;
            stopped = true;
            abort.abort();
            liveStreams.delete(liveStream);
            try {
              controller?.close();
            } catch {
              // The consumer may already have cancelled or errored the stream.
            }
          },
        };
        return new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            liveStreams.add(liveStream);
          },
          async pull(streamController) {
            try {
              while (!stopped) {
                const desired = Math.floor(streamController.desiredSize ?? 1);
                const page = await runNative(() =>
                  engine.native.getStreamChunks(
                    runId,
                    name,
                    cursor,
                    Math.max(1, Math.min(DEFAULT_PAGE_LIMIT, desired))
                  )
                );
                if (stopped) return;
                for (const chunk of page.data) {
                  streamController.enqueue(toBytes(chunk.data));
                }
                const last = page.data.at(-1);
                if (last) cursor = `index:${last.index + 1}`;
                else if (page.cursor) cursor = page.cursor;
                if (page.done && !page.hasMore) {
                  liveStream.stop();
                  return;
                }
                if (page.data.length > 0) return;
                await waitForPoll(engineConfig.pollIntervalMs, abort.signal);
              }
            } catch (error) {
              if (stopped) return;
              stopped = true;
              abort.abort();
              liveStreams.delete(liveStream);
              streamController.error(error);
            }
          },
          cancel() {
            liveStream.stop();
          },
        });
      },
      async list(runId) {
        return runNative(() => engine.native.listStreams(runId));
      },
      async getChunks(runId, name, options) {
        const page = await runNative(() =>
          engine.native.getStreamChunks(
            runId,
            name,
            pageCursor(options?.cursor),
            pageLimit(options?.limit)
          )
        );
        return {
          data: page.data.map(toStreamChunk),
          cursor: page.cursor ?? null,
          hasMore: page.hasMore,
          done: page.done,
        };
      },
      async getInfo(runId, name) {
        return runNative(() => engine.native.getStreamInfo(runId, name));
      },
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
      assertWritable();
      ValidQueueName.parse(queueName);
      if (options.headers && Object.keys(options.headers).length > 0) {
        throw new WorkflowWorldError(
          'custom queue headers are not supported by SQLite World',
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
      assertWritable();
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
        if (engineConfig.recoverActiveRuns) {
          await nativeCall(() =>
            engine.native.reconcileActiveRuns(
              engineConfig.target,
              engineConfig.queuePrefix,
              Date.now()
            )
          );
        }
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
              engineConfig.requestTimeoutMs,
              engineConfig.workerConcurrency
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
      for (const stream of [...liveStreams]) stream.stop();
      await Promise.allSettled([...inFlight]);
      engine.references -= 1;
      if (engine.references > 0) return;
      if (!engine.stopPromise) {
        if (state.engines.get(engineKey) === engine) {
          state.engines.delete(engineKey);
        }
        engine.stopPromise = stopSharedEngine(engine);
      }
      await engine.stopPromise;
    },
  };

  return world;
}

export { nativeInfo };
