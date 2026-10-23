import type { Storage } from './interfaces.js';
import type { ValidQueueName } from './queue.js';
import {
  getQueueTopicPrefix,
  getRunQueueNamespace,
  type Queue,
  resolveQueueNamespace,
} from './queue.js';

/**
 * Re-enqueue all active (pending/running) workflow runs so they resume
 * processing after a world restart. The workflow handler is idempotent
 * (event-log replay), so duplicate enqueues are safe.
 *
 * A run goes back to the queue namespace it recorded when it was created
 * (`executionContext.queueNamespace`, see `getRunQueueNamespace`), so a run
 * started under another namespace, or by a queue consumer other than the
 * Workflow SDK, reaches its own consumer rather than this process's. Runs that
 * recorded none use `namespace`.
 *
 * @param runs - Storage runs interface for listing active runs
 * @param enqueue - Queue's enqueue method
 * @param label - Log prefix for identifying the world implementation (e.g. "world-local")
 * @param namespace - Optional queue namespace. Defaults to WORKFLOW_QUEUE_NAMESPACE.
 * @param options.deploymentId - Recover only runs pinned to this deployment,
 *   for Worlds where each deployment's processes recover their own runs.
 */
export async function reenqueueActiveRuns(
  runs: Storage['runs'],
  enqueue: Queue['queue'],
  label: string,
  namespace?: string,
  options?: { deploymentId?: string }
): Promise<void> {
  const deploymentId = options?.deploymentId;
  const defaultNamespace = resolveQueueNamespace(namespace);
  // Validates the default up front, as before: a bad WORKFLOW_QUEUE_NAMESPACE
  // fails recovery once instead of once per run.
  getQueueTopicPrefix('workflow', defaultNamespace);
  let reenqueued = 0;
  let cursor: string | undefined;
  let hasMore = true;
  // Single paginated call over the non-terminal status set — the world's
  // `runs.list` accepts a status array (added in #3667) so we no longer need
  // to hardcode the loop over `['pending', 'running']` per status.
  while (hasMore) {
    const page = await runs.list({
      status: ['pending', 'running'],
      resolveData: 'none',
      pagination: { cursor },
    });
    for (const run of page.data) {
      if (deploymentId !== undefined && run.deploymentId !== deploymentId) {
        continue;
      }
      try {
        const prefix = getQueueTopicPrefix(
          'workflow',
          getRunQueueNamespace(run.executionContext) ?? defaultNamespace
        );
        const queueName: ValidQueueName = `${prefix}${run.workflowName}`;
        const payload = { runId: run.runId };
        await (deploymentId === undefined
          ? enqueue(queueName, payload)
          : enqueue(queueName, payload, { deploymentId }));
        reenqueued++;
      } catch (err) {
        console.warn(
          `[${label}] Failed to re-enqueue run ${run.runId}: ${err}`
        );
      }
    }
    hasMore = page.hasMore;
    cursor = page.cursor ?? undefined;
  }
  if (reenqueued > 0 && isDebugEnabled()) {
    // Debug-gated: recovering active runs is what a restart is supposed to do,
    // so on every `next dev` restart with work in flight this printed a line
    // about the world working correctly. The re-enqueue failures above stay
    // unconditional — those lose a run's resumption.
    console.debug(
      `[${label}] Re-enqueued ${reenqueued} active run(s) on startup`
    );
  }
}

/**
 * The `DEBUG` gate, inlined. This is `isWorkflowDebugEnabled()` from
 * `@workflow/utils`, hand-rolled for the same reason `env-config.ts` hand-rolls
 * `globalSingleton()`: this package deliberately carries no workspace
 * dependencies, and the two are equivalent.
 */
function isDebugEnabled(): boolean {
  const debug = typeof process !== 'undefined' ? process.env.DEBUG : undefined;
  if (typeof debug !== 'string') return false;
  return debug.includes('workflow:') || debug === '*';
}
