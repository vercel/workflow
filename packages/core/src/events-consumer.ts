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

export class EventsConsumer {
  eventIndex: number;
  readonly events: Event[] = [];
  readonly callbacks: EventConsumerCallback[] = [];

  constructor(events: Event[]) {
    this.events = events;
    this.eventIndex = 0;

    eventsLogger.debug('EventsConsumer initialized', { events });
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
        // Hopefully shouldn't happen, but we don't want to block the workflow
        console.error('EventConsumer callback threw an error', error);
      }
      eventsLogger.debug('EventConsumer callback result', {
        handled: EventConsumerResult[handled],
        eventIndex: this.eventIndex,
        eventId: currentEvent?.eventId,
      });
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
  };
}
