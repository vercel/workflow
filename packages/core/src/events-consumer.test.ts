import type { Event } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { EventConsumerResult, EventsConsumer } from './events-consumer.js';

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

// Helper function to wait for next tick
function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe('EventsConsumer', () => {
  describe('constructor', () => {
    it('should initialize with provided events', () => {
      const events = [createMockEvent(), createMockEvent({ id: 'event-2' })];
      const consumer = new EventsConsumer(events);

      expect(consumer.events).toEqual(events);
      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toEqual([]);
    });

    it('should initialize with empty events array', () => {
      const consumer = new EventsConsumer([]);

      expect(consumer.events).toEqual([]);
      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toEqual([]);
    });
  });

  describe('subscribe', () => {
    it('should add callback to callbacks array', () => {
      const consumer = new EventsConsumer([]);
      const callback = vi.fn();

      consumer.subscribe(callback);

      expect(consumer.callbacks).toContain(callback);
      expect(consumer.callbacks).toHaveLength(1);
    });

    it('should add multiple callbacks in order', () => {
      const consumer = new EventsConsumer([]);
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
      const consumer = new EventsConsumer([event]);
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
      const consumer = new EventsConsumer([event]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should call callbacks with null when no events exist', async () => {
      const consumer = new EventsConsumer([]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(null);
    });

    it('should increment event index and remove callback when callback returns Finished', async () => {
      const event1 = createMockEvent({ id: 'event-1' });
      const event2 = createMockEvent({ id: 'event-2' });
      const consumer = new EventsConsumer([event1, event2]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(consumer.eventIndex).toBe(1);
      expect(consumer.callbacks).toHaveLength(0);
    });

    it('should not increment event index when callback returns false', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(consumer.eventIndex).toBe(0);
      expect(consumer.callbacks).toContain(callback);
    });

    it('should process multiple callbacks until one returns true', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event]);
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

    it('should process all callbacks when none return true', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event]);
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
    });

    it('should recursively process next event when current event is consumed', async () => {
      const event1 = createMockEvent({ id: 'event-1', sequence_number: 1 });
      const event2 = createMockEvent({ id: 'event-2', sequence_number: 2 });
      const consumer = new EventsConsumer([event1, event2]);
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
      const consumer = new EventsConsumer([event]);
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
      const consumer = new EventsConsumer(events);

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
      const consumer = new EventsConsumer([event]);
      const throwingCallback = vi.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      const normalCallback = vi
        .fn()
        .mockReturnValue(EventConsumerResult.Finished);

      // Mock console.error to avoid noise in test output
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      consumer.subscribe(throwingCallback);
      consumer.subscribe(normalCallback);
      await waitForNextTick();

      expect(throwingCallback).toHaveBeenCalledWith(event);
      expect(normalCallback).toHaveBeenCalledWith(event);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'EventConsumer callback threw an error',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle callback removal during iteration', async () => {
      const event = createMockEvent();
      const consumer = new EventsConsumer([event]);
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
      const consumer = new EventsConsumer([eventWithNullData]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.Finished);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(eventWithNullData);
      expect(consumer.eventIndex).toBe(1);
    });

    it('should handle multiple subscriptions happening in sequence', async () => {
      const event1 = createMockEvent({ id: 'event-1' });
      const event2 = createMockEvent({ id: 'event-2' });
      const consumer = new EventsConsumer([event1, event2]);

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
      const consumer = new EventsConsumer([]);
      const callback = vi.fn().mockReturnValue(EventConsumerResult.NotConsumed);

      consumer.subscribe(callback);
      await waitForNextTick();

      expect(callback).toHaveBeenCalledWith(null);
      expect(consumer.eventIndex).toBe(0);
    });
  });
});
