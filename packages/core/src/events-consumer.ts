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
   * callback, indicating an orphaned or invalid event in the event log. The
   * check is deferred until after the promise queue has drained, ensuring that
   * any pending async work (e.g., deserialization/decryption) completes and
   * downstream subscribe() calls have a chance to cancel the check first.
   */
  onUnconsumedEvent: (event: Event) => void;
  /**
   * Returns the current promise queue. The unconsumed event check is chained
   * onto this queue so it only fires after all pending async work (e.g.,
   * deserialization) has completed. This prevents false positives when async
   * deserialization delays the resolve() that triggers the next subscribe().
   */
  getPromiseQueue: () => Promise<void>;
}

export class EventsConsumer {
  eventIndex: number;
  readonly events: Event[] = [];
  readonly callbacks: EventConsumerCallback[] = [];
  private onUnconsumedEvent: (event: Event) => void;
  private getPromiseQueue: () => Promise<void>;
  private pendingUnconsumedCheck: Promise<void> | null = null;
  private pendingUnconsumedTimeout: ReturnType<typeof setTimeout> | null = null;
  private unconsumedCheckVersion = 0;

  constructor(events: Event[], options: EventsConsumerOptions) {
    this.events = events;
    this.eventIndex = 0;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.getPromiseQueue = options.getPromiseQueue;
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
    // Cancel any pending unconsumed check since a new callback may consume the event.
    // Incrementing the version causes any in-flight promise chain check to no-op.
    // Also clear the pending setTimeout if it hasn't fired yet.
    if (this.pendingUnconsumedCheck !== null) {
      this.unconsumedCheckVersion++;
      this.pendingUnconsumedCheck = null;
      if (this.pendingUnconsumedTimeout !== null) {
        clearTimeout(this.pendingUnconsumedTimeout);
        this.pendingUnconsumedTimeout = null;
      }
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
    // schedule a deferred check. We chain onto the promiseQueue so that any
    // pending async work (e.g., deserialization/decryption that triggers
    // resolve() → user code → subscribe()) completes first. If the event
    // is still unconsumed after the queue drains, it's truly orphaned.
    if (currentEvent !== null) {
      const checkVersion = ++this.unconsumedCheckVersion;
      this.pendingUnconsumedCheck = this.getPromiseQueue().then(() => {
        // Use a delayed setTimeout after the queue drains. The delay must be
        // long enough for promise chains to propagate across the VM boundary
        // (from resolve() in the host context through to the workflow code
        // calling subscribe() in the VM context). Node.js does not guarantee
        // that setTimeout(0) fires after all cross-context microtasks settle,
        // so we use a small but non-zero delay. Any subscribe() call that
        // arrives during this window will cancel the check via version
        // invalidation + clearTimeout.
        this.pendingUnconsumedTimeout = setTimeout(() => {
          this.pendingUnconsumedTimeout = null;
          if (this.unconsumedCheckVersion === checkVersion) {
            this.pendingUnconsumedCheck = null;
            this.onUnconsumedEvent(currentEvent);
          }
        }, 100);
      });
    }
  };
}
