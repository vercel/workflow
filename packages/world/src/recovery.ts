import type { Queue } from './queue.js';
import type { Storage } from './interfaces.js';
import type { ValidQueueName } from './queue.js';

/**
 * Re-enqueue all active (pending/running) workflow runs so they resume
 * processing after a world restart. The workflow handler is idempotent
 * (event-log replay), so duplicate enqueues are safe.
 *
 * @param runs - Storage runs interface for listing active runs
 * @param enqueue - Queue's enqueue method
 * @param label - Log prefix for identifying the world implementation (e.g. "world-local")
 */
export async function reenqueueActiveRuns(
  runs: Storage['runs'],
  enqueue: Queue['queue'],
  label: string
): Promise<void> {
  let reenqueued = 0;
  for (const status of ['pending', 'running'] as const) {
    let cursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const page = await runs.list({
        status,
        resolveData: 'none',
        // A larger page size keeps the number of list round-trips small.
        // This matters most for world-local, where each page pays a
        // directory scan: with the default page size of 20, recovering
        // over a large accumulated run history costs O(N²/20) work.
        pagination: { cursor, limit: 200 },
      });
      for (const run of page.data) {
        try {
          const queueName: ValidQueueName = `__wkf_workflow_${run.workflowName}`;
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
  if (reenqueued > 0) {
    console.log(
      `[${label}] Re-enqueued ${reenqueued} active run(s) on startup`
    );
  }
}
