/**
 * Batch Aggregator — buffer events, flush at N items or T elapsed.
 *
 * THE PATTERN (the inverse of fan-out batching):
 *   1. aggregatorSend(key, item) delivers items to a per-key coordination
 *      workflow, started lazily by the first item.
 *   2. The first item starts a flush-deadline timer (a tiny child workflow
 *      that sleeps and pings back — the coordinator never blocks).
 *   3. The buffer flushes when it reaches MAX_ITEMS, or when the deadline
 *      message arrives — whichever comes first. The coordinator then keeps
 *      looping on the same buffer, and only exits once a whole window
 *      passes with nothing in it.
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
 *   - Flushing deliberately does NOT end the run. A flush is a real network
 *     call, and it happens exactly when the buffer is filling fastest — if
 *     the run returned there, every item delivered during the flush would
 *     resume a hook nobody reads again. Looping instead means those items
 *     are picked up on the next iteration.
 *   - The run does still have to end sometime, and it ends on an idle
 *     window. An item racing that exit almost always fails its resume, and
 *     aggregatorSend opens a fresh buffer and retries — no loss. Closing
 *     that last sliver needs an ack from the coordinator, not just a
 *     successful resume; add one if a dropped item is unacceptable.
 *   - Items are buffered in workflow state: keep them reasonably small, or
 *     buffer IDs and hydrate in the flush step.
 *   - Need per-item payload + only-latest semantics instead? See Debounce.
 *
 * DOCS: https://workflow-sdk.dev/patterns/batch-aggregator
 */
import { defineHook, getStepMetadata, sleep } from 'workflow';
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

// COORDINATOR — one run per active buffer. Flushes as often as it needs to
// and exits once a whole window goes by empty; the next item after that
// starts a fresh buffer.
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

  let items: unknown[] = [];
  // Sends from retried steps are at-least-once — the same item can arrive
  // twice. Items that carry an id are deduped here.
  const seenIds = new Set<string>();
  let timerSeq = 0;
  let flushed = 0;

  for (;;) {
    const ev = await events;

    if (ev.type === 'item') {
      if (ev.id !== undefined) {
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
      }
      items.push(ev.item);

      if (items.length === 1) {
        // First item of a window — start its flush deadline. The bump also
        // retires whatever timer was left over from the previous window, so
        // exactly one deadline is ever live.
        timerSeq++;
        await spawnFlushTimer(key, MAX_WAIT_MS, timerSeq);
      }

      if (items.length >= MAX_ITEMS) {
        flushed += items.length;
        await flushBatch(key, items, 'size');
        items = [];
        // No re-arm: this window's timer is still pending and now serves as
        // the idle deadline. The next item supersedes it (above).
      }
    } else if (ev.timerId === timerSeq) {
      if (items.length === 0) {
        // A whole window with nothing in it — wind the run down. The next
        // aggregatorSend finds no owner and opens a fresh buffer.
        return { key, flushed, reason: 'idle' as const };
      }
      flushed += items.length;
      await flushBatch(key, items, 'deadline');
      items = [];
      // This timer just fired, so nothing is pending — arm the idle
      // deadline that will eventually end the run.
      timerSeq++;
      await spawnFlushTimer(key, MAX_WAIT_MS, timerSeq);
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
    // The coordinator already wound down on an earlier idle window — fine.
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
// For example:
//
//   await fetch('https://api.example.com/batch', {
//     method: 'POST',
//     body: JSON.stringify({ key, reason, items }),
//   });
//
// This demo records flushes in memory so the pattern runs out of the box.
// Step execution is at-least-once, so the demo dedupes by stepId — your
// real flush should be idempotent too.
const demoFlushes: Array<{
  key: string;
  reason: 'size' | 'deadline';
  items: unknown[];
}> = [];
const flushedSteps = new Set<string>();

async function flushBatch(
  key: string,
  items: unknown[],
  reason: 'size' | 'deadline'
): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (flushedSteps.has(stepId)) return;
  flushedSteps.add(stepId);
  demoFlushes.push({ key, reason, items: [...items] });
  console.log(
    `[aggregator] flushed ${items.length} item(s) for "${key}" (${reason})`
  );
}

/** Read the demo flushes for `key`. Goes away with the demo step body. */
export function readFlushes(
  key: string
): Array<{ key: string; reason: 'size' | 'deadline'; items: unknown[] }> {
  return demoFlushes.filter((f) => f.key === key);
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
