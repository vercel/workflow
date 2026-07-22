import type { Storage } from './interfaces.js';
import type { ValidQueueName } from './queue.js';
import {
  getQueueTopicPrefix,
  type Queue,
  resolveQueueNamespace,
} from './queue.js';
import { isLegacySpecVersion, SPEC_VERSION_LEGACY } from './spec-version.js';

/**
 * Reason recorded on runs cancelled by boot-time recovery in development.
 * Surfaced on the `run_cancelled` event so it's visible in the event log / UI.
 */
export const DEV_RESTART_CANCEL_REASON =
  'Cancelled on dev server restart: in-flight runs are not resumed in development because the workflow code may have changed since they started. Use a production build to recover runs.';

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
  if (reenqueued > 0) {
    console.log(
      `[${label}] Re-enqueued ${reenqueued} active run(s) on startup`
    );
  }
}

/**
 * Cancel all active (pending/running) workflow runs by writing a terminal
 * `run_cancelled` event (carrying `eventData.cancelReason`) for each. Used as the development
 * boot-time behavior: rather than re-enqueuing runs from a previous dev session
 * — whose workflow code has likely changed, so replay would diverge — they are
 * cancelled with an explanatory reason.
 *
 * Idempotent: writing `run_cancelled` for a run that already reached a terminal
 * state is rejected by the storage layer's terminal-state guards, so concurrent
 * or repeated cancels converge.
 *
 * @param runs - Storage runs interface for listing active runs
 * @param events - Storage events interface for writing the cancellation event
 * @param label - Log prefix identifying the world implementation (e.g. "world-local")
 * @param reason - Human-readable cancellation reason recorded on the event
 */
export async function cancelActiveRuns(
  runs: Storage['runs'],
  events: Storage['events'],
  label: string,
  reason: string = DEV_RESTART_CANCEL_REASON
): Promise<void> {
  let cancelled = 0;
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
          const specVersion = run.specVersion ?? SPEC_VERSION_LEGACY;
          await events.create(
            run.runId,
            {
              eventType: 'run_cancelled',
              specVersion,
              eventData: { cancelReason: reason },
            },
            { v1Compat: isLegacySpecVersion(specVersion) }
          );
          cancelled++;
        } catch (err) {
          console.warn(`[${label}] Failed to cancel run ${run.runId}: ${err}`);
        }
      }
      hasMore = page.hasMore;
      cursor = page.cursor ?? undefined;
    }
  }
  if (cancelled > 0) {
    console.log(
      `[${label}] Dev mode: cancelled ${cancelled} in-flight run(s) from a previous ` +
        'session (workflow code may have changed; runs resume only in production builds).'
    );
  }
}
