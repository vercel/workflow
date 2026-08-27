import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_CHECK_DELAY_MS,
  EventConsumerResult,
  EventsConsumer,
  MIN_DEFERRED_CHECK_DELAY_MS,
} from './events-consumer.js';

// Helper function to create mock events
function createMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    workflow_run_id: 'run-1',
    event_type: 'test-event',
    event_data: { value: 'test' },
    sequence_number: 1,
    created_at: new Date(),
    ...overrides,
  };
}

// Default options for tests that don't care about onUnconsumedEvent
// No deliveries are modeled here, so the delivery-idle gate is always open; the
// tests that exercise the gate itself pass their own predicate.
const defaultOptions = {
  onUnconsumedEvent: vi.fn(),
  getPromiseQueue: () => Promise.resolve(),
  isDeliveryIdle: () => true,
};

// Helper function to wait for next tick
function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe('EventsConsumer', () => {
  describe('constructor', () => {
    it('should initialize with provided events', () => {
      const events = [createMockEvent(), createMockEvent({ id: 'event-2' })];
      const consumer = new EventsConsumer(events, defaultOptions);

      expect(consumer.events).toEqual(events);
      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toEqual([]);
    });

    it('should initialize with empty events array', () => {
      const consumer = new EventsConsumer([], defaultOptions);

      expect(consumer.events).toEqual([]);
      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toEqual([]);
    });
  });

  describe('subscribe', () => {
    it('should add callback to callbacks array', () => {
      const consumer = new EventsConsumer([], defaultOptions);
      const callback = vi.fn();

      consumer.subscribe(callback);

      expect(consumer.callbacks).toContain(callback);
      expect(consumer.callbacks).toHaveLength(1);
    });

    it('should add multiple callbacks in order', () => {
      const consumer = new EventsConsumer([], defaultOptions);
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      consumer.subscribe(callback3);

      expect(consumer.callbacks).toEqual([callback1, callback2, callback3]);
    });

    it('should automatically trigger consume on subscribe', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('consume (implicit)', () => {
    it('should call callbacks with current event', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should call callbacks with null when no events exist', async () => {
      const consumer = new EventsConsumer([], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(null);
    });

    it('should increment event index and remove callback when callback returns Finished', async () => {
      const event1 = createMockEvent({ id: 'event-1' });
      const event2 = createMockEvent({ id: 'event-2' });
      const consumer = new EventsConsumer([event1, event2], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(consumer.eventIndex).toBe(1);
      expect(consumer.callbacks).toHaveLength(0);
    });

    it('should not increment event index when callback returns false', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toContain(callback);
    });

    it('should process multiple callbacks until one returns true', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback1 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      const callback3 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      consumer.subscribe(callback3);
      await waitForNextTick();

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(null);
      expect(consumer.eventIndex).toBe(1);
      expect(consumer.callbacks).toEqual([callback1, callback3]);
    });

    it('should process all callbacks when none return true and call onUnconsumedEvent', async () => {
      const event = createMockEvent();
      const unconsumedReceived = withResolvers<Event>();
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent: unconsumedReceived.resolve,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const callback1 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);
      const callback2 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);
      const callback3 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      consumer.subscribe(callback3);
      await waitForNextTick();

      expect(callback1).toHaveBeenCalledWith(event);
      expect(callback2).toHaveBeenCalledWith(event);
      expect(callback3).toHaveBeenCalledWith(event);
      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toEqual([callback1, callback2, callback3]);

      const unconsumedEvent = await unconsumedReceived.promise;
      expect(unconsumedEvent).toEqual(event);
    });

    it('should recursively process next event when current event is consumed', async () => {
      const event1 = createMockEvent({ id: 'event-1', sequence_number: 1 });
      const event2 = createMockEvent({ id: 'event-2', sequence_number: 2 });
      const consumer = new EventsConsumer([event1, event2], defaultOptions);
      const callback1 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      await waitForNextTick();
      await waitForNextTick(); // Wait for recursive processing

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledWith(event1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledWith(event2);
      expect(consumer.eventIndex).toBe(2);
      expect(consumer.callbacks).toHaveLength(0);
    });

    it('should drain consecutively consumable events within a single tick', async () => {
      // Optimization: when the consumers for a run of events are already
      // registered (the common replay case), the consumer drains them all in
      // one synchronous pass rather than paying one process.nextTick per
      // event. A single tick is enough to fully advance the index here.
      const events = [
        createMockEvent({ id: 'event-1', sequence_number: 1 }),
        createMockEvent({ id: 'event-2', sequence_number: 2 }),
        createMockEvent({ id: 'event-3', sequence_number: 3 }),
      ];
      const consumer = new EventsConsumer(events, defaultOptions);
      // A single long-lived consumer that consumes every real event (mirrors a
      // step consumer walking step_created -> step_started -> step_completed)
      // and returns NotConsumed once it reaches the end-of-events sentinel.
      const callback = vi
        .fn()
        .mockImplementation((event: Event | null) =>
          event === null
            ? EventConsumerResult.NotConsumed
            : EventConsumerResult.Consumed
        );

      consumer.subscribe(callback);
      await waitForNextTick();

      // Three real events consumed plus one call with the null sentinel, all
      // within a single tick.
      expect(callback).toHaveBeenCalledTimes(4);
      expect(callback).toHaveBeenNthCalledWith(1, events[0]);
      expect(callback).toHaveBeenNthCalledWith(2, events[1]);
      expect(callback).toHaveBeenNthCalledWith(3, events[2]);
      expect(callback).toHaveBeenNthCalledWith(4, null);
      expect(consumer.eventIndex).toBe(3);
    });

    it('should handle event index beyond events array length', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback);
      await waitForNextTick();

      // Now eventIndex is 1, but array only has 1 element (index 0)
      const callback2 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);
      consumer.subscribe(callback2);
      await waitForNextTick();

      expect(callback2).toHaveBeenCalledWith(null);
    });

    it('should handle complex event processing scenario', async () => {
      const events = [
        createMockEvent({ id: 'event-1', event_type: 'type-a' }),
        createMockEvent({ id: 'event-2', event_type: 'type-b' }),
        createMockEvent({ id: 'event-3', event_type: 'type-a' }),
      ];
      const consumer = new EventsConsumer(events, defaultOptions);

      // Callback that only processes type-a events
      const typeACallback = vi
        .fn()
        .mockImplementation((event: Event | null) => {
          return event?.event_type === 'type-a'
            ? EventConsumerResult.Finished
            : EventConsumerResult.NotConsumed;
        });

      // Callback that only processes type-b events
      const typeBCallback = vi
        .fn()
        .mockImplementation((event: Event | null) => {
          return event?.event_type === 'type-b'
            ? EventConsumerResult.Finished
            : EventConsumerResult.NotConsumed;
        });

      consumer.subscribe(typeACallback);
      consumer.subscribe(typeBCallback);
      await waitForNextTick();
      await waitForNextTick(); // Wait for recursive processing
      await waitForNextTick(); // Wait for final processing

      // typeACallback processes event-1 and gets removed, so it won't process event-3
      expect(typeACallback).toHaveBeenCalledTimes(1); // Called for event-1 only
      expect(typeBCallback).toHaveBeenCalledTimes(1); // Called for event-2
      expect(consumer.eventIndex).toBe(2); // Only 2 events processed (event-3 remains)
      expect(consumer.callbacks).toHaveLength(0); // Both callbacks removed after consuming their events
    });
  });

  describe('edge cases', () => {
    it('should handle callback that throws error gracefully', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const throwingCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const normalCallback = vi
        .fn()
        .mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(throwingCallback);
      consumer.subscribe(normalCallback);
      await waitForNextTick();

      // Error is caught and logged via eventsLogger, processing continues to next callback
      expect(throwingCallback).toHaveBeenCalledWith(event);
      expect(normalCallback).toHaveBeenCalledWith(event);
    });

    it('should continue processing when onConsumedEvent throws', async () => {
      const event1 = createMockEvent({ id: 'event-1' });
      const event2 = createMockEvent({ id: 'event-2' });
      const onConsumedEvent = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Observer error');
        })
        .mockImplementation(() => undefined);
      const consumer = new EventsConsumer([event1, event2], {
        ...defaultOptions,
        onConsumedEvent,
      });
      const callback1 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      await waitForNextTick();
      await waitForNextTick();

      expect(onConsumedEvent).toHaveBeenNthCalledWith(1, event1);
      expect(onConsumedEvent).toHaveBeenNthCalledWith(2, event2);
      expect(consumer.eventIndex).toBe(2);
    });

    it('should handle callback removal during iteration', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event], defaultOptions);
      const callback1 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      const callback3 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback1);
      consumer.subscribe(callback2);
      consumer.subscribe(callback3);
      await waitForNextTick();

      // callback2 should be removed when it returns true
      expect(consumer.callbacks).toEqual([callback1, callback3]);
      expect(callback3).toHaveBeenCalledWith(null);
    });

    it('should handle events with null/undefined data', async () => {
      const eventWithNullData = createMockEvent({ event_data: null as any });
      const consumer = new EventsConsumer([eventWithNullData], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(eventWithNullData);
      expect(consumer.eventIndex).toBe(1);
    });

    it('should handle multiple subscriptions happening in sequence', async () => {
      const event1 = createMockEvent({ id: 'event-1' });
      const event2 = createMockEvent({ id: 'event-2' });
      const consumer = new EventsConsumer([event1, event2], defaultOptions);

      const callback1 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback1);
      await waitForNextTick();

      consumer.subscribe(callback2);
      await waitForNextTick();

      expect(callback1).toHaveBeenCalledWith(event1);
      expect(callback2).toHaveBeenCalledWith(event2);
      expect(consumer.eventIndex).toBe(2);
    });

    it('should handle empty events array gracefully', async () => {
      const consumer = new EventsConsumer([], defaultOptions);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(null);
      expect(consumer.eventIndex).toBe(0);
    });
  });

  describe('onUnconsumedEvent', () => {
    it('should call onUnconsumedEvent when a non-null event is not consumed by any callback', async () => {
      const event = createMockEvent();
      const unconsumedReceived = withResolvers<Event>();
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent: unconsumedReceived.resolve,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);

      const unconsumedEvent = await unconsumedReceived.promise;
      expect(unconsumedEvent).toEqual(event);
    });

    it('should NOT call onUnconsumedEvent for null event (end-of-events)', async () => {
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer([], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);

      // Wait for the callback to be invoked with null (end-of-events)
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledWith(null);
      });

      // null events should never trigger onUnconsumedEvent
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });

    it('should cancel pending unconsumed check when a new callback subscribes', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const callback1 = vi
        .fn()
        .mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback1);
      await waitForNextTick();

      // Before the macrotask fires, subscribe a new callback that consumes the event
      const callback2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      consumer.subscribe(callback2);

      // Wait for the new callback to consume the event
      await vi.waitFor(() => {
        expect(consumer.eventIndex).toBe(1);
      });

      // Wait past the internal 100ms unconsumed-event setTimeout window to
      // ensure the cancelled check truly does not fire.
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The new callback consumed the event, so onUnconsumedEvent should NOT be called
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });
  });

  describe('parking events that carry no ordering claim', () => {
    /**
     * A log event of a real type. The rest of this file uses a mock shape with
     * no `eventType` at all, which is deliberately unparkable, so parking
     * tests need events the consumer recognizes.
     */
    function logEvent(eventType: Event['eventType'], id: string): Event {
      // `eventId` as well as the mock shape's `id`: the consumer reports the
      // former, the matcher below keys on the latter.
      return createMockEvent({ id, eventId: id, eventType } as Partial<Event>);
    }

    /** Consumes exactly the events whose id is in `ids`, once each. */
    function consumerFor(ids: string[]) {
      const seen: string[] = [];
      const callback = (event: Event | null) => {
        if (event && ids.includes(event.id) && !seen.includes(event.id)) {
          seen.push(event.id);
          return EventConsumerResult.Consumed;
        }
        return EventConsumerResult.NotConsumed;
      };
      return { seen, callback };
    }

    it('walks past an unclaimed hook_received instead of declaring divergence', async () => {
      const hook = logEvent('hook_received', 'hook-1');
      const wait = logEvent('wait_created', 'wait-1');
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer([hook, wait], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const waits = consumerFor(['wait-1']);

      consumer.subscribe(waits.callback);

      // The hook belongs to a consumer this replay has not registered. The
      // wait behind it is this replay's own decision and must still land.
      await vi.waitFor(() => {
        expect(waits.seen).toEqual(['wait-1']);
      });
      expect(consumer.eventIndex).toBe(2);
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });

    it('delivers a parked event to a consumer that subscribes later', async () => {
      const hook = logEvent('hook_received', 'hook-1');
      const wait = logEvent('wait_created', 'wait-1');
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer([hook, wait], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      const waits = consumerFor(['wait-1']);
      consumer.subscribe(waits.callback);
      await vi.waitFor(() => {
        expect(waits.seen).toEqual(['wait-1']);
      });

      const hooks = consumerFor(['hook-1']);
      consumer.subscribe(hooks.callback);

      await vi.waitFor(() => {
        expect(hooks.seen).toEqual(['hook-1']);
      });
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });

    it('replays a parked event under the index it held in the log', async () => {
      const hook = logEvent('hook_received', 'hook-1');
      const wait = logEvent('wait_created', 'wait-1');
      const consumer = new EventsConsumer([hook, wait], {
        onUnconsumedEvent: vi.fn(),
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      consumer.subscribe(consumerFor(['wait-1']).callback);
      await vi.waitFor(() => {
        expect(consumer.eventIndex).toBe(2);
      });

      // Delivery barriers are registered under whatever `eventIndex` reads at
      // consumption time, so a late delivery must still make the ordering
      // claim its log position gave it — index 0, not the walk's 2.
      let indexAtDelivery: number | undefined;
      consumer.subscribe((event) => {
        if (event?.id !== 'hook-1') {
          return EventConsumerResult.NotConsumed;
        }
        indexAtDelivery = consumer.eventIndex;
        return EventConsumerResult.Finished;
      });

      await vi.waitFor(() => {
        expect(indexAtDelivery).toBe(0);
      });
      // The walk pointer is restored, not left behind at the parked index.
      expect(consumer.eventIndex).toBe(2);
    });

    it('still declares divergence for an unclaimed replay-origin event', async () => {
      const step = logEvent('step_created', 'step-1');
      const unconsumedReceived = withResolvers<Event>();
      const consumer = new EventsConsumer([step], {
        onUnconsumedEvent: unconsumedReceived.resolve,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });

      consumer.subscribe(() => EventConsumerResult.NotConsumed);

      expect(await unconsumedReceived.promise).toEqual(step);
    });

    it('reports what it is still holding when the walk stops', async () => {
      const hook = logEvent('hook_received', 'hook-1');
      const late = logEvent('hook_received', 'hook-2');
      const wait = logEvent('wait_created', 'wait-1');
      const consumer = new EventsConsumer([hook, late, wait], {
        onUnconsumedEvent: vi.fn(),
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      expect(consumer.parkedSummary).toBeUndefined();

      consumer.subscribe(consumerFor(['wait-1']).callback);
      await vi.waitFor(() => {
        expect(consumer.eventIndex).toBe(3);
      });

      // Both hooks were walked past. A suspension is not a settling point, so
      // the state goes on the span instead of failing the run: the oldest one
      // held is what a query across a run's spans keys on.
      expect(consumer.parkedSummary).toEqual({
        count: 2,
        eventId: 'hook-1',
        eventType: 'hook_received',
      });

      // Once a consumer claims them the run is holding nothing, and the
      // attribute stops appearing on later spans.
      consumer.subscribe(consumerFor(['hook-1', 'hook-2']).callback);
      await vi.waitFor(() => {
        expect(consumer.parkedSummary).toBeUndefined();
      });
    });

    it('declares divergence for an event still parked once the run has ended', async () => {
      const hook = logEvent('hook_received', 'hook-1');
      const completed = logEvent('run_completed', 'done-1');
      const unconsumedReceived = withResolvers<Event>();
      const consumer = new EventsConsumer([hook, completed], {
        onUnconsumedEvent: unconsumedReceived.resolve,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });

      // Nothing can subscribe for the hook after the run has finished, so
      // parking it would silently drop it.
      consumer.subscribe(consumerFor(['done-1']).callback);

      expect(await unconsumedReceived.promise).toEqual(hook);
    });
  });

  describe('delivery-idle gate', () => {
    // An event nobody claims is only evidence of divergence once the workflow
    // VM has stopped reacting. While a delivery is in flight the walk is
    // simply ahead of the code that would register the consumer, so the check
    // has to wait rather than time out. See `isDeliveryIdle` in private.ts.
    it('should not fire the unconsumed check while a delivery is in flight', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      let idle = false;
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => idle,
      });

      consumer.subscribe(
        vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
      );

      // Several times the window the check would otherwise have fired in.
      await new Promise((resolve) =>
        setTimeout(resolve, DEFERRED_CHECK_DELAY_MS * 5)
      );
      expect(onUnconsumedEvent).not.toHaveBeenCalled();

      idle = true;
      await vi.waitFor(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
      });
    });

    it('should let a consumer registered during the wait claim the event', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      let idle = false;
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => idle,
      });

      consumer.subscribe(
        vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
      );
      await new Promise((resolve) =>
        setTimeout(resolve, DEFERRED_CHECK_DELAY_MS * 2)
      );

      // What the in-flight delivery was on its way to doing: resume workflow
      // code that subscribes the consumer this event belongs to.
      consumer.subscribe(vi.fn().mockReturnValue(EventConsumerResult.Finished));
      idle = true;

      await vi.waitFor(() => {
        expect(consumer.eventIndex).toBe(1);
      });
      await new Promise((resolve) =>
        setTimeout(resolve, DEFERRED_CHECK_DELAY_MS * 2)
      );
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });

    it('should fire without delay for an event no delivery is waiting on', async () => {
      const event = createMockEvent();
      const unconsumedReceived = withResolvers<Event>();
      const consumer = new EventsConsumer([event], {
        onUnconsumedEvent: unconsumedReceived.resolve,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });

      consumer.subscribe(
        vi.fn().mockReturnValue(EventConsumerResult.NotConsumed)
      );

      expect(await unconsumedReceived.promise).toEqual(event);
    });
  });

  // The deferred check reaches its outcome through a multi-stage timer chain
  // (promise queue → setTimeout(0) → idle poll → delay timer), and loaded CI
  // runners with coarse timers — Windows especially — can starve that chain
  // for whole seconds. The polls below return as soon as their assertions
  // hold, so a generous test budget costs healthy runs nothing.
  describe('duplicate event classes', { timeout: 30_000 }, () => {
    // Nothing here waits on the window for its result — a duplicate is stepped
    // over in the pass that offers it — so run at the shortest legal delay and
    // let the assertions that a check did NOT fire be cheap.
    beforeEach(() => {
      vi.stubEnv(
        'WORKFLOW_DEFERRED_CHECK_DELAY_MS',
        String(MIN_DEFERRED_CHECK_DELAY_MS)
      );
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // Polls until the outcome of a deferred check holds. The check is not on a
    // fixed schedule: it first waits for delivery to go idle, which is its own
    // poll loop, and only then arms a `getDeferredCheckDelayMs()` timer. So a
    // sleep of any multiple of that delay is a lower bound on when the timer
    // becomes eligible, not a guarantee it has run, and on a loaded runner
    // with a coarse timer it is not even close.
    //
    // Pass the whole assertion block. The positive assertions gate the poll,
    // and the negatives alongside them are then evaluated at the moment the
    // check is known to have fired, which is what the assertions mean.
    function afterDeferredCheck(assertions: () => void): Promise<void> {
      // The timeout bounds a stalled runner, not the expected path: a healthy
      // run satisfies the assertions within a few windows. 2s (the previous
      // bound) was regularly starved through on Windows CI runners.
      return vi.waitFor(assertions, {
        timeout: 15_000,
        interval: MIN_DEFERRED_CHECK_DELAY_MS,
      });
    }

    // Unlike createMockEvent above, this builds the real `Event` shape, which
    // the duplicate-class skip needs: it reads `eventType` and `correlationId`.
    let realEventCounter = 0;
    function realEvent(
      eventType: string,
      correlationId: string | undefined
    ): Event {
      realEventCounter++;
      return {
        eventId: `evnt_${realEventCounter}`,
        runId: 'wrun_test',
        eventType,
        correlationId,
        eventData: {},
        createdAt: new Date(),
      } as unknown as Event;
    }

    /**
     * A consumer for one entity: takes every event carrying `correlationId`
     * and deregisters once it has taken `terminalType`. This is the shape the
     * runtime's step/wait consumers have, and the reason a straggler for that
     * id has no callback left to claim it.
     */
    function entityConsumer(correlationId: string, terminalType: string) {
      return vi.fn((event: Event | null) => {
        if (event === null || event.correlationId !== correlationId) {
          return EventConsumerResult.NotConsumed;
        }
        return event.eventType === terminalType
          ? EventConsumerResult.Finished
          : EventConsumerResult.Consumed;
      });
    }

    function consumerFor(
      events: Event[],
      overrides: Partial<{
        onUnconsumedEvent: (event: Event) => void;
        onDuplicateEvent: (
          event: Event,
          firstEventType: Event['eventType']
        ) => void;
        onConsumedEvent: (event: Event) => void;
      }> = {}
    ) {
      return new EventsConsumer(events, {
        onUnconsumedEvent: vi.fn(),
        getPromiseQueue: () => Promise.resolve(),
        // No deliveries are modeled here, so the gate is always open.
        isDeliveryIdle: () => true,
        ...overrides,
      });
    }

    it('skips a step_started that repeats a class already in the log', async () => {
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_started', corr),
        realEvent('step_completed', corr),
        // Written by a concurrent replay working from a prefix that predates
        // the completion, so it lands after it.
        realEvent('step_started', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        expect(onDuplicateEvent).toHaveBeenCalledTimes(1);
        expect(onDuplicateEvent).toHaveBeenCalledWith(
          events[3],
          'step_started'
        );
      });
    });

    it('skips a step_created that repeats a class already in the log', async () => {
      // Classes are tracked independently, so a completed step still has a
      // recorded step_created and a second one is ignorable.
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_completed', corr),
        realEvent('step_created', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        expect(onDuplicateEvent).toHaveBeenCalledWith(
          events[2],
          'step_created'
        );
      });
    });

    it('skips a duplicate wait_completed ahead of parking it', async () => {
      // wait_completed is parkable, so without the class check this would be
      // held for a consumer that can never come and strand the walk.
      const corr = 'wait_A';
      const events = [
        realEvent('wait_created', corr),
        realEvent('wait_completed', corr),
        realEvent('wait_completed', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer(corr, 'wait_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(consumer.parkedSummary).toBeUndefined();
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        expect(onDuplicateEvent).toHaveBeenCalledWith(
          events[2],
          'wait_completed'
        );
      });
    });

    it('skips a duplicate run_started, which carries no correlation id', async () => {
      const events = [
        realEvent('run_started', undefined),
        realEvent('run_started', undefined),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const onConsumedEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
        onConsumedEvent,
      });

      // The runtime's run-lifecycle callback takes the first run_started and
      // declines the rest rather than deregistering, since it still handles
      // other run events.
      let consumedRunStarted = false;
      consumer.subscribe((event: Event | null) => {
        if (event?.eventType !== 'run_started' || consumedRunStarted) {
          return EventConsumerResult.NotConsumed;
        }
        consumedRunStarted = true;
        return EventConsumerResult.Consumed;
      });
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        expect(onDuplicateEvent).toHaveBeenCalledWith(events[1], 'run_started');
        expect(onConsumedEvent).toHaveBeenCalledTimes(1);
      });
    });

    it('still reports an unconsumed event for a correlation id the log has nothing for', async () => {
      const events = [
        realEvent('step_created', 'step_A'),
        realEvent('step_started', 'step_A'),
        realEvent('step_completed', 'step_A'),
        // A different entity that no callback ever claims. wait_created is not
        // parkable: its position is this replay's own decision record.
        realEvent('wait_created', 'wait_B'),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer('step_A', 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(3);
        expect(onDuplicateEvent).not.toHaveBeenCalled();
      });

      await afterDeferredCheck(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(events[3]);
      });
    });

    it('does not let one class suppress another for the same entity', async () => {
      // The step's outcome is in the log but its first attempt never wrote a
      // step_started, so this one is not a repeat of anything and divergence
      // is the right answer.
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_completed', corr),
        realEvent('step_started', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(2);
        expect(onDuplicateEvent).not.toHaveBeenCalled();
      });

      await afterDeferredCheck(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(events[2]);
      });
    });

    it('skips a second attr_set for an id the walk already resolved', async () => {
      // Concurrent replays at the same body position draw the same attribute
      // id, and a World that commits both leaves two events under it. The
      // dispatcher's consumer deregisters on the first, so without the class
      // the second would park for a consumer that cannot come and be reported
      // as stranded once the workflow function returns.
      const corr = 'attr_A';
      const events = [
        realEvent('attr_set', corr),
        realEvent('attr_set', corr),
        realEvent('step_created', 'step_B'),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      consumer.subscribe(entityConsumer(corr, 'attr_set'));
      consumer.subscribe(entityConsumer('step_B', 'step_created'));

      await afterDeferredCheck(() => {
        expect(onDuplicateEvent).toHaveBeenCalledWith(events[1], 'attr_set');
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        // Nothing held: the run can return without being declared corrupt.
        expect(consumer.strandedEvent).toBeUndefined();
        // The walk still reached the event after the duplicate.
        expect(consumer.eventIndex).toBe(events.length);
      });
    });

    it('parks an attr_set whose consumer has not subscribed yet', async () => {
      // The duplicate skip must not swallow a first arrival: a replay can walk
      // past an attribute event before the body reaches the call that claims
      // it, and that one is still owed to a consumer.
      const corr = 'attr_A';
      const events = [
        realEvent('attr_set', corr),
        realEvent('step_created', 'step_B'),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      // Only the later entity has a consumer, so the walk has to get past the
      // attribute event to reach it.
      consumer.subscribe(entityConsumer('step_B', 'step_created'));
      await afterDeferredCheck(() => {
        expect(consumer.strandedEvent).toEqual(events[0]);
        expect(onDuplicateEvent).not.toHaveBeenCalled();
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
      });

      // A late subscriber still gets it out of the parked set.
      consumer.subscribe(entityConsumer(corr, 'attr_set'));
      await afterDeferredCheck(() => {
        expect(consumer.strandedEvent).toBeUndefined();
      });
    });

    it('does not track hook deliveries, whose consumers subscribe lazily', async () => {
      // A hook legitimately fires many times under one id, so a second
      // hook_received is not a repeat of a decided outcome. It keeps the
      // parking path rather than being skipped.
      const corr = 'hook_A';
      const events = [
        realEvent('hook_created', corr),
        realEvent('hook_received', corr),
        realEvent('hook_received', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      // Takes the create and the first delivery, then deregisters.
      consumer.subscribe(entityConsumer(corr, 'hook_received'));
      await afterDeferredCheck(() => {
        expect(onDuplicateEvent).not.toHaveBeenCalled();
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        expect(consumer.strandedEvent).toEqual(events[2]);
      });
    });

    it('never takes an event a registered callback still wants', async () => {
      // The skip is a last resort, consulted only after every callback
      // declined, which is what lets a retry's step_started reach the live
      // consumer and count as an attempt.
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_started', corr),
        realEvent('step_retrying', corr),
        realEvent('step_started', corr),
      ];
      const onUnconsumedEvent = vi.fn();
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, {
        onUnconsumedEvent,
        onDuplicateEvent,
      });

      const callback = vi.fn((event: Event | null) =>
        event === null
          ? EventConsumerResult.NotConsumed
          : EventConsumerResult.Consumed
      );
      consumer.subscribe(callback);
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(callback).toHaveBeenCalledWith(events[3]);
        expect(onDuplicateEvent).not.toHaveBeenCalled();
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
      });
    });

    it('steps over a straggler without waiting out the deferred window', async () => {
      // The window buys time for a consumer that has yet to register, and no
      // such consumer can want an event of a class this replay already
      // consumed. Paying it anyway costs the delay per straggler per replay,
      // which is what makes a stormed run's log expensive to walk.
      const corr = 'step_A';
      const stragglers = 3;
      const events = [
        realEvent('step_created', corr),
        realEvent('step_started', corr),
        realEvent('step_completed', corr),
        ...Array.from({ length: stragglers }, () =>
          realEvent('step_started', corr)
        ),
      ];
      // Run at the real delay: the point of the test is the difference
      // between paying it and not, so shortening it would erase the signal.
      vi.unstubAllEnvs();
      const consumer = consumerFor(events);

      const start = Date.now();
      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await vi.waitFor(
        () => {
          expect(consumer.eventIndex).toBe(events.length);
        },
        { interval: 1 }
      );

      // Deferring each straggler would cost one window apiece, so the walk
      // finishing inside a single window means none of them went through the
      // deferred check.
      expect(Date.now() - start).toBeLessThan(DEFERRED_CHECK_DELAY_MS);
    });

    it('reports the first outcome when a repeat decides the class differently', async () => {
      // Two replays raced a nondeterministic step to opposite results. The
      // first one is what the workflow observed, on every replay; the second
      // is dropped, and the drop is worth surfacing.
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_completed', corr),
        realEvent('step_failed', corr),
      ];
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, { onDuplicateEvent });

      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        expect(onDuplicateEvent).toHaveBeenCalledWith(
          events[2],
          'step_completed'
        );
      });
    });

    it('leaves a duplicate run_cancelled to the parking path', async () => {
      // Terminal run events have no class: nothing consumes them, so no class
      // could ever be recorded for one. In production the runtime exits before
      // replaying a body whose log already holds one, so this path is only
      // reachable in a test — the point is that the skip does not claim to
      // handle it.
      const events = [
        realEvent('run_started', undefined),
        realEvent('run_cancelled', undefined),
        realEvent('run_cancelled', undefined),
      ];
      const onDuplicateEvent = vi.fn();
      const consumer = consumerFor(events, { onDuplicateEvent });

      let consumedRunStarted = false;
      consumer.subscribe((event: Event | null) => {
        if (event?.eventType !== 'run_started' || consumedRunStarted) {
          return EventConsumerResult.NotConsumed;
        }
        consumedRunStarted = true;
        return EventConsumerResult.Consumed;
      });
      await afterDeferredCheck(() => {
        expect(onDuplicateEvent).not.toHaveBeenCalled();
        expect(consumer.parkedSummary?.eventType).toBe('run_cancelled');
      });
    });

    it('does not advance the deterministic clock for a skipped event', async () => {
      const corr = 'step_A';
      const events = [
        realEvent('step_created', corr),
        realEvent('step_completed', corr),
        realEvent('step_created', corr),
      ];
      const onConsumedEvent = vi.fn();
      const consumer = consumerFor(events, { onConsumedEvent });

      consumer.subscribe(entityConsumer(corr, 'step_completed'));
      await afterDeferredCheck(() => {
        expect(consumer.eventIndex).toBe(events.length);
        // The workflow body never observed the straggler, so a log containing it
        // must produce the same timestamps as a log that does not.
        expect(onConsumedEvent).toHaveBeenCalledTimes(2);
        expect(onConsumedEvent).not.toHaveBeenCalledWith(events[2]);
      });
    });
  });
});

describe('sealed-log noop events (specVersion 7)', () => {
  function logEvent(eventType: Event['eventType'], id: string): Event {
    return createMockEvent({ id, eventId: id, eventType } as Partial<Event>);
  }

  function consumerFor(ids: string[]) {
    const seen: string[] = [];
    const callback = (event: Event | null) => {
      if (event && ids.includes(event.id) && !seen.includes(event.id)) {
        seen.push(event.id);
        return EventConsumerResult.Consumed;
      }
      return EventConsumerResult.NotConsumed;
    };
    return { seen, callback };
  }

  it('steps over a noop without offering it to any consumer', async () => {
    // The backend sealed an abandoned slot between two real events. The walk
    // must pass through it as if the position never had a writer: both real
    // events land, nothing is reported unconsumed, and the callback is never
    // even offered the noop.
    const noop = logEvent('noop' as Event['eventType'], 'noop-1');
    const before = logEvent('wait_created', 'wait-1');
    const after = logEvent('wait_completed', 'wait-2');
    const onUnconsumedEvent = vi.fn();
    const offered: (string | null)[] = [];
    const consumer = new EventsConsumer([before, noop, after], {
      onUnconsumedEvent,
      getPromiseQueue: () => Promise.resolve(),
      isDeliveryIdle: () => true,
    });
    const reals = consumerFor(['wait-1', 'wait-2']);
    consumer.subscribe((event) => {
      offered.push(event === null ? null : event.id);
      return reals.callback(event);
    });

    await vi.waitFor(() => {
      expect(reals.seen).toEqual(['wait-1', 'wait-2']);
    });
    expect(consumer.eventIndex).toBe(3);
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
    expect(offered).not.toContain('noop-1');
  });

  it('never advances the deterministic clock off a noop', async () => {
    // A noop's createdAt is the SEALER's wall clock — it can postdate every
    // real event around it. Letting it reach onConsumedEvent would leak that
    // timestamp into replay Date.now() and diverge from a log whose hole was
    // filled by the real writer instead.
    const noop = createMockEvent({
      id: 'noop-1',
      eventId: 'noop-1',
      eventType: 'noop',
      createdAt: new Date(Date.now() + 60_000),
    } as Partial<Event>);
    const real = logEvent('wait_created', 'wait-1');
    const onConsumedEvent = vi.fn();
    const consumer = new EventsConsumer([noop, real], {
      ...defaultOptions,
      onConsumedEvent,
    });
    const reals = consumerFor(['wait-1']);
    consumer.subscribe(reals.callback);

    await vi.waitFor(() => {
      expect(reals.seen).toEqual(['wait-1']);
    });
    expect(onConsumedEvent).toHaveBeenCalledTimes(1);
    expect(onConsumedEvent).toHaveBeenCalledWith(real);
  });

  it('is scheduling-neutral: same offers, same tick, as the log without noops', async () => {
    // The skip is a synchronous `continue` inside the walk pass — it consumes
    // no extra micro- or macrotask. This pins that: a log with noops
    // interleaved at the head, middle, and tail is fully consumed after the
    // SAME single tick as its noop-free twin, and the sequence of events
    // offered to consumers is byte-for-byte identical. Deterministic
    // scheduling is what keeps replay ULID draws (and therefore correlation
    // ids) stable across branches racing in Promise.all.
    async function offersAfterOneTick(events: Event[]) {
      const offered: (string | null)[] = [];
      const consumer = new EventsConsumer(events, {
        onUnconsumedEvent: vi.fn(),
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      });
      consumer.subscribe((event) => {
        offered.push(event === null ? null : event.id);
        return event === null
          ? EventConsumerResult.NotConsumed
          : EventConsumerResult.Consumed;
      });
      // subscribe() schedules exactly one nextTick; the walk drains
      // synchronously inside it. One tick must therefore finish either log.
      await waitForNextTick();
      return { offered, index: consumer.eventIndex, total: events.length };
    }

    const clean = await offersAfterOneTick([
      logEvent('wait_created', 'w1'),
      logEvent('wait_completed', 'w2'),
    ]);
    const sealed = await offersAfterOneTick([
      logEvent('noop' as Event['eventType'], 'n0'),
      logEvent('wait_created', 'w1'),
      logEvent('noop' as Event['eventType'], 'n1'),
      logEvent('noop' as Event['eventType'], 'n2'),
      logEvent('wait_completed', 'w2'),
      logEvent('noop' as Event['eventType'], 'n3'),
    ]);

    expect(clean.index).toBe(clean.total);
    expect(sealed.index).toBe(sealed.total);
    // Identical offer sequences — the noops were never offered at all, and
    // both logs finished inside the same single tick.
    expect(sealed.offered).toEqual(clean.offered);
  });

  it('consumes an all-noop log to the end without divergence', async () => {
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer(
      [
        logEvent('noop' as Event['eventType'], 'n1'),
        logEvent('noop' as Event['eventType'], 'n2'),
      ],
      {
        onUnconsumedEvent,
        getPromiseQueue: () => Promise.resolve(),
        isDeliveryIdle: () => true,
      }
    );
    consumer.subscribe(() => EventConsumerResult.NotConsumed);

    await vi.waitFor(() => {
      expect(consumer.eventIndex).toBe(2);
    });
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
  });

  it('handles a log that ends on a noop', async () => {
    const real = logEvent('wait_created', 'wait-1');
    const noop = logEvent('noop' as Event['eventType'], 'noop-1');
    const onUnconsumedEvent = vi.fn();
    const consumer = new EventsConsumer([real, noop], {
      onUnconsumedEvent,
      getPromiseQueue: () => Promise.resolve(),
      isDeliveryIdle: () => true,
    });
    const reals = consumerFor(['wait-1']);
    consumer.subscribe(reals.callback);

    await vi.waitFor(() => {
      expect(reals.seen).toEqual(['wait-1']);
    });
    expect(consumer.eventIndex).toBe(2);
    expect(onUnconsumedEvent).not.toHaveBeenCalled();
  });
});
