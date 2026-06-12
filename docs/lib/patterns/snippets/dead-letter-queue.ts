/**
 * Source snippets for the Dead Letter Queue registry entry.
 *
 * Process a batch where individual failures must not abort the rest:
 * each item gets the runtime's normal step retries, and items that
 * exhaust them are recorded to a dead letter queue with full context —
 * then processing continues. A redrive workflow reprocesses the DLQ later.
 */

const DLQ_BODY = `import { start } from "workflow/api";

export interface QueueItem {
  id: string;
  payload: Record<string, unknown>;
}

// WORKFLOW — process every item; dead-letter the ones that exhaust their
// retries instead of failing the whole batch.
export async function processWithDeadLetters(items: QueueItem[]) {
  "use workflow";

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
  "use workflow";

  const items = await fetchDeadLetters(limit);
  if (items.length === 0) {
    return { redriven: 0 };
  }

  const run = await startRedriveBatch(items);
  return { redriven: items.length, runId: run };
}

// THE WORK — replace this step body with your real per-item processing.
// Throwing FatalError skips retries and dead-letters immediately.
async function processItem(item: QueueItem): Promise<void> {
  "use step";
  const res = await fetch("https://api.example.com/process", {
    method: "POST",
    body: JSON.stringify(item.payload),
  });
  if (!res.ok) {
    throw new Error(\`Processing failed for \${item.id}: \${res.status}\`);
  }
}

// THE DLQ — replace with your real sink: a database table, a queue, an
// incident channel. Keep it simple and reliable; this step is the safety
// net, so it should have no interesting failure modes of its own.
async function sendToDeadLetterQueue(
  item: QueueItem,
  error: unknown,
): Promise<void> {
  "use step";
  await fetch("https://api.example.com/dead-letters", {
    method: "POST",
    body: JSON.stringify({
      item,
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    }),
  });
}

async function fetchDeadLetters(limit: number): Promise<QueueItem[]> {
  "use step";
  const res = await fetch(\`https://api.example.com/dead-letters?limit=\${limit}\`);
  return (await res.json()) as QueueItem[];
}

async function startRedriveBatch(items: QueueItem[]): Promise<string> {
  "use step";
  const run = await start(processWithDeadLetters, [items]);
  return run.runId;
}
`;

export const deadLetterQueueWorkflowSource = DLQ_BODY;

export const deadLetterQueueWorkflowInstallSource = `/**
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
${DLQ_BODY}`;

export const deadLetterQueueStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import {
  processWithDeadLetters,
  redriveDeadLetters,
  type QueueItem,
} from "@/app/workflows/dead-letter-queue-workflow";

// POST /api/dead-letter-queue { items: QueueItem[] }      — process a batch
// POST /api/dead-letter-queue { redrive: true, limit? }   — reprocess DLQ
export async function POST(request: Request) {
  const body = await request.json();

  if (body.redrive) {
    const run = await start(redriveDeadLetters, [body.limit ?? 100]);
    return NextResponse.json({ runId: run.runId, mode: "redrive" });
  }

  const items = body.items as QueueItem[];
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "items must be a non-empty array" },
      { status: 400 },
    );
  }

  const run = await start(processWithDeadLetters, [items]);
  return NextResponse.json({ runId: run.runId, mode: "process" });
}
`;
