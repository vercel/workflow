import { withResolvers } from '@workflow/utils';
import type { Event } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import {
  EventConsumerResult,
  EventsConsumer,
  type EventsConsumerOptions,
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

/**
 * Build a `Mocked-idle` options bundle whose VM is always idle and whose
 * `onceVmIdle` fires the callback synchronously. With this wired, the
 * deferred unconsumed-event check takes the fast path (queueMicrotask)
 * instead of falling back to the 5-second watchdog, so the existing
 * unconsumed-event suite runs in ms rather than seconds.
 */
function makeOptions(
  overrides: Partial<EventsConsumerOptions> = {}
): EventsConsumerOptions {
  return {
    onUnconsumedEvent: vi.fn(),
    getPromiseQueue: () => Promise.resolve(),
    isVmIdle: () => true,
    onceVmIdle: (cb) => {
      cb();
      return () => {};
    },
    ...overrides,
  };
}

const defaultOptions = makeOptions();

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
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent: unconsumedReceived.resolve })
      );
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
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent: unconsumedReceived.resolve })
      );
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);

      const unconsumedEvent = await unconsumedReceived.promise;
      expect(unconsumedEvent).toEqual(event);
    });

    it('should NOT call onUnconsumedEvent for null event (end-of-events)', async () => {
      const onUnconsumedEvent = vi.fn();
      const consumer = new EventsConsumer(
        [],
        makeOptions({ onUnconsumedEvent })
      );
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
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent })
      );
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

  describe('fireUnconsumedWhenVmIdle', () => {
    /**
     * Build a controllable VM-idle harness: a flippable `idle` flag and a
     * set of one-shot observers that `flipToIdle()` releases all at once.
     * Tests use this to simulate the production wiring where `pendingVmWork`
     * drops to 0 and `notifyVmIdleObservers` fires the callbacks.
     */
    function makeIdleHarness() {
      let idle = true;
      const observers = new Set<() => void>();
      const options: Partial<EventsConsumerOptions> = {
        isVmIdle: () => idle,
        onceVmIdle: (cb) => {
          observers.add(cb);
          return () => observers.delete(cb);
        },
      };
      return {
        options,
        setBusy: () => {
          idle = false;
        },
        flipToIdle: () => {
          idle = true;
          const fired = Array.from(observers);
          observers.clear();
          for (const cb of fired) cb();
        },
        observerCount: () => observers.size,
      };
    }

    it('fast path: fires onUnconsumedEvent on the next microtask when VM is already idle', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      const harness = makeIdleHarness();
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent, ...harness.options })
      );
      const cb = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
      consumer.subscribe(cb);
      await vi.waitFor(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
      });
      expect(onUnconsumedEvent).toHaveBeenCalledTimes(1);
    });

    it('slow path: waits for VM to become idle before firing', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      const harness = makeIdleHarness();
      harness.setBusy();
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent, ...harness.options })
      );
      const cb = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
      consumer.subscribe(cb);
      // Give the deferred chain time to register on the observer.
      await new Promise((r) => setTimeout(r, 20));
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
      expect(harness.observerCount()).toBe(1);
      harness.flipToIdle();
      await vi.waitFor(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
      });
      expect(onUnconsumedEvent).toHaveBeenCalledTimes(1);
    });

    it('recursion path: when the observer fires but VM is still busy, re-registers and waits again', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      let idle = false;
      const observers = new Set<() => void>();
      const consumer = new EventsConsumer(
        [event],
        makeOptions({
          onUnconsumedEvent,
          isVmIdle: () => idle,
          onceVmIdle: (cb) => {
            observers.add(cb);
            return () => observers.delete(cb);
          },
        })
      );
      const cb = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
      consumer.subscribe(cb);
      await new Promise((r) => setTimeout(r, 20));
      expect(observers.size).toBe(1);

      // Fire the observer but keep `idle === false`. The recursion path
      // should re-register a fresh observer instead of firing.
      const first = Array.from(observers);
      observers.clear();
      for (const o of first) o();
      await new Promise((r) => setTimeout(r, 20));
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
      expect(observers.size).toBe(1);

      // Now actually flip to idle and fire the fresh observer.
      idle = true;
      const second = Array.from(observers);
      observers.clear();
      for (const o of second) o();
      await vi.waitFor(() => {
        expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
      });
      expect(onUnconsumedEvent).toHaveBeenCalledTimes(1);
    });

    it('recursion path: does not leak watchdog timers (no double-fire even if multiple stale timers race)', async () => {
      vi.useFakeTimers();
      try {
        const event = createMockEvent();
        const onUnconsumedEvent = vi.fn();
        let idle = false;
        const observers = new Set<() => void>();
        const consumer = new EventsConsumer(
          [event],
          makeOptions({
            onUnconsumedEvent,
            isVmIdle: () => idle,
            onceVmIdle: (cb) => {
              observers.add(cb);
              return () => observers.delete(cb);
            },
          })
        );
        const cb = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
        consumer.subscribe(cb);
        await vi.advanceTimersByTimeAsync(20);
        expect(observers.size).toBe(1);

        // Force recursion several times while VM stays busy. Each recursion
        // must clear the previous watchdog, otherwise after the watchdog
        // window each leaked timer would fire `onUnconsumedEvent` again.
        for (let i = 0; i < 3; i++) {
          const stale = Array.from(observers);
          observers.clear();
          for (const o of stale) o();
          await vi.advanceTimersByTimeAsync(20);
        }
        expect(onUnconsumedEvent).not.toHaveBeenCalled();

        // Cross the watchdog ceiling. Exactly one fire should land even
        // though three watchdogs were notionally scheduled.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(onUnconsumedEvent).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('watchdog: fires fallback when VM never becomes idle', async () => {
      vi.useFakeTimers();
      try {
        const event = createMockEvent();
        const onUnconsumedEvent = vi.fn();
        const consumer = new EventsConsumer(
          [event],
          makeOptions({
            onUnconsumedEvent,
            isVmIdle: () => false,
            onceVmIdle: () => () => {},
          })
        );
        const cb = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
        consumer.subscribe(cb);
        await vi.advanceTimersByTimeAsync(1000);
        expect(onUnconsumedEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5000);
        expect(onUnconsumedEvent).toHaveBeenCalledWith(event);
        expect(onUnconsumedEvent).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancellation: subscribe between deferred-check schedule and fire cancels the check', async () => {
      const event = createMockEvent();
      const onUnconsumedEvent = vi.fn();
      const harness = makeIdleHarness();
      harness.setBusy();
      const consumer = new EventsConsumer(
        [event],
        makeOptions({ onUnconsumedEvent, ...harness.options })
      );
      const cb1 = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);
      consumer.subscribe(cb1);
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.observerCount()).toBe(1);

      // A late subscriber arrives and consumes the event. The observer
      // should be unsubscribed and the watchdog cleared.
      const cb2 = vi.fn().mockReturnValue(EventConsumerResult.Finished);
      consumer.subscribe(cb2);
      await vi.waitFor(() => {
        expect(consumer.eventIndex).toBe(1);
      });
      expect(harness.observerCount()).toBe(0);

      // Even if the harness flips to idle later, no fire should land.
      harness.flipToIdle();
      await new Promise((r) => setTimeout(r, 50));
      expect(onUnconsumedEvent).not.toHaveBeenCalled();
    });
  });
});
