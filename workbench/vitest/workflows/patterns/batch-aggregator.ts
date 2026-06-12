/**
 * Batch Aggregator — buffer events, flush at N items or T elapsed.
 *
 * THE PATTERN (the inverse of fan-out batching):
 *   1. aggregatorSend(key, item) delivers items to a per-key coordination
 *      workflow, started lazily by the first item.
 *   2. The first item starts a flush-deadline timer (a tiny child workflow
 *      that sleeps and pings back — the coordinator never blocks).
 *   3. The buffer flushes when it reaches MAX_ITEMS, or when the deadline
 *      message arrives — whichever comes first. Then the run exits and the
 *      next item opens a fresh buffer.
 *
 * USEFUL WHEN:
 *   - Turning a stream of single events into efficient bulk operations
 *     (warehouse inserts, batch API calls, digest emails).
 *   - "Collect activity for 5 minutes, then send one summary."
 *   - Smoothing bursty producers in front of a slow consumer.
 *
 * CAVEATS / TO ADAPT:
 *   - Replace the flushBatch step body with your real batch operation, and
 *     tune MAX_ITEMS / MAX_WAIT_MS.
 *   - An item arriving in the same instant as a flush can land after the
 *     run exits — aggregatorSend then opens a fresh buffer, so items are
 *     never lost, but a flush slightly smaller than MAX_ITEMS is possible.
 *   - Items are buffered in workflow state: keep them reasonably small, or
 *     buffer IDs and hydrate in the flush step.
 *   - Need per-item payload + only-latest semantics instead? See Debounce.
 *
 * DOCS: https://workflow-sdk.dev/patterns/batch-aggregator
 */
import { defineHook, sleep } from 'workflow';
import { start } from 'workflow/api';

type AggregatorEvent<T = unknown> =
  | { type: 'item'; item: T; id?: string }
  | { type: 'timer'; timerId: number };

export const aggregatorEvents = defineHook<AggregatorEvent>();

function aggregatorToken(key: string) {
  return `aggregator:${key}`;
}

// Flush when the buffer reaches this many items…
const MAX_ITEMS = 100;
// …or this long after the FIRST item arrived, whichever comes first.
const MAX_WAIT_MS = 5 * 60 * 1000;

// COORDINATOR — one run per active buffer. Exits after flushing; the next
// item starts a fresh buffer.
export async function aggregatorCoordinator(key: string) {
  'use workflow';

  const events = aggregatorEvents.create({ token: aggregatorToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  const items: unknown[] = [];
  // Sends from retried steps are at-least-once — the same item can arrive
  // twice. Items that carry an id are deduped here.
  const seenIds = new Set<string>();
  let timerSeq = 0;

  for (;;) {
    const ev = await events;

    if (ev.type === 'item') {
      if (ev.id !== undefined) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
      }
      items.push(ev.item);

      if (items.length === 1) {
        // First item opens the window — start the flush deadline.
        timerSeq++;
        await spawnFlushTimer(key, MAX_WAIT_MS, timerSeq);
      }

      if (items.length >= MAX_ITEMS) {
        await flushBatch(key, items, 'size');
        return { key, flushed: items.length, reason: 'size' as const };
      }
    } else if (ev.timerId === timerSeq && items.length > 0) {
      await flushBatch(key, items, 'deadline');
      return { key, flushed: items.length, reason: 'deadline' as const };
    }
  }
}

// Deadline-as-a-message: a tiny child run sleeps, then pings the channel.
export async function aggregatorTimer(
  key: string,
  waitMs: number,
  timerId: number
) {
  'use workflow';
  await sleep(`${waitMs}ms`);
  try {
    await pingAggregator(key, timerId);
  } catch {
    // Buffer already flushed (size limit) and the run exited — fine.
  }
}

async function spawnFlushTimer(
  key: string,
  waitMs: number,
  timerId: number
): Promise<void> {
  'use step';
  await start(aggregatorTimer, [key, waitMs, timerId]);
}

async function pingAggregator(key: string, timerId: number): Promise<void> {
  'use step';
  await aggregatorEvents.resume(aggregatorToken(key), {
    type: 'timer',
    timerId,
  });
}

// THE FLUSH — replace this step body with your real batch operation:
// bulk-insert into a warehouse, send one digest email, call a batch API.
async function flushBatch(
  key: string,
  items: unknown[],
  reason: 'size' | 'deadline'
): Promise<void> {
  'use step';
  await fetch('https://api.example.com/batch', {
    method: 'POST',
    body: JSON.stringify({ key, reason, items }),
  });
}

/**
 * Add an item to the `key` buffer. The buffer flushes at MAX_ITEMS or
 * MAX_WAIT_MS after its first item — whichever comes first. Callable from
 * API routes, steps — anywhere server-side.
 *
 * Pass a stable `id` (e.g. the event ID, or stepId + index when sending
 * from a step) to dedupe at-least-once delivery: a step that crashes after
 * a successful send will resend on retry, and without an id the item
 * counts twice.
 */
export async function aggregatorSend(
  key: string,
  item: unknown,
  id?: string
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await aggregatorEvents.resume(aggregatorToken(key), {
        type: 'item',
        item,
        id,
      });
      return;
    } catch {
      // No active buffer for this key — start one and retry. A lost
      // double-start race is harmless: the loser run detects it via
      // getConflict() and returns { dedupedTo } cleanly.
    }
    try {
      await start(aggregatorCoordinator, [key]);
    } catch {
      // Another sender raced us to start it — retry the resume.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Could not deliver item to aggregator "${key}"`);
}
