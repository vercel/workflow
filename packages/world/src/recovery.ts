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
  if (reenqueued > 0) {
    console.log(
      `[${label}] Re-enqueued ${reenqueued} active run(s) on startup`
    );
  }
}
