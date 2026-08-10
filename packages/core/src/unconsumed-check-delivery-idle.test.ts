import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';
import type { WorkflowOrchestratorContext } from './private.js';
import { isDeliveryIdle, registerDeliveryBarrier } from './private.js';

/**
 * The events consumer walks the log synchronously; the resolutions that walk
 * triggers do not resolve synchronously. A step result hydrates in the host,
 * resolves from a detached continuation behind `awaitEarlierDeliveries`, and
 * only then does VM code run far enough to `subscribe()` the consumer for the
 * next event. So the walk routinely sits on an ordered event (`step_created`,
 * `wait_created`) that nobody has claimed yet while the workflow is mid-flight
 * on its way to claiming it.
 *
 * The unconsumed-event check used to resolve that by waiting a fixed
 * `DEFERRED_CHECK_DELAY_MS` after the promise queue drained, which is a bet
 * that every delivery lands inside the window. Replaying a batch of N parallel
 * step results loses it: the queue drains with N-1 of them still on the
 * detached path, and the check declares `ReplayDivergenceError` against a log
 * the very same replay goes on to reproduce exactly. Measured on the event-log
 * race repro against world-postgres, on identical event logs: 0 of 114 runs
 * corrupted with a 100ms window, 34 of 42 with a 10ms one.
 *
 * `hasParkedCommittedDelivery` in private.ts already documents this hazard for
 * the suspension path (vercel/workflow#3183). These tests pin the same guard
 * on the divergence path, using the production predicate rather than a mock:
 * a real armed delivery barrier must hold the check off however long it takes,
 * and the check must still fire for an event no delivery is waiting on.
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
 * The slice of the orchestrator context that `isDeliveryIdle` and
 * `registerDeliveryBarrier` read. Everything else a replay carries is
 * irrelevant to whether a delivery is in flight.
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unconsumed-event check against in-flight deliveries', () => {
  it('does not declare divergence while a step delivery is outstanding', async () => {
    // Far shorter than the delivery below, so the run survives only if the
    // check waits for the delivery rather than for the clock.
    vi.stubEnv('WORKFLOW_DEFERRED_CHECK_DELAY_MS', '10');

    const ctx = createDeliveryContext();
    const event = createEvent();
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer([event], {
      onUnconsumedEvent,
      getPromiseQueue: () => ctx.promiseQueue,
      isDeliveryIdle: () => isDeliveryIdle(ctx),
    });

    // A step result committed to being delivered, sitting on the detached
    // continuation that `pendingDeliveries` deliberately does not cover.
    const barrier = registerDeliveryBarrier(ctx, 0, 'step');

    consumer.subscribe(
      vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();

    // The delivery lands and the workflow reaches the call this event records.
    barrier.markDelivered();
    consumer.subscribe(vi.fn().mockReturnValue(EventConsumerResult.Finished));

    await vi.waitFor(() => {
      expect(consumer.eventIndex).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
  });

  it('does not declare divergence while a payload is hydrating', async () => {
    vi.stubEnv('WORKFLOW_DEFERRED_CHECK_DELAY_MS', '10');

    const ctx = createDeliveryContext();
    const event = createEvent();
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer([event], {
      onUnconsumedEvent,
      getPromiseQueue: () => ctx.promiseQueue,
      isDeliveryIdle: () => isDeliveryIdle(ctx),
    });

    // The other in-flight window: hydration inside a serial queue slot.
    ctx.pendingDeliveries++;

    consumer.subscribe(
      vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onUnconsumedEvent).not.toHaveBeenCalled();

    ctx.pendingDeliveries--;
    await vi.waitFor(() => {
      expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
    });
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
