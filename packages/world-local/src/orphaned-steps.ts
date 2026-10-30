import { EntityConflictError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import {
  type Event,
  isStepEventType,
  isTerminalWorkflowRunStatus,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_MAX_SUPPORTED,
  type Storage,
} from '@workflow/world';

export const ORPHANED_STEP_ERROR_MESSAGE =
  'The process running this step exited before it finished.';

/**
 * When world-local first loaded in this JavaScript realm (process or worker
 * thread). Any step this realm starts is stamped after it, so a stamp at or
 * after it may belong to a live owner here and is never released.
 *
 * On `globalThis` (see `globalSingleton`) so every module copy in the realm
 * shares the earliest load time. `performance.timeOrigin` is not used because
 * Node shares it across a process's worker threads, so it can't mark a reload
 * into a new worker.
 */
export const realmBoot = globalSingleton(
  '@workflow/world-local//realmBoot',
  1,
  () => ({ bootedAt: Date.now() })
);

/**
 * Hand every step still inline-owned by a queue message of a previous process
 * back to the queue, by writing `step_retrying` for it.
 *
 * A step that runs inline records its queue message on `step_started`
 * (`ownerMessageId`), and until a lease expires, core defers to that owner
 * instead of dispatching the step again (vercel/workflow#2780). The local
 * queue is in memory, so after a restart no owner from the previous process
 * can still be alive or be redelivered, and recovery would wait out the whole
 * lease (vercel/workflow#4939). Core treats `step_retrying` as the permanent
 * end of inline ownership, so the replay dispatches the step at once.
 *
 * A step is released only when core would still honor its stamp: it is
 * `running`, its latest `step_started` carries an owner, and it has no
 * `step_retrying` or terminal event. Queue-owned and finished steps are left
 * alone, and so is any step started since this realm booted
 * ({@link realmBoot}), whose owner may be a live delivery in this realm. A run
 * that has already finished is left alone too: world-local accepts
 * `step_retrying` regardless of the run's status, so releasing would turn a
 * step of a finished run back to `pending`.
 *
 * A stamp from before this realm booted is treated as dead, so this must only
 * run while no other live process or worker thread runs workflows on the same
 * data directory and tag. Releasing a step that is still running there would
 * let the step run twice: core's in-process duplicate guard (step single-flight)
 * is per realm too, so an older worker thread of this process is as foreign as
 * another process.
 */
export async function releaseOrphanedSteps(
  storage: Pick<Storage, 'events' | 'runs' | 'steps'>,
  runId: string
): Promise<void> {
  const running = await listRunningStepIds(storage.steps, runId);
  // Every releasable step is `running`, so most runs need no event scan.
  if (running.size === 0) return;
  const run = await storage.runs.get(runId, { resolveData: 'none' });
  if (isTerminalWorkflowRunStatus(run.status)) return;
  for (const [stepId, step] of await readStepOwnership(storage.events, runId)) {
    if (!running.has(stepId) || !isOrphaned(step)) continue;
    try {
      await storage.events.create(runId, {
        eventType: 'step_retrying',
        // The run's own version, so a reader of an older run never meets an
        // event stamped above what it supports.
        specVersion: Math.min(
          run.specVersion ?? SPEC_VERSION_CURRENT,
          SPEC_VERSION_MAX_SUPPORTED
        ),
        correlationId: stepId,
        eventData: {
          ...(step.stepName !== undefined && { stepName: step.stepName }),
          error: orphanedStepError(),
        },
      });
    } catch (err) {
      // The step finished between the read and this write: nothing to release.
      if (!EntityConflictError.is(err)) throw err;
    }
  }
}

/** How many runs startup recovery releases at once. */
export const RELEASE_CONCURRENCY = 8;

/**
 * Releases runs' orphaned steps for startup recovery, several runs at a time,
 * while runs are still re-enqueued one by one and each only after its own
 * release. `prefetch` starts releasing a page of runs in the background as
 * soon as it is listed; `settle` waits for one run's release before that run
 * is enqueued, releasing it there if it was not prefetched.
 *
 * A failed release is logged and otherwise ignored: the run is still
 * recoverable, just only once the lease expires. So neither method rejects.
 */
export function createReleasePipeline(
  storage: Pick<Storage, 'events' | 'runs' | 'steps'>,
  concurrency = RELEASE_CONCURRENCY
) {
  const limit = createLimiter(concurrency);
  const releases = new Map<string, Promise<void>>();
  const release = async (runId: string) => {
    try {
      await releaseOrphanedSteps(storage, runId);
    } catch (err) {
      console.warn(
        `[world-local] Failed to release orphaned steps of run ${runId}: ${err}`
      );
    }
  };
  return {
    prefetch(runIds: Iterable<string>): void {
      for (const runId of runIds) {
        if (!releases.has(runId)) {
          releases.set(
            runId,
            limit(() => release(runId))
          );
        }
      }
    },
    async settle(runId: string): Promise<void> {
      const pending = releases.get(runId);
      releases.delete(runId);
      await (pending ?? release(runId));
    },
  };
}

/** Run at most `max` of the given tasks at a time, in call order. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active++;
    } else {
      // A finishing task hands its slot straight to this one.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

interface StepOwnership {
  /** `ownerMessageId` of the latest `step_started`. */
  owner?: string;
  /** When the latest `step_started` was written, in epoch milliseconds. */
  startedAt?: number;
  stepName?: string;
  retried: boolean;
  finished: boolean;
}

function isOrphaned(step: StepOwnership): boolean {
  return (
    step.owner !== undefined &&
    !step.retried &&
    !step.finished &&
    step.startedAt !== undefined &&
    step.startedAt < realmBoot.bootedAt
  );
}

async function listRunningStepIds(
  steps: Storage['steps'],
  runId: string
): Promise<Set<string>> {
  const running = new Set<string>();
  let cursor: string | undefined;
  do {
    // The largest page: each page re-reads the run's step files, so the
    // default of 20 would make a long run quadratic.
    const page = await steps.list({
      runId,
      resolveData: 'none',
      pagination: { cursor, limit: 1000 },
    });
    for (const step of page.data) {
      if (step.status === 'running') running.add(step.stepId);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return running;
}

async function readStepOwnership(
  events: Storage['events'],
  runId: string
): Promise<Map<string, StepOwnership>> {
  const steps = new Map<string, StepOwnership>();
  let cursor: string | undefined;
  do {
    const page = await events.list({
      runId,
      resolveData: 'none',
      pagination: { sortOrder: 'asc', cursor },
    });
    for (const event of page.data) {
      if (event.correlationId && isStepEventType(event.eventType)) {
        let step = steps.get(event.correlationId);
        if (!step) {
          step = { retried: false, finished: false };
          steps.set(event.correlationId, step);
        }
        applyStepEvent(step, event);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return steps;
}

function applyStepEvent(step: StepOwnership, event: Event): void {
  const data = ('eventData' in event ? event.eventData : undefined) as
    | { stepName?: unknown; ownerMessageId?: unknown }
    | undefined;
  if (typeof data?.stepName === 'string') step.stepName ??= data.stepName;
  switch (event.eventType) {
    case 'step_started':
      // The latest start wins: an unstamped one leaves the step queue-owned.
      step.owner =
        typeof data?.ownerMessageId === 'string'
          ? data.ownerMessageId
          : undefined;
      step.startedAt = new Date(event.createdAt).getTime();
      break;
    case 'step_retrying':
      step.retried = true;
      break;
    case 'step_completed':
    case 'step_failed':
      step.finished = true;
      break;
  }
}

/**
 * The error recorded on the released attempt, in the format core's
 * `dehydrateStepError` writes for an uncompressed thrown `Error`: the `devl`
 * prefix followed by devalue's encoding of the error's reduced form. It is
 * written unencrypted even when the run has a key: hydration passes bytes that
 * carry no encryption prefix through regardless of the key, and the payload is
 * a fixed message with nothing sensitive in it.
 */
function orphanedStepError(): Uint8Array {
  const devalue = JSON.stringify([
    ['Error', 1],
    { name: 2, message: 3 },
    'Error',
    ORPHANED_STEP_ERROR_MESSAGE,
  ]);
  return new TextEncoder().encode(`devl${devalue}`);
}
