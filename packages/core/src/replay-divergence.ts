import type { Event } from '@workflow/world';
import type { EventsConsumer } from './events-consumer.js';
import type { QueueItem } from './global.js';

/**
 * Step, wait, hook and attribute correlation ids share one ULID draw per
 * entity, prefixed by kind (`step_<ulid>`, `wait_<ulid>`, `hook_<ulid>`,
 * `attr_<ulid>`). A replay that drew the same ordinal for a different kind of
 * entity than the one the log recorded there produces an event nobody can
 * consume, and the decisive fact for diagnosing that is which pending
 * invocation currently holds the ordinal. This looks it up by the shared ULID
 * body, so a `wait_created` the log holds at a position where the replay is
 * waiting on `step_<same ulid>` names that step.
 */
export function findPendingItemAtOrdinal(
  invocationsQueue: Map<string, QueueItem>,
  correlationId: string
): QueueItem | undefined {
  const exact = invocationsQueue.get(correlationId);
  if (exact) return exact;
  const body = ordinalBody(correlationId);
  if (!body) return undefined;
  for (const [id, item] of invocationsQueue) {
    if (ordinalBody(id) === body) return item;
  }
  return undefined;
}

function ordinalBody(correlationId: string): string | undefined {
  const at = correlationId.indexOf('_');
  return at === -1 ? undefined : correlationId.slice(at + 1);
}

function describeQueueItem(item: QueueItem): string {
  switch (item.type) {
    case 'step':
      return `step ${item.stepName} (${item.correlationId})`;
    case 'hook':
      return `hook (${item.correlationId})`;
    case 'wait':
      return `wait (${item.correlationId})`;
    case 'attribute':
      return `attribute (${item.correlationId})`;
  }
  item satisfies never;
  return 'unknown';
}

/**
 * The detail appended to a `ReplayDivergenceError` raised because the replay
 * could not place an event. Callers keep their own leading sentence (tests and
 * users match on it) and append this after it.
 *
 * Example:
 * `pending at this id: step drainStep (step_01K…). consumer: index=41,
 * length=44, parked=0, lastConsumed=evnt_01K…`
 */
export function describeDivergenceContext(
  event: Event,
  invocationsQueue: Map<string, QueueItem>,
  eventsConsumer: EventsConsumer
): string {
  const pending = event.correlationId
    ? findPendingItemAtOrdinal(invocationsQueue, event.correlationId)
    : undefined;
  const snapshot = eventsConsumer.describe();
  return [
    `pending at this id: ${pending ? describeQueueItem(pending) : 'none'}.`,
    `consumer: index=${snapshot.index}, length=${snapshot.length}, parked=${snapshot.parked}, lastConsumed=${snapshot.lastConsumedEventId ?? 'none'}`,
  ].join(' ');
}
