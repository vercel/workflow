import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { isDeliveryIdle } from './private.js';

/**
 * The events consumer walks the log synchronously; the resolutions that walk
 * triggers do not resolve synchronously. A step result hydrates in the host
 * and only then does VM code run far enough to `subscribe()` the consumer for
 * the next event. So the walk routinely sits on an ordered event
 * (`step_created`, `wait_created`) that nobody has claimed yet while the
 * workflow is mid-flight on its way to claiming it.
 *
 * The unconsumed-event check used to resolve that by waiting a fixed
 * `DEFERRED_CHECK_DELAY_MS` after the promise queue drained, which is a bet
 * that every delivery lands inside the window. Replaying a batch of N parallel
 * step results loses it: the queue drains with deliveries still in flight, and
 * the check declares `ReplayDivergenceError` against a log the very same
 * replay goes on to reproduce exactly.
 *
 * These tests pin the guard on the divergence path, using the production
 * predicate rather than a mock: a delivery still in flight must hold the check
 * off however long it takes, and the check must still fire for an event no
 * delivery is waiting on.
 */

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    workflow_run_id: 'run-1',
    event_type: 'step_created',
    event_data: {},
    sequence_number: 1,
    created_at: new Date(),
    ...overrides,
  } as unknown as Event;
}

/**
 * The slice of the orchestrator context that `isDeliveryIdle` reads.
 * Everything else a replay carries is irrelevant to whether a delivery is in
 * flight.
 */
function createDeliveryContext(): WorkflowOrchestratorContext {
  const promiseQueueHolder = { current: Promise.resolve() };
  return {
    pendingDeliveries: 0,
    pendingDeliveryBarriers: new Map(),
    get promiseQueue() {
      return promiseQueueHolder.current;
    },
    set promiseQueue(value: Promise<void>) {
      promiseQueueHolder.current = value;
    },
  } as unknown as WorkflowOrchestratorContext;
}

describe('unconsumed-event check against in-flight deliveries', () => {
  it('does not declare divergence while a payload is hydrating', async () => {
    const ctx = createDeliveryContext();
    const event = createEvent();
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer([event], {
      onUnconsumedEvent,
      getPromiseQueue: () => ctx.promiseQueue,
      isDeliveryIdle: () => isDeliveryIdle(ctx),
    });

    // A delivery in flight: hydration inside a serial queue slot.
    ctx.pendingDeliveries++;

    consumer.subscribe(
      vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
    );

    // Several times the window the check would otherwise have fired in, so
    // the run survives only if the check waits for the delivery rather than
    // for the clock.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();

    ctx.pendingDeliveries--;
    await vi.waitFor(() => {
      expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
    });
  });

  it('lets a consumer registered during the wait claim the event', async () => {
    const ctx = createDeliveryContext();
    const event = createEvent();
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer([event], {
      onUnconsumedEvent,
      getPromiseQueue: () => ctx.promiseQueue,
      isDeliveryIdle: () => isDeliveryIdle(ctx),
    });

    ctx.pendingDeliveries++;

    consumer.subscribe(
      vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();

    // What the in-flight delivery was on its way to doing: resume workflow
    // code that subscribes the consumer this event belongs to.
    ctx.pendingDeliveries--;
    consumer.subscribe(vi.fn().mockReturnValue(EventConsumerResult.Finished));

    await vi.waitFor(() => {
      expect(consumer.eventIndex).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
  });

  it('still declares divergence for an event no delivery is waiting on', async () => {
    const ctx = createDeliveryContext();
    const event = createEvent();
    const unconsumedReceived = withResolvers<Event>();
    const consumer = new EventsConsumer([event], {
      onUnconsumedEvent: unconsumedReceived.resolve,
      getPromiseQueue: () => ctx.promiseQueue,
      isDeliveryIdle: () => isDeliveryIdle(ctx),
    });

    consumer.subscribe(
      vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
    );

    expect(await unconsumedReceived.promise).toEqual(event);
  });
});
