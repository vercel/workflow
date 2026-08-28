import type { Storage } from './interfaces.js';
import type { ValidQueueName } from './queue.js';
import {
  getQueueTopicPrefix,
  type Queue,
  resolveQueueNamespace,
} from './queue.js';

/**
 * Re-enqueue all active (pending/running) workflow runs so they resume
 * processing after a world restart. The workflow handler is idempotent
 * (event-log replay), so duplicate enqueues are safe.
 *
 * @param runs - Storage runs interface for listing active runs
 * @param enqueue - Queue's enqueue method
 * @param label - Log prefix for identifying the world implementation (e.g. "world-local")
 * @param namespace - Optional queue namespace. Defaults to WORKFLOW_QUEUE_NAMESPACE.
 */
export async function reenqueueActiveRuns(
  runs: Storage['runs'],
  enqueue: Queue['queue'],
  label: string,
  namespace?: string
): Promise<void> {
  const workflowQueuePrefix = getQueueTopicPrefix(
    'workflow',
    resolveQueueNamespace(namespace)
  );
  let reenqueued = 0;
  for (const status of ['pending', 'running'] as const) {
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await runs.list({
        status,
        resolveData: 'none',
        pagination: { cursor },
      });
      for (const run of page.data) {
        try {
          const queueName: ValidQueueName = `${workflowQueuePrefix}${run.workflowName}`;
          await enqueue(queueName, { runId: run.runId });
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
