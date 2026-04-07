import {
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  type WorkflowRunStatus,
  type World,
} from '@workflow/world';
import { type CryptoKey, importKey } from '../encryption.js';
import {
  getExternalRevivers,
  hydrateWorkflowReturnValue,
} from '../serialization.js';
import { getWorkflowRunStreamId } from '../util.js';
import {
  type StopSleepOptions,
  type StopSleepResult,
  wakeUpRun,
} from './runs.js';
import { getWorld } from './world.js';

/**
 * A `ReadableStream` extended with workflow-specific helpers.
 */
export type WorkflowReadableStream<R = any> = ReadableStream<R> & {
  /**
   * Returns the tail index (index of the last known chunk, 0-based) of the
   * underlying workflow stream. Useful for resolving a negative `startIndex`
   * into an absolute position — for example, when building reconnection
   * endpoints that need to inform the client where the stream starts.
   *
   * Returns `-1` when no chunks have been written yet.
   */
  getTailIndex(): Promise<number>;
};

/**
 * Options for configuring a workflow's readable stream.
 */
export interface WorkflowReadableStreamOptions {
  /**
   * An optional namespace to distinguish between multiple streams associated
   * with the same workflow run.
   */
  namespace?: string;
  /**
   * The index number of the starting chunk to begin reading the stream from.
   * Negative values start from the end (e.g. -3 reads the last 3 chunks).
   */
  startIndex?: number;
  /**
   * Any asynchronous operations that need to be performed before the execution
   * environment is paused / terminated
   * (i.e. using [`waitUntil()`](https://developer.mozilla.org/docs/Web/API/ExtendableEvent/waitUntil) or similar).
   */
  ops?: Promise<any>[];
  /**
   * The global object to use for hydrating types from the global scope.
   *
   * Defaults to {@link [`globalThis`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/globalThis)}.
   */
  global?: Record<string, any>;
}

/**
 * A handler class for a workflow run.
 */
export class Run<TResult> {
  /**
   * The ID of the workflow run.
   */
  runId: string;

  /**
   * The world object.
   * @internal
   */
  private world: World;

  /**
   * Cached encryption key resolution. Resolved once on first use and
   * reused for returnValue, getReadable(), etc.
   * @internal
   */
  private encryptionKeyPromise: Promise<CryptoKey | undefined> | null = null;

  /**
   * When true, run_created failed and the run may not exist yet (the
   * resilient start path will create it via run_started). pollReturnValue
   * retries on WorkflowRunNotFoundError only when this flag is set so
   * that normal runs fail fast on 404.
   * @internal
   */
  private resilientStart = false;

  constructor(runId: string, opts?: { resilientStart?: boolean }) {
    this.runId = runId;
    this.world = getWorld();
    this.resilientStart = opts?.resilientStart ?? false;
  }

  /**
   * Resolves and caches the encryption key for this run.
   * The key is the same for the lifetime of a run, so it only needs
   * to be resolved once.
   * @internal
   */
  private getEncryptionKey(): Promise<CryptoKey | undefined> {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = (async () => {
        const run = await this.world.runs.get(this.runId);
        const rawKey = await this.world.getEncryptionKeyForRun?.(run);
        return rawKey ? await importKey(rawKey) : undefined;
      })();
    }
    return this.encryptionKeyPromise;
  }

  /**
   * Interrupts pending `sleep()` calls, resuming the workflow early.
   *
   * @param options - Optional settings to target specific sleep calls by correlation ID.
   *   If not provided, all pending sleep calls will be interrupted.
   * @returns A {@link StopSleepResult} object containing the number of sleep calls that were interrupted.
   */
  async wakeUp(options?: StopSleepOptions): Promise<StopSleepResult> {
    return wakeUpRun(this.world, this.runId, options);
  }

  /**
   * Cancels the workflow run.
   */
  async cancel(): Promise<void> {
    await this.world.events.create(this.runId, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    });
  }

  /**
   * Whether the workflow run exists.
   */
  get exists(): Promise<boolean> {
    return this.world.runs
      .get(this.runId, { resolveData: 'none' })
      .then(() => true)
      .catch((error) => {
        if (WorkflowRunNotFoundError.is(error)) {
          return false;
        }
        throw error;
      });
  }

  /**
   * The status of the workflow run.
   */
  get status(): Promise<WorkflowRunStatus> {
    return this.world.runs.get(this.runId).then((run) => run.status);
  }

  /**
   * The return value of the workflow run.
   * Polls the workflow return value until it is completed.
   */
  get returnValue(): Promise<TResult> {
    return this.pollReturnValue();
  }

  /**
   * The name of the workflow.
   */
  get workflowName(): Promise<string> {
    return this.world.runs.get(this.runId).then((run) => run.workflowName);
  }

  /**
   * The timestamp when the workflow run was created.
   */
  get createdAt(): Promise<Date> {
    return this.world.runs.get(this.runId).then((run) => run.createdAt);
  }

  /**
   * The timestamp when the workflow run started execution.
   * Returns undefined if the workflow has not started yet.
   */
  get startedAt(): Promise<Date | undefined> {
    return this.world.runs.get(this.runId).then((run) => run.startedAt);
  }

  /**
   * The timestamp when the workflow run completed.
   * Returns undefined if the workflow has not completed yet.
   */
  get completedAt(): Promise<Date | undefined> {
    return this.world.runs.get(this.runId).then((run) => run.completedAt);
  }

  /**
   * The readable stream of the workflow run.
   */
  get readable(): WorkflowReadableStream {
    return this.getReadable();
  }

  /**
   * Retrieves the workflow run's default readable stream, which reads chunks
   * written to the corresponding writable stream {@link getWritable}.
   *
   * The returned stream has an additional {@link WorkflowReadableStream.getTailIndex | getTailIndex()}
   * helper that returns the index of the last known chunk. This is useful when
   * building reconnection endpoints that need to inform clients where the
   * stream starts.
   *
   * @param options - The options for the readable stream.
   * @returns A `WorkflowReadableStream` for the workflow run.
   */
  getReadable<R = any>(
    options: WorkflowReadableStreamOptions = {}
  ): WorkflowReadableStream<R> {
    const { ops = [], global = globalThis, startIndex, namespace } = options;
    const name = getWorkflowRunStreamId(this.runId, namespace);
    // Pass the key as a promise — it will be resolved lazily inside
    // the first async transform() call of the deserialize stream.
    const encryptionKey = this.getEncryptionKey();
    const stream = getExternalRevivers(
      global,
      ops,
      this.runId,
      encryptionKey
    ).ReadableStream({
      name,
      startIndex,
    }) as ReadableStream<R>;

    const world = this.world;
    const runId = this.runId;
    return Object.assign(stream, {
      getTailIndex: async (): Promise<number> => {
        const info = await world.streams.getInfo(runId, name);
        return info.tailIndex;
      },
    });
  }

  /**
   * Polls the workflow return value every 1 second until it is completed.
   * @internal
   * @returns The workflow return value.
   */
  private async pollReturnValue(): Promise<TResult> {
    // When resilientStart is true, run_created failed and the run may
    // not exist yet. Retry on WorkflowRunNotFoundError up to 3 times
    // (1s + 3s + 6s = 10s total) to give the queue time to deliver
    // and the runtime to create the run via run_started.
    // When resilientStart is false, 404 is a real error — fail fast.
    let notFoundRetries = 0;
    const NOT_FOUND_MAX_RETRIES = this.resilientStart ? 3 : 0;
    const NOT_FOUND_DELAYS = [1_000, 3_000, 6_000];

    while (true) {
      try {
        const run = await this.world.runs.get(this.runId);

        if (run.status === 'completed') {
          const encryptionKey = await this.getEncryptionKey();
          return await hydrateWorkflowReturnValue(
            run.output,
            this.runId,
            encryptionKey
          );
        }

        if (run.status === 'cancelled') {
          throw new WorkflowRunCancelledError(this.runId);
        }

        if (run.status === 'failed') {
          throw new WorkflowRunFailedError(this.runId, run.error);
        }

        throw new WorkflowRunNotCompletedError(this.runId, run.status);
      } catch (error) {
        if (WorkflowRunNotCompletedError.is(error)) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        if (
          WorkflowRunNotFoundError.is(error) &&
          notFoundRetries < NOT_FOUND_MAX_RETRIES
        ) {
          const delay = NOT_FOUND_DELAYS[notFoundRetries]!;
          notFoundRetries++;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }
}

/**
 * Retrieves a `Run` object for a given run ID.
 *
 * @param runId - The workflow run ID obtained from {@link start}.
 * @returns A `Run` object.
 * @throws WorkflowRunNotFoundError if the run ID is not found.
 */
export function getRun<TResult>(runId: string): Run<TResult> {
  return new Run(runId);
}
