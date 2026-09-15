import {
  classifyEntityEvent,
  type Event,
  TERMINAL_EVENT_CLASSES,
} from '@workflow/world';
import { DUPLICATE_EVENT_FIXTURES } from '@workflow/world/test-support/duplicate-event-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';

/**
 * The runtime's half of {@link DUPLICATE_EVENT_FIXTURES}. The observability
 * UI's half runs the same fixtures through its own classifier, so a fixture
 * whose expectation moves fails on both sides.
 *
 * What this drives is the walk in `EventsConsumer`: given consumers that claim
 * their entity's events for as long as the entity is open, which events does
 * it step over. The claim that the consumers behave that way is what
 * `duplicate-events.test.ts` checks, against the real step and sleep
 * primitives.
 */

/** No deliveries are modeled here, so the delivery gate is always open. */
const OPEN_GATE = {
  getPromiseQueue: () => Promise.resolve(),
  isDeliveryIdle: () => true,
};

/**
 * One callback standing in for every consumer a replay registers.
 *
 * `step.ts` keeps a step's consumer alive from `step_created` until the step's
 * outcome, claiming each attempt's `step_started` and `step_retrying` on the
 * way; `sleep.ts` does the same for a wait. Both delete the queue item on the
 * entity's terminal event, after which nothing claims that correlation id.
 * `attribute-dispatcher.ts` deregisters on the one event it matches, so an
 * attribute id closes on its own first event. `workflow.ts` declines a second
 * `run_started` outright, and claims the entity-less attribute events a step
 * body writes on the way past.
 */
function replayConsumers(): (event: Event | null) => EventConsumerResult {
  const claimed = new Set<string>();
  const closed = new Set<string>();

  return (event) => {
    if (event === null) return EventConsumerResult.NotConsumed;

    const classification = classifyEntityEvent(event);
    // Tracked under no class: a delivery, an event that precedes every replay,
    // or an attribute write from a step body. Their consumers take every copy.
    if (classification === undefined) return EventConsumerResult.Consumed;

    const { eventClass, entity } = classification;
    if (closed.has(entity)) return EventConsumerResult.NotConsumed;

    const classKey = `${eventClass}:${entity}`;
    if (eventClass === 'run_started' && claimed.has(classKey)) {
      return EventConsumerResult.NotConsumed;
    }

    claimed.add(classKey);
    if (TERMINAL_EVENT_CLASSES.has(eventClass)) closed.add(entity);
    return EventConsumerResult.Consumed;
  };
}

function buildLog(fixture: (typeof DUPLICATE_EVENT_FIXTURES)[number]): Event[] {
  return fixture.events.map(
    (spec, index) =>
      ({
        eventId: `evnt_${String(index).padStart(26, '0')}`,
        runId: 'wrun_test',
        eventType: spec.eventType,
        correlationId: spec.entity,
        eventData: {},
        createdAt: new Date(),
      }) as unknown as Event
  );
}

/**
 * Resolve once the walk has decided every event: it reached the end of the
 * log, or it stopped on one nothing can claim, which is the divergence the
 * skip exists to tell apart from a repeat.
 */
async function settle(
  consumer: EventsConsumer,
  length: number,
  onUnconsumedEvent: { mock: { calls: unknown[] } }
) {
  const deadline = Date.now() + 5000;
  while (
    consumer.eventIndex < length &&
    onUnconsumedEvent.mock.calls.length === 0 &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('shared duplicate-event fixtures', () => {
  for (const fixture of DUPLICATE_EVENT_FIXTURES) {
    it(`steps over the right events: ${fixture.name}`, async () => {
      const events = buildLog(fixture);
      const onDuplicateEvent = vi.fn();
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer(events, {
        ...OPEN_GATE,
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(replayConsumers());
      await settle(consumer, events.length, onUnconsumedEvent);

      expect(onDuplicateEvent.mock.calls.map(([event]) => event)).toEqual(
        fixture.ignoredIndices.map((index) => events[index])
      );
    });
  }
});
