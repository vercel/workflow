import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface NativeInfo {
  crateVersion: string;
  nodeApiVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  persistedSpecMin: number;
  persistedSpecMax: number;
  enabledBackends: string[];
}

export interface NativeRun {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  deploymentId: string;
  workflowName: string;
  specVersion: number;
  input: Uint8Array;
  output?: Uint8Array;
  error?: Uint8Array;
  errorCode?: string;
  executionContext?: Record<string, unknown>;
  attributes: Record<string, string>;
  encryptionPublicKey?: string;
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}

export interface NativeStep {
  runId: string;
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  input: Uint8Array;
  output?: Uint8Array;
  error?: Uint8Array;
  attempt: number;
  startedAtMs?: number;
  completedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  retryAfterMs?: number;
  specVersion: number;
}

export interface NativeEventData {
  deploymentId?: string;
  workflowName?: string;
  input?: Uint8Array;
  executionContext?: Record<string, unknown>;
  attributes?: Record<string, string>;
  allowReservedAttributes?: true;
  encryptionPublicKey?: string;
  output?: Uint8Array;
  error?: Uint8Array;
  errorCode?: string;
  cancelReason?: string;
  stepName?: string;
  result?: Uint8Array;
  attempt?: number;
  retryAfterMs?: number;
  ownerMessageId?: string;
}

export interface NativeEvent {
  eventType: string;
  runId: string;
  eventId: string;
  specVersion: number;
  createdAtMs: number;
  occurredAtMs?: number;
  correlationId?: string;
  eventData?: NativeEventData;
}

export interface NativePage<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

export interface NativeEventResult {
  event?: NativeEvent;
  run?: NativeRun;
  step?: NativeStep;
  stepCreated?: true;
  events?: NativeEvent[];
  cursor?: string;
  hasMore?: boolean;
}

export interface NativeQueueWorkerReport {
  claims: number;
  acknowledgements: number;
  reschedules: number;
  deliveryFailures: number;
  storageFailures: number;
}

export interface NativeSqliteWorld {
  migrate(): Promise<void>;
  ensureReady(): Promise<void>;
  createEvent(
    runId: string,
    eventType: string,
    specVersion: number,
    eventCount: number | undefined,
    occurredAtMs: number | undefined,
    correlationId: string | undefined,
    payload: Uint8Array | undefined,
    deploymentId: string | undefined,
    workflowName: string | undefined,
    executionContext: Record<string, unknown> | undefined,
    attributes: Record<string, string> | undefined,
    allowReservedAttributes: boolean,
    encryptionPublicKey: string | undefined,
    stepName: string | undefined,
    attempt: number | undefined,
    retryAfterMs: number | undefined,
    ownerMessageId: string | undefined,
    errorCode: string | undefined,
    cancelReason: string | undefined
  ): Promise<NativeEventResult>;
  getRun(runId: string): Promise<NativeRun>;
  listRuns(
    workflowName: string | undefined,
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
    descending: boolean
  ): Promise<NativePage<NativeRun>>;
  getStep(runId: string, stepId: string): Promise<NativeStep>;
  listSteps(
    runId: string,
    cursor: string | undefined,
    limit: number,
    descending: boolean
  ): Promise<NativePage<NativeStep>>;
  getEvent(runId: string, eventId: string): Promise<NativeEvent>;
  listEvents(
    runId: string,
    correlationId: string | undefined,
    cursor: string | undefined,
    limit: number,
    descending: boolean
  ): Promise<NativePage<NativeEvent>>;
  enqueue(
    messageId: string,
    target: string,
    queueName: string,
    idempotencyKey: string,
    body: Uint8Array,
    availableAtMs: number
  ): Promise<{ messageId: string; created: boolean }>;
  queueMessageCount(target: string): Promise<number>;
  startQueueWorker(
    target: string,
    queueNames: string[],
    flowUrl: string,
    workerId: string,
    leaseDurationMs: number,
    pollIntervalMs: number,
    retryDelayMs: number,
    requestTimeoutMs: number
  ): void;
  stopQueueWorker(): Promise<NativeQueueWorkerReport>;
  close(): boolean;
}

interface NativeModule {
  NativeSqliteWorld: new (path: string) => NativeSqliteWorld;
  nativeInfo(): NativeInfo;
}

interface PackageInfo {
  version: string;
}

const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(
  new URL('../workflow-world-sqlite.node', import.meta.url)
);
const packageInfo = require(
  fileURLToPath(new URL('../package.json', import.meta.url))
) as PackageInfo;

const addon = (() => {
  try {
    return require(addonPath) as NativeModule;
  } catch (cause) {
    throw new Error(
      `@workflow/world-sqlite has no usable native addon for ${process.platform}/${process.arch}. ` +
        'Install a package artifact for a Phase 1 supported target.',
      { cause }
    );
  }
})();

const info = Object.freeze(addon.nativeInfo());
if (
  info.crateVersion !== packageInfo.version ||
  info.nodeApiVersion !== 8 ||
  info.sqliteVersion !== '3.53.2' ||
  !info.enabledBackends.includes('sqlite')
) {
  throw new Error(
    `@workflow/world-sqlite loaded an incompatible native addon: ${JSON.stringify(info)}`
  );
}

export const NativeSqliteWorld = addon.NativeSqliteWorld;
export const nativeInfo = (): NativeInfo => ({
  ...info,
  enabledBackends: [...info.enabledBackends],
});
