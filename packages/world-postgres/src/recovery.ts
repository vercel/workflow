import type { Queue, Storage, ValidQueueName } from '@workflow/world';
import { getQueueTopicPrefix, resolveQueueNamespace } from '@workflow/world';
import { and, eq, inArray } from 'drizzle-orm';
import type { Drizzle } from './drizzle/index.js';
import * as Schema from './drizzle/schema.js';

/**
 * Prefix for the idempotency key attached to startup-recovery enqueues.
 *
 * The Postgres queue uses the idempotency key as the graphile-worker
 * `job_key` (see `queue.ts`), and graphile-worker's default `replace`
 * job-key mode updates the existing pending job instead of inserting a
 * new one. Deriving the key from the run ID therefore guarantees at most
 * one outstanding startup-recovery job per run, no matter how many times
 * the process restarts before the job is consumed. Once the job completes
 * the key is released, so later legitimate wake-ups are never suppressed.
 */
export const STARTUP_RECOVERY_IDEMPOTENCY_PREFIX = 'startup-recovery:';

export function startupRecoveryIdempotencyKey(runId: string): string {
  return `${STARTUP_RECOVERY_IDEMPOTENCY_PREFIX}${runId}`;
}

/** Step statuses that represent interrupted, still-runnable work. */
const RUNNABLE_STEP_STATUSES = ['pending', 'running'] as const;

/**
 * Classify a page of `running` runs into runnable vs. durably parked using
 * only persisted state.
 *
 * A run counts as runnable (i.e. worth replaying on startup) when:
 * - it has a step in a non-terminal state (interrupted step work), or
 * - it has a `waiting` wait whose `resumeAt` is already due, or
 * - it has no persisted suspension state at all (no open hooks, no waiting
 *   waits, no runnable steps). Such a run crashed between making progress
 *   and suspending, so it must be replayed to continue; we fail open for
 *   this ambiguous case because the enqueue is deduplicated.
 *
 * A run counts as parked (skipped) when its only live state is open hooks
 * and/or waits that are not yet due: hook deliveries and due timers enqueue
 * their own wake-up jobs, and those jobs live durably in the same Postgres
 * database as this queue, so they survive restarts and do not need to be
 * recreated on boot.
 */
async function classifyRunnableRuns(
  drizzle: Drizzle,
  runIds: string[],
  now: Date
): Promise<Set<string>> {
  const [stepRows, waitRows, hookRows] = await Promise.all([
    drizzle
      .select({ runId: Schema.steps.runId })
      .from(Schema.steps)
      .where(
        and(
          inArray(Schema.steps.runId, runIds),
          inArray(Schema.steps.status, [...RUNNABLE_STEP_STATUSES])
        )
      ),
    drizzle
      .select({ runId: Schema.waits.runId, resumeAt: Schema.waits.resumeAt })
      .from(Schema.waits)
      .where(
        and(
          inArray(Schema.waits.runId, runIds),
          eq(Schema.waits.status, 'waiting')
        )
      ),
    drizzle
      .select({ runId: Schema.hooks.runId })
      .from(Schema.hooks)
      .where(inArray(Schema.hooks.runId, runIds)),
  ]);

  const runnableStepRunIds = new Set(stepRows.map((row) => row.runId));
  const waitingRunIds = new Set(waitRows.map((row) => row.runId));
  const dueWaitRunIds = new Set(
    waitRows
      .filter(
        (row) => row.resumeAt != null && row.resumeAt.getTime() <= now.getTime()
      )
      .map((row) => row.runId)
  );
  const openHookRunIds = new Set(hookRows.map((row) => row.runId));

  const runnable = new Set<string>();
  for (const runId of runIds) {
    if (runnableStepRunIds.has(runId) || dueWaitRunIds.has(runId)) {
      runnable.add(runId);
      continue;
    }
    if (openHookRunIds.has(runId) || waitingRunIds.has(runId)) {
      // Durably parked: only live state is an unresolved hook and/or a wait
      // that is not due yet. Replaying it on boot would be pure overhead.
      continue;
    }
    // No persisted suspension state — cannot be classified as parked, so
    // fail open and recover it. The stable idempotency key keeps this from
    // accumulating jobs across restarts.
    runnable.add(runId);
  }
  return runnable;
}

type RecoverableRun = { runId: string; workflowName: string };

/**
 * Classify a page of runs with fail-open semantics: pending runs are always
 * runnable, and if the persisted-state queries fail the whole page is
 * treated as runnable (the stable idempotency key still prevents duplicate
 * job accumulation across restarts).
 */
async function classifyPageSafe(
  drizzle: Drizzle,
  status: 'pending' | 'running',
  runIds: string[],
  label: string
): Promise<Set<string> | null> {
  if (status !== 'running' || runIds.length === 0) {
    return null;
  }
  try {
    return await classifyRunnableRuns(drizzle, runIds, new Date());
  } catch (err) {
    console.warn(
      `[${label}] Failed to classify parked runs during startup recovery, ` +
        `re-enqueueing all active runs in page: ${err}`
    );
    return null;
  }
}

/**
 * Enqueue one startup-recovery job for a run, keyed by the run ID so
 * repeated restarts replace the outstanding job instead of adding another.
 * Returns whether the enqueue succeeded.
 */
async function enqueueRecoveryJob(
  enqueue: Queue['queue'],
  workflowQueuePrefix: string,
  run: RecoverableRun,
  label: string
): Promise<boolean> {
  try {
    const queueName: ValidQueueName =
      `${workflowQueuePrefix}${run.workflowName}` as ValidQueueName;
    await enqueue(
      queueName,
      { runId: run.runId },
      { idempotencyKey: startupRecoveryIdempotencyKey(run.runId) }
    );
    return true;
  } catch (err) {
    console.warn(`[${label}] Failed to re-enqueue run ${run.runId}: ${err}`);
    return false;
  }
}

/**
 * Re-enqueue persisted runnable workflow runs so they resume processing
 * after a world restart.
 *
 * Unlike the generic `reenqueueActiveRuns` helper in `@workflow/world`,
 * this Postgres-specific variant:
 * - skips runs that are durably parked on unresolved hooks or future waits
 *   (their wake-up jobs are persisted in the same database and survive the
 *   restart), and
 * - attaches a stable per-run idempotency key so repeated restarts replace
 *   the outstanding recovery job instead of accumulating duplicates.
 *
 * See https://github.com/vercel/workflow/issues/3119.
 *
 * @param runs - Storage runs interface for listing active runs
 * @param drizzle - Drizzle client for querying persisted suspension state
 * @param enqueue - Queue's enqueue method
 * @param label - Log prefix identifying the world implementation
 * @param namespace - Optional queue namespace. Defaults to WORKFLOW_QUEUE_NAMESPACE.
 */
/**
 * Recover one page of active runs: skip the durably parked ones and
 * enqueue the rest with the stable per-run recovery key.
 */
async function recoverPage(
  ctx: {
    drizzle: Drizzle;
    enqueue: Queue['queue'];
    workflowQueuePrefix: string;
    label: string;
  },
  status: 'pending' | 'running',
  pageRuns: RecoverableRun[]
): Promise<{ reenqueued: number; skippedParked: number }> {
  // Pending runs have not started yet and are always runnable. Running
  // runs are filtered down to the ones with persisted runnable work.
  const runnableRunIds = await classifyPageSafe(
    ctx.drizzle,
    status,
    pageRuns.map((run) => run.runId),
    ctx.label
  );

  let reenqueued = 0;
  let skippedParked = 0;
  for (const run of pageRuns) {
    if (runnableRunIds && !runnableRunIds.has(run.runId)) {
      skippedParked++;
      continue;
    }
    if (
      await enqueueRecoveryJob(
        ctx.enqueue,
        ctx.workflowQueuePrefix,
        run,
        ctx.label
      )
    ) {
      reenqueued++;
    }
  }
  return { reenqueued, skippedParked };
}

export async function reenqueueRecoverableRuns({
  runs,
  drizzle,
  enqueue,
  label,
  namespace,
}: {
  runs: Storage['runs'];
  drizzle: Drizzle;
  enqueue: Queue['queue'];
  label: string;
  namespace?: string;
}): Promise<void> {
  const workflowQueuePrefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(namespace)
  );
  const ctx = { drizzle, enqueue, workflowQueuePrefix, label };
  let reenqueued = 0;
  let skippedParked = 0;
  for (const status of ['pending', 'running'] as const) {
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await runs.list({
        status,
        resolveData: 'none',
        pagination: { cursor },
      });
      const counts = await recoverPage(ctx, status, page.data);
      reenqueued += counts.reenqueued;
      skippedParked += counts.skippedParked;
      hasMore = page.hasMore;
      cursor = page.cursor ?? undefined;
    }
  }
  if (reenqueued > 0 || skippedParked > 0) {
    console.log(
      `[${label}] Re-enqueued ${reenqueued} active run(s) on startup` +
        (skippedParked > 0
          ? ` (skipped ${skippedParked} durably parked run(s))`
          : '')
    );
  }
}
