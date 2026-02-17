import type { Event } from '@workflow/world';
import { eventsLogger } from './logger.js';

export enum EventConsumerResult {
  /**
   * Callback consumed the event, but should not be removed from the callbacks list
   */
  Consumed,
  /**
   * Callback did not consume the event, so it should be passed to the next callback
   */
  NotConsumed,
  /**
   * Callback consumed the event, and should be removed from the callbacks list
   */
  Finished,
}

type EventConsumerCallback = (event: Event | null) => EventConsumerResult;

export interface EventsConsumerOptions {
  /**
   * Callback invoked when a non-null event cannot be consumed by any registered
   * callback, indicating an orphaned or invalid event in the event log. Called
   * asynchronously after a macrotask delay to allow pending callback
   * subscriptions to settle first.
   */
  onUnconsumedEvent: (event: Event) => void;
}

export class EventsConsumer {
  eventIndex: number;
  readonly events: Event[] = [];
  readonly callbacks: EventConsumerCallback[] = [];
  private onUnconsumedEvent: (event: Event) => void;
  private pendingUnconsumedCheck: ReturnType<typeof setTimeout> | null = null;

  constructor(events: Event[], options: EventsConsumerOptions) {
    this.events = events;
    this.eventIndex = 0;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
  }

  /**
   * Registers a callback function to be called after an event has been consumed
   * by a different callback. The callback can return:
   *  - `EventConsumerResult.Consumed` the event is considered consumed and will not be passed to any other callback, but the callback will remain in the callbacks list
   *  - `EventConsumerResult.NotConsumed` the event is passed to the next callback
   *  - `EventConsumerResult.Finished` the event is considered consumed and the callback is removed from the callbacks list
   *
   * @param fn - The callback function to register.
   */
  subscribe(fn: EventConsumerCallback) {
    this.callbacks.push(fn);
    // Cancel any pending unconsumed check since a new callback may consume the event
    if (this.pendingUnconsumedCheck !== null) {
      clearTimeout(this.pendingUnconsumedCheck);
      this.pendingUnconsumedCheck = null;
    }
    process.nextTick(this.consume);
  }

  private consume = () => {
    const currentEvent = this.events[this.eventIndex] ?? null;
    for (let i = 0; i < this.callbacks.length; i++) {
      const callback = this.callbacks[i];
      let handled = EventConsumerResult.NotConsumed;
      try {
        handled = callback(currentEvent);
      } catch (error) {
        eventsLogger.error('EventConsumer callback threw an error', { error });
      }
      if (
        handled === EventConsumerResult.Consumed ||
        handled === EventConsumerResult.Finished
      ) {
        // consumer handled this event, so increase the event index
        this.eventIndex++;

        // remove the callback if it has finished
        if (handled === EventConsumerResult.Finished) {
          this.callbacks.splice(i, 1);
        }

        // continue to the next event
        process.nextTick(this.consume);
        return;
      }
    }

    // If we reach here, all callbacks returned NotConsumed.
    // If the current event is non-null (a real event, not end-of-events),
    // schedule a deferred check. We use setTimeout (macrotask) so that any
    // pending process.nextTick microtasks (e.g., new subscribes from the
    // workflow code) can complete first. If the event is still unconsumed
    // when the timeout fires, it's truly orphaned.
    if (currentEvent !== null) {
      const unconsumedIndex = this.eventIndex;
      this.pendingUnconsumedCheck = setTimeout(() => {
        this.pendingUnconsumedCheck = null;
        if (this.eventIndex === unconsumedIndex) {
          this.onUnconsumedEvent(currentEvent);
        }
      }, 0);
    }
  };
}
