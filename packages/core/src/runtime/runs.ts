import {
  EntityConflictError,
  FatalError,
  RetryableError,
  START_HOOK_CANDIDATE_CANCELLED,
  StreamError,
  ThrottleError,
  WorkflowRunNotFoundError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  BULK_CANCEL_MAX_RUN_IDS,
  type BulkCancelWorkflowRunResult,
  type BulkCancelWorkflowRunsResult,
  DELETE_RUNS_DATA_MAX_RUN_IDS,
  type DeleteRunDataResult,
  type DeleteRunsDataResult,
  type Event,
  isLegacySpecVersion,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { runtimeLogger } from '../logger.js';
import { deriveRunPayloadKeys } from '../serialization/encryption.js';
import { hydrateWorkflowArguments } from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import { afterRunCancelled } from './after-terminal-write.js';
import { readDynamicWorkflowMetadata } from './dynamic-workflow.js';
import { getWorkflowQueueName } from './helpers.js';
import { specVersionForRunWrite } from './run-spec-version.js';
import { start } from './start.js';

export interface RecreateRunOptions {
  deploymentId?: string;
  specVersion?: number;
  /**
   * Queue namespace of the target deployment (e.g. `'eve'` for topics like
   * `__eve_wkf_workflow_*`). Falls back to `WORKFLOW_QUEUE_NAMESPACE` in
   * the calling process. Cross-context callers (e.g. the observability
   * dashboard) must pass the target deployment's namespace explicitly,
   * since a run enqueued to a topic the target deployment has no consumer
   * for is never picked up.
   */
  namespace?: string;
  /**
   * Region for the new run. Defaults to the source run's region, as reported
   * by `World.regionForRunId`, so a replay is placed where the original run's
   * data lives instead of in whatever region the calling process runs in.
   * When the world can't derive one, `start()`'s own region resolution
   * applies.
   */
  region?: string;
}

export interface StopSleepResult {
  /**
   * Number of pending sleeps the call stopped. On a single-orchestrator run
   * (spec version 9 and later) it is the number the call asked the run's
   * orchestrator to complete, which may not complete early (see
   * {@link wakeUpRun}).
   */
  stoppedCount: number;
}

export interface ReadStreamOptions {
  /**
   * The index to start reading from. Defaults to 0.
   * Negative values start from the end (e.g. -3 reads the last 3 chunks).
   */
  startIndex?: number;
}

export interface StopSleepOptions {
  /**
   * Optional list of specific correlation IDs to target.
   * If provided, only these sleep calls will be interrupted.
   * If not provided, all pending sleep calls will be interrupted.
   */
  correlationIds?: string[];
  /**
   * Queue namespace of the run's deployment (e.g. `'eve'`), used when
   * re-enqueueing the run after completing its waits. Falls back to
   * `WORKFLOW_QUEUE_NAMESPACE` in the calling process. Cross-context
   * callers (e.g. the observability dashboard) must pass it explicitly.
   */
  namespace?: string;
}

export interface ReenqueueRunOptions {
  /**
   * Queue namespace of the run's deployment (e.g. `'eve'`). Falls back to
   * `WORKFLOW_QUEUE_NAMESPACE` in the calling process. Cross-context
   * callers (e.g. the observability dashboard) must pass it explicitly.
   */
  namespace?: string;
}

export interface CancelRunOptions {
  /**
   * Optional free-text reason for the cancellation (max 512 chars), recorded
   * on the run_cancelled event and surfaced in the run detail view.
   */
  cancelReason?: string;
}

const normalizeWorkflowArgs = (args: unknown): unknown[] => {
  return Array.isArray(args) ? args : [args];
};

/**
 * Start a new workflow run based on an existing run.
 */
export async function recreateRunFromExisting(
  world: World,
  runId: string,
  options: RecreateRunOptions = {}
): Promise<string> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'all' });
    // A dynamic run's workflow function is not in the deployment's bundle;
    // it lives on the run, encrypted under that run's key. Starting a new run
    // by workflow name alone would create one with the dynamic id and no code
    // behind it, which no delivery could ever execute. Carrying the code
    // over means decrypting it and re-encrypting under the new run's key,
    // which this path does not do yet, so refuse rather than create a run
    // that fails on its first delivery.
    if (readDynamicWorkflowMetadata(run.executionContext)) {
      throw new WorkflowRuntimeError(
        `Run ${runId} is a dynamic workflow run; re-running it is not supported. Start it again from its source with start(source, args, { experimental_dynamic }).`
      );
    }
    const rawKey = await world.getEncryptionKeyForRun?.(run);
    const encryptionKey = rawKey
      ? await deriveRunPayloadKeys(rawKey)
      : undefined;
    const workflowArgs = normalizeWorkflowArgs(
      await hydrateWorkflowArguments(
        run.input,
        runId,
        encryptionKey,
        globalThis
      )
    );
    const deploymentId = options.deploymentId ?? run.deploymentId;
    // The source run's spec version describes the deployment that executed
    // it, so it is only a valid default for a replay on that same
    // deployment. When the replay is redirected elsewhere, leave it unset
    // and let `start()` resolve the target's version from its capability
    // probe, instead of pinning the replay to the old deployment's.
    const specVersion =
      options.specVersion ??
      (deploymentId === run.deploymentId
        ? (run.specVersion ?? SPEC_VERSION_LEGACY)
        : undefined);
    const region = options.region ?? world.regionForRunId?.(runId) ?? undefined;

    // Never forward the source run's `startHook`: a re-run is a new run by
    // intent, and the reservation would refuse it as a duplicate.
    const newRun = await start(
      { workflowId: run.workflowName },
      workflowArgs as unknown[],
      {
        deploymentId,
        world,
        specVersion,
        replayedFromRunId: runId,
        namespace: options.namespace,
        ...(region !== undefined ? { region } : {}),
      }
    );
    return newRun.runId;
  } catch (err) {
    throw new Error(
      `Failed to recreate run from ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Whether `run` has a single orchestrator (spec version 9 and later), whose
 * writes are classified in-band or out-of-band. Older runs make neither
 * distinction, and their writes go out as they always did.
 */
export function isSingleOrchestratorRun(
  run: Pick<WorkflowRun, 'specVersion'>
): boolean {
  return (
    (run.specVersion ?? SPEC_VERSION_LEGACY) >= SPEC_VERSION_SINGLE_ORCHESTRATOR
  );
}

/**
 * Wakes a single-orchestrator run's orchestrator after an out-of-band write
 * (a cancellation), so a live or later orchestrator observes it. No
 * idempotency key: a duplicate wake costs a cheap delivery, a key could lose
 * the wakeup. Best effort: the write already committed, and the next
 * delivery of the run reads it either way. Older runs are not woken: their
 * next delivery observes the write, as it always did.
 */
export async function wakeRunAfterOutOfBandWrite(
  world: World,
  run: Pick<
    WorkflowRun,
    'runId' | 'workflowName' | 'deploymentId' | 'specVersion'
  >
): Promise<void> {
  if (!isSingleOrchestratorRun(run)) return;
  try {
    await world.queue(
      getWorkflowQueueName(run.workflowName),
      {
        runId: run.runId,
        requestedAt: new Date(),
        runSpecVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
      },
      {
        deploymentId: run.deploymentId,
        ...(run.specVersion !== undefined
          ? { specVersion: run.specVersion }
          : {}),
      }
    );
  } catch (err) {
    runtimeLogger.warn('Failed to wake the run after an out-of-band write', {
      workflowRunId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cancel a workflow run.
 *
 * A run that does not exist (yet) is still cancelled through the World: a
 * `start({ experimental_hook })` candidate that was admitted but never created a run (the
 * recovery `WorkflowStartError` points at) is fenced by it, so no copy of it
 * can create the run any more. Otherwise the World answers not found, which
 * is thrown as `WorkflowRunNotFoundError`.
 *
 * @param options - Optional cancellation settings. `cancelReason` records a
 *   free-text reason (max 512 chars) on the run_cancelled event.
 */
export async function cancelRun(
  world: World,
  runId: string,
  options?: CancelRunOptions
): Promise<void> {
  let missing = false;
  try {
    const run = await world.runs
      .get(runId, { resolveData: 'none' })
      .catch((err: unknown) => {
        // Only a World with start Hooks can have a candidate with no run
        // to fence; anywhere else a missing run stays a plain not-found.
        if (
          !WorkflowRunNotFoundError.is(err) ||
          world.capabilities?.atomicStartHook?.active !== true
        ) {
          throw err;
        }
        missing = true;
        return undefined;
      });
    const specVersion = run
      ? specVersionForRunWrite(run.specVersion, SPEC_VERSION_LEGACY)
      : SPEC_VERSION_CURRENT;
    const compatMode = isLegacySpecVersion(specVersion);
    const eventRequest = {
      eventType: 'run_cancelled' as const,
      specVersion,
      ...(options?.cancelReason !== undefined
        ? { eventData: { cancelReason: options.cancelReason } }
        : {}),
    };
    await world.events.create(runId, eventRequest, {
      v1Compat: compatMode,
      ...(run && isSingleOrchestratorRun(run) ? { inBand: false } : {}),
    });
    if (run) {
      await wakeRunAfterOutOfBandWrite(world, run);
      await afterRunCancelled(world, run);
    }
  } catch (err) {
    // The World fenced a candidate that never became a run: cancelled.
    if (
      WorkflowWorldError.is(err) &&
      err.code === START_HOOK_CANDIDATE_CANCELLED
    ) {
      return;
    }
    if (missing && WorkflowRunNotFoundError.is(err)) throw err;
    throw new Error(
      `Failed to cancel run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Maximum number of single-run cancellations issued concurrently by the
 * fallback path (worlds without `runs.cancelMany`).
 */
const CANCEL_RUNS_FALLBACK_CONCURRENCY = 20;

/**
 * Cancel many runs in one call.
 *
 * Fast path: if the world implements `runs.cancelMany`, the whole batch is
 * delegated to it in a single operation (one backend round-trip on
 * `@workflow/world-vercel`).
 *
 * Fallback: for worlds without `cancelMany`, this issues single-run
 * `cancelRun()` calls with at most {@link CANCEL_RUNS_FALLBACK_CONCURRENCY}
 * in flight at a time. Fallback successes are reported as `cancelled`;
 * failures are reported as `failed` with `code: 'internal_error'` and
 * `retryable: true`, deliberately without per-world error classification.
 *
 * @throws if `runIds` is empty, contains duplicates, or exceeds
 *   {@link BULK_CANCEL_MAX_RUN_IDS}.
 */
export async function cancelRuns(
  world: World,
  runIds: string[],
  options?: CancelRunOptions
): Promise<BulkCancelWorkflowRunsResult> {
  if (runIds.length === 0) {
    throw new Error('cancelRuns requires at least one run ID.');
  }
  if (runIds.length > BULK_CANCEL_MAX_RUN_IDS) {
    throw new Error(
      `cancelRuns accepts at most ${BULK_CANCEL_MAX_RUN_IDS} run IDs (received ${runIds.length}).`
    );
  }
  if (new Set(runIds).size !== runIds.length) {
    throw new Error('cancelRuns requires unique run IDs (duplicates found).');
  }

  // Fast path: a single batch operation when the world supports it.
  if (world.runs.cancelMany) {
    const result = await world.runs.cancelMany({
      runIds,
      ...(options?.cancelReason !== undefined
        ? { cancelReason: options.cancelReason }
        : {}),
    });
    // The batch write cannot resume the completion hooks of parents waiting
    // on these runs, so do it per cancelled run here (`cancelRun` does the
    // same on the fallback path below).
    await forEachConcurrently(
      result.results.filter(({ outcome }) => outcome === 'cancelled'),
      ({ runId }) => afterRunCancelled(world, runId)
    );
    return result;
  }

  // Fallback: bounded-concurrency single-run cancellation.
  const results: BulkCancelWorkflowRunResult[] = new Array(runIds.length);
  await forEachConcurrently(runIds, async (runId, index) => {
    try {
      await cancelRun(world, runId, options);
      results[index] = { runId, outcome: 'cancelled' };
    } catch {
      results[index] = {
        runId,
        outcome: 'failed',
        code: 'internal_error',
        retryable: true,
      };
    }
  });

  const summary = {
    requested: runIds.length,
    cancelled: 0,
    alreadyCancelled: 0,
    notCancellable: 0,
    notFound: 0,
    failed: 0,
  };
  for (const result of results) {
    switch (result.outcome) {
      case 'cancelled':
        summary.cancelled++;
        break;
      case 'already_cancelled':
        summary.alreadyCancelled++;
        break;
      case 'not_cancellable':
        summary.notCancellable++;
        break;
      case 'not_found':
        summary.notFound++;
        break;
      case 'failed':
        summary.failed++;
        break;
    }
  }

  return { summary, results };
}

/**
 * Delete the stored data of many finished runs in one call: their inputs,
 * outputs and errors, their steps' and events' payloads, their hook payloads,
 * and their stream contents, as if each had been started with
 * `experimental_retention: 0`. The runs stay listed, with their payloads
 * reading back as expired. Deletion cannot be undone.
 *
 * Runs that have not finished are answered `skipped` and left untouched:
 * this never cancels a run. Cancel it first (see {@link cancelRuns}) to
 * delete its data. Every outcome is reported per run, in the order of
 * `runIds`.
 *
 * Retrying is safe, since deletion is idempotent. Inside a step, a `failed`
 * outcome with `retryable: true`, or the World rate-limiting the request,
 * throws a `RetryableError` (honouring the World's `retryAfter` when it gives
 * one), so the step retries the whole batch; runs already handled then
 * answer `already_deleted`. Outside a step, retryable failures are returned
 * for the caller to retry, and a rate limit throws the World's
 * `ThrottleError`.
 *
 * Delegates to the World's `runs.deleteDataMany`. There is no fallback: a
 * World that cannot delete run data would otherwise report success while
 * keeping the data.
 *
 * @throws if `runIds` is empty, contains duplicates, or exceeds
 *   {@link DELETE_RUNS_DATA_MAX_RUN_IDS}; if the configured World does not
 *   support deleting run data; or if the World does not answer exactly one
 *   result per run.
 */
export async function deleteRunsData(
  world: World,
  runIds: string[]
): Promise<DeleteRunsDataResult> {
  if (runIds.length === 0) {
    throw new FatalError('deleteRunsData requires at least one run ID.');
  }
  if (runIds.length > DELETE_RUNS_DATA_MAX_RUN_IDS) {
    throw new FatalError(
      `deleteRunsData accepts at most ${DELETE_RUNS_DATA_MAX_RUN_IDS} run IDs (received ${runIds.length}).`
    );
  }
  if (new Set(runIds).size !== runIds.length) {
    throw new FatalError(
      'deleteRunsData requires unique run IDs (duplicates found).'
    );
  }
  if (!world.runs.deleteDataMany) {
    // Fatal: inside a step, retrying cannot add the method.
    throw new FatalError(
      'The configured World does not support deleting run data.'
    );
  }

  const inStep = contextStorage.getStore() !== undefined;
  let response: DeleteRunsDataResult;
  try {
    response = await world.runs.deleteDataMany({ runIds });
  } catch (err) {
    if (inStep && ThrottleError.is(err)) {
      throw new RetryableError(
        `The World rate-limited deleting the data of ${describeRunIds(runIds)}.`,
        typeof err.retryAfter === 'number'
          ? { retryAfter: err.retryAfter * 1000 }
          : {}
      );
    }
    throw err;
  }

  // Exactly one result per requested run, in request order. Anything else
  // would leave a run's fate unknown, so it is not reported as success.
  const resultByRunId = new Map(
    response.results.map((result) => [result.runId, result])
  );
  if (
    resultByRunId.size !== response.results.length ||
    response.results.length !== runIds.length ||
    !runIds.every((runId) => resultByRunId.has(runId))
  ) {
    const unanswered = runIds.filter((runId) => !resultByRunId.has(runId));
    throw new Error(
      `The World did not answer the deletion of the data of ${describeRunIds(
        unanswered.length > 0 ? unanswered : runIds
      )} with exactly one result per run (requested ${runIds.length}, received ${response.results.length}).`
    );
  }
  const results = runIds.map(
    (runId) => resultByRunId.get(runId) as DeleteRunDataResult
  );

  if (inStep) {
    const retryable = results.filter(
      (result): result is Extract<DeleteRunDataResult, { outcome: 'failed' }> =>
        result.outcome === 'failed' && result.retryable
    );
    if (retryable.length > 0) {
      const codes = [...new Set(retryable.map((result) => result.code))];
      throw new RetryableError(
        `Deleting the data of ${describeRunIds(
          retryable.map((result) => result.runId)
        )} failed (${codes.join(', ')}) and will be retried.`
      );
    }
  }

  return { summary: response.summary, results };
}

/** `run wrun_a`, or `runs wrun_a, wrun_b and 3 more`, for error messages. */
function describeRunIds(runIds: string[]): string {
  const shown = runIds.slice(0, 3).join(', ');
  const more = runIds.length > 3 ? ` and ${runIds.length - 3} more` : '';
  return `${runIds.length === 1 ? 'run' : 'runs'} ${shown}${more}`;
}

/**
 * Runs `fn` over `items` with at most {@link CANCEL_RUNS_FALLBACK_CONCURRENCY}
 * calls in flight. `fn` must not reject.
 */
async function forEachConcurrently<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await fn(items[index]!, index);
    }
  };
  const workerCount = Math.min(CANCEL_RUNS_FALLBACK_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Re-enqueue a workflow run.
 */
export async function reenqueueRun(
  world: World,
  runId: string,
  options?: ReenqueueRunOptions
): Promise<void> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    await world.queue(
      getWorkflowQueueName(run.workflowName, options?.namespace),
      {
        runId,
        runSpecVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
      },
      {
        deploymentId: run.deploymentId,
        specVersion: specVersionForRunWrite(
          run.specVersion,
          SPEC_VERSION_LEGACY
        ),
      }
    );
  } catch (err) {
    throw new Error(
      `Failed to re-enqueue run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

// On `globalThis` (see `globalSingleton`): the waits a `wakeUpRun` in this
// process named and their orchestrator may not have completed yet, by run.
// Read by `@workflow/vitest`'s `waitForSleep`, which would otherwise hand
// back a sleep that is already being woken. Bounded: the oldest runs are
// forgotten first.
const MAX_TRACKED_WAKE_UP_RUNS = 1000;
const wakeUps = globalSingleton(
  '@workflow/core//pendingWakeUpWaits',
  1,
  () => ({ byRun: new Map<string, Set<string>>() })
);

/**
 * Waits of `runId` that a `run.wakeUp()` in this process asked its
 * orchestrator to complete. On a single-orchestrator run `wakeUp` returns
 * before the orchestrator writes their `wait_completed`; a caller looking for
 * the run's next pending sleep skips these.
 *
 * A wait stays here only once its wake message was published. It also stays
 * when a queue that coalesces the run's orchestrator messages merged that
 * message into a delivery that was already running, which drops its names
 * (see {@link wakeUpRun}): the wait then runs its full length while it is
 * listed here, and a caller skipping it misses a sleep that is still open.
 * world-local and world-postgres deliver the message after the running
 * delivery, so this does not happen there.
 */
export function pendingWakeUpWaits(runId: string): ReadonlySet<string> {
  return wakeUps.byRun.get(runId) ?? new Set();
}

/**
 * Lists `correlationIds` as being woken, before their wake is published so a
 * caller reading meanwhile already skips them. Returns the rollback for a
 * publish that failed: it forgets the ids this call added, and keeps any an
 * earlier wake listed.
 */
function rememberWakeUp(
  runId: string,
  correlationIds: readonly string[]
): () => void {
  const waits = wakeUps.byRun.get(runId) ?? new Set<string>();
  const added = correlationIds.filter((id) => !waits.has(id));
  for (const id of added) waits.add(id);
  wakeUps.byRun.delete(runId);
  wakeUps.byRun.set(runId, waits);
  while (wakeUps.byRun.size > MAX_TRACKED_WAKE_UP_RUNS) {
    const oldest = wakeUps.byRun.keys().next().value;
    if (oldest === undefined) break;
    wakeUps.byRun.delete(oldest);
  }
  return () => {
    const current = wakeUps.byRun.get(runId);
    if (!current) return;
    for (const id of added) current.delete(id);
    if (current.size === 0) wakeUps.byRun.delete(runId);
  };
}

/**
 * Wake up a workflow run by interrupting pending sleep() calls.
 *
 * On a single-orchestrator run (spec version 9 and later) the run's
 * orchestrator completes the waits: this names them on an ordinary
 * orchestrator message and returns once that message is enqueued, so their
 * `wait_completed` lands shortly after. That is best-effort: a queue that
 * coalesces the run's orchestrator messages into a delivery already running
 * (world-vercel) drops the names, and the waits then run their full length.
 * A delivery is running not only while it has work: after a pass with
 * nothing left to run it stays live while the run waits on an open hook or
 * a background step (`WORKFLOW_ORCHESTRATOR_LINGER_MS`, or
 * `WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS` for open hooks alone), so a wake sent just
 * after a run was active can be dropped too. `stoppedCount` then still
 * counts the waits it asked to complete.
 * A queue that holds the message until the running delivery ends (the Local
 * and Postgres Worlds) delivers it after that delivery. Older runs get
 * `wait_completed` written here.
 */
export async function wakeUpRun(
  world: World,
  runId: string,
  options?: StopSleepOptions
): Promise<StopSleepResult> {
  try {
    const run = await world.runs.get(runId, { resolveData: 'none' });
    const compatMode = isLegacySpecVersion(run.specVersion);

    // Paginate through all events to ensure we don't miss any sleeps.
    const allEvents: Event[] = [];
    let cursor: string | null = null;
    do {
      const eventsResult = await world.events.list({
        runId,
        pagination: { sortOrder: 'asc', ...(cursor ? { cursor } : {}) },
        resolveData: 'none',
        ...(run.specVersion !== undefined && {
          specVersion: run.specVersion,
        }),
      });
      allEvents.push(...eventsResult.data);
      cursor = eventsResult.hasMore ? eventsResult.cursor : null;
    } while (cursor);

    const waitCreatedEvents = allEvents.filter(
      (event: Event) => event.eventType === 'wait_created'
    );
    const waitCompletedCorrelationIds = new Set(
      allEvents
        .filter((event: Event) => event.eventType === 'wait_completed')
        .map((event: Event) => event.correlationId)
    );

    let pendingWaits = waitCreatedEvents.filter(
      (event: Event) => !waitCompletedCorrelationIds.has(event.correlationId)
    );

    if (options?.correlationIds && options.correlationIds.length > 0) {
      const targetCorrelationIds = new Set(options.correlationIds);
      pendingWaits = pendingWaits.filter(
        (event: Event) =>
          event.correlationId && targetCorrelationIds.has(event.correlationId)
      );
    }

    // A single-orchestrator run's waits are completed by its orchestrator
    // alone (in-band), so a wake-up names the waits on an orchestrator
    // message instead of writing `wait_completed` beside it. The names live
    // only on that message, and it is keyed like every orchestrator message:
    // coalesced into a delivery that is already running, which re-reads only
    // the log, the names are lost, including while that delivery lingers
    // after its last pass. `stoppedCount` counts the waits it asked to
    // complete, not completions.
    if ((run.specVersion ?? 0) >= SPEC_VERSION_SINGLE_ORCHESTRATOR) {
      const correlationIds = pendingWaits.flatMap((event) =>
        event.correlationId ? [event.correlationId] : []
      );
      if (correlationIds.length > 0) {
        const forget = rememberWakeUp(runId, correlationIds);
        try {
          await world.queue(
            getWorkflowQueueName(run.workflowName, options?.namespace),
            {
              runId,
              runSpecVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
              completeWaits: correlationIds,
            },
            {
              deploymentId: run.deploymentId,
              specVersion: specVersionForRunWrite(
                run.specVersion,
                SPEC_VERSION_LEGACY
              ),
            }
          );
        } catch (err) {
          // Nothing was published, or the outcome is unknown: either way a
          // later `waitForSleep` must still see the sleep as open. Waking it
          // again is harmless.
          forget();
          throw err;
        }
      }
      return { stoppedCount: correlationIds.length };
    }

    const errors: Error[] = [];
    let stoppedCount = 0;

    for (const waitEvent of pendingWaits) {
      if (!waitEvent.correlationId) continue;
      const eventData = compatMode
        ? {
            eventType: 'wait_completed' as const,
            correlationId: waitEvent.correlationId,
          }
        : {
            eventType: 'wait_completed' as const,
            correlationId: waitEvent.correlationId,
            specVersion: specVersionForRunWrite(run.specVersion),
            eventData: {
              resumeAt: waitEvent.eventData.resumeAt,
            },
          };
      try {
        await world.events.create(runId, eventData, {
          v1Compat: compatMode,
          inBand: false,
        });
        stoppedCount++;
      } catch (err) {
        if (EntityConflictError.is(err)) {
          stoppedCount++;
        } else {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    if (stoppedCount > 0) {
      await world.queue(
        getWorkflowQueueName(run.workflowName, options?.namespace),
        {
          runId,
          runSpecVersion: run.specVersion ?? SPEC_VERSION_LEGACY,
        },
        {
          deploymentId: run.deploymentId,
          specVersion: specVersionForRunWrite(
            run.specVersion,
            SPEC_VERSION_LEGACY
          ),
        }
      );
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to complete ${errors.length}/${pendingWaits.length} pending wait(s) for run ${runId}`
      );
    }

    return { stoppedCount };
  } catch (err) {
    if (err instanceof AggregateError) {
      throw err;
    }
    throw new Error(
      `Failed to wake up run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Read from a stream by stream ID.
 * Returns a ReadableStream of Uint8Array chunks.
 */
export async function readStream(
  world: World,
  runId: string,
  streamId: string,
  options?: ReadStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await world.streams.get(runId, streamId, options?.startIndex);
  } catch (err) {
    if (StreamError.is(err)) throw err;
    throw new StreamError(
      `Failed to read stream ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * List all stream IDs for a workflow run.
 */
export async function listStreams(
  world: World,
  runId: string
): Promise<string[]> {
  try {
    return await world.streams.list(runId);
  } catch (err) {
    if (StreamError.is(err)) throw err;
    throw new StreamError(
      `Failed to list streams for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
