import { NativeSqliteWorld, nativeInfo as readNativeInfo } from './binding.js';

const ERROR_MARKER = 'WORKFLOW_NATIVE_ERROR:';
const EXPECTED_ADAPTER_PROTOCOL_VERSION = 1;

export class WorkflowNativeError extends Error {
  constructor({ code, kind = code, message, retryable, details }, cause) {
    super(message, { cause });
    this.name = 'WorkflowNativeError';
    this.code = code ?? kind;
    this.kind = kind;
    this.retryable = retryable;
    this.details = details;
  }
}

function mapNativeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const marker = message.indexOf(ERROR_MARKER);
  if (marker === -1) {
    return error;
  }
  try {
    const envelope = JSON.parse(message.slice(marker + ERROR_MARKER.length));
    return new WorkflowNativeError(envelope, error);
  } catch {
    return error;
  }
}

async function callNative(operation) {
  try {
    return await operation();
  } catch (error) {
    throw mapNativeError(error);
  }
}

export class SqliteWorldProbe {
  #native;
  #closed = false;
  #closePromise;
  #inFlight = new Set();

  constructor(path) {
    this.#native = new NativeSqliteWorld(path);
  }

  migrate() {
    return this.#run(() => this.#native.migrate());
  }

  createResilientRunStarted({
    runId,
    specVersion,
    deploymentId,
    workflowName,
    input,
    executionContext,
    attributes,
    allowReservedAttributes,
    encryptionPublicKey,
  }) {
    return this.#run(async () =>
      JSON.parse(
        await this.#native.createResilientRunStarted(
          runId,
          specVersion,
          deploymentId,
          workflowName,
          input,
          executionContext === undefined
            ? undefined
            : JSON.stringify(executionContext),
          attributes === undefined ? undefined : JSON.stringify(attributes),
          allowReservedAttributes === true,
          encryptionPublicKey
        )
      )
    );
  }

  snapshotContract(runId) {
    return this.#run(async () =>
      JSON.parse(await this.#native.snapshotContract(runId))
    );
  }

  startQueueWorker({
    scope,
    queueName,
    flowUrl,
    workerId = 'node-probe-worker',
    leaseDurationMs = 1_000,
    pollIntervalMs = 10,
    retryDelayMs = 10,
    requestTimeoutMs = 250,
  }) {
    return this.#run(() =>
      this.#native.startQueueWorker(
        scope,
        queueName,
        flowUrl,
        workerId,
        leaseDurationMs,
        pollIntervalMs,
        retryDelayMs,
        requestTimeoutMs
      )
    );
  }

  reconcileActiveRuns({ scope, deploymentId, queuePrefix }) {
    return this.#run(async () =>
      JSON.parse(
        await this.#native.reconcileActiveRuns(scope, deploymentId, queuePrefix)
      )
    );
  }

  queueMessageCount(scope) {
    return this.#run(() => this.#native.queueMessageCount(scope));
  }

  stopQueueWorker() {
    return this.#run(async () =>
      JSON.parse(await this.#native.stopQueueWorker())
    );
  }

  async close() {
    if (this.#closed) {
      await this.#closePromise;
      return false;
    }
    this.#closed = true;
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#inFlight]);
      await callNative(() => this.#native.stopQueueWorker());
      return this.#native.close();
    })();
    return this.#closePromise;
  }

  #run(operation) {
    if (this.#closed) {
      return Promise.reject(
        new WorkflowNativeError(
          {
            kind: 'closed',
            message: 'SQLite World handle is closed',
            retryable: false,
            details: {},
          },
          undefined
        )
      );
    }
    const nativePromise = callNative(operation);
    const trackedPromise = nativePromise.finally(() => {
      this.#inFlight.delete(trackedPromise);
    });
    this.#inFlight.add(trackedPromise);
    return trackedPromise;
  }
}

export const nativeInfo = JSON.parse(readNativeInfo());
if (nativeInfo.adapterProtocolVersion !== EXPECTED_ADAPTER_PROTOCOL_VERSION) {
  throw new Error(
    `Native adapter protocol ${nativeInfo.adapterProtocolVersion} is incompatible with JS adapter protocol ${EXPECTED_ADAPTER_PROTOCOL_VERSION}`
  );
}
