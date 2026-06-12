/**
 * Dead Letter Queue — isolate poison items instead of failing the batch.
 *
 * THE PATTERN:
 *   1. Each item is processed in a step — the runtime retries transient
 *      failures automatically before the workflow ever sees an error.
 *   2. An item that exhausts its retries (or throws FatalError) is recorded
 *      to the DLQ with its payload + error, and the batch CONTINUES.
 *   3. A redrive workflow pulls dead letters and reprocesses them once the
 *      underlying issue is fixed — using the exact same batch workflow.
 *
 * USEFUL WHEN:
 *   - One malformed record must not block thousands of good ones.
 *   - You need an audit trail of what failed, with payloads, for replay.
 *   - Failures need human attention but processing must keep flowing.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace processItem with your real work; throw FatalError for
 *     permanent failures to skip retries and dead-letter immediately.
 *   - Replace sendToDeadLetterQueue / fetchDeadLetters with your real sink
 *     (a Postgres table is plenty). Keep the sink boring and reliable.
 *   - Track redrive attempts in the item payload and stop redriving after
 *     N failures to avoid infinite poison loops.
 *   - For very large batches, combine with the Batching pattern's chunking.
 *
 * DOCS: https://workflow-sdk.dev/patterns/dead-letter-queue
 */
import { FatalError } from 'workflow';
import { start } from 'workflow/api';

export interface QueueItem {
  id: string;
  payload: Record<string, unknown>;
}

// WORKFLOW — process every item; dead-letter the ones that exhaust their
// retries instead of failing the whole batch.
export async function processWithDeadLetters(items: QueueItem[]) {
  'use workflow';

  let succeeded = 0;
  let deadLettered = 0;

  for (const item of items) {
    try {
      // processItem is a step: transient failures are retried by the
      // runtime before the error ever reaches this catch.
      await processItem(item);
      succeeded++;
    } catch (error) {
      await sendToDeadLetterQueue(item, error);
      deadLettered++;
    }
  }

  return { total: items.length, succeeded, deadLettered };
}

// REDRIVE — pull dead letters and run them through a fresh batch. Trigger
// manually or on a schedule once the underlying issue is fixed.
export async function redriveDeadLetters(limit: number) {
  'use workflow';

  const items = await fetchDeadLetters(limit);
  if (items.length === 0) {
    return { redriven: 0 };
  }

  const run = await startRedriveBatch(items);
  return { redriven: items.length, runId: run };
}

// DEMO — pretend our processor has a bug that rejects items flagged with
// `payload.poison`. fixDemoBug() simulates deploying a fix, after which a
// redrive of the dead letters succeeds.
let demoBugFixed = false;

export async function fixDemoBug(): Promise<void> {
  'use step';
  demoBugFixed = true;
}

// THE WORK — replace this step body with your real per-item processing.
// Throwing FatalError skips retries and dead-letters immediately.
async function processItem(item: QueueItem): Promise<void> {
  'use step';
  // A real implementation looks like:
  //   const res = await fetch("https://api.your-service.com/process", {
  //     method: "POST",
  //     body: JSON.stringify(item.payload),
  //   });
  //   if (!res.ok) throw new Error(`Processing failed for ${item.id}: ${res.status}`);

  if (item.payload.poison && !demoBugFixed) {
    throw new FatalError(`Cannot process ${item.id}: malformed payload`);
  }
}

// THE DLQ SINK — an in-memory array for the demo. Replace with your real
// sink: a database table, a queue, an incident channel. Keep it simple and
// reliable; this step is the safety net, so it should have no interesting
// failure modes of its own. (Exported so you can inspect it from a console
// or test.)
export const deadLetterSink: Array<{
  item: QueueItem;
  error: string;
  failedAt: string;
}> = [];

async function sendToDeadLetterQueue(
  item: QueueItem,
  error: unknown
): Promise<void> {
  'use step';
  deadLetterSink.push({
    item,
    error: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  });
}

// Drains up to `limit` dead letters from the sink for redriving.
async function fetchDeadLetters(limit: number): Promise<QueueItem[]> {
  'use step';
  return deadLetterSink.splice(0, limit).map((d) => d.item);
}

async function startRedriveBatch(items: QueueItem[]): Promise<string> {
  'use step';
  const run = await start(processWithDeadLetters, [items]);
  return run.runId;
}
