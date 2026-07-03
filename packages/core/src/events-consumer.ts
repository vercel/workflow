import { type Event, envNumber } from '@workflow/world';
import { eventsLogger } from './logger.js';

/**
 * Delay before firing the deferred unconsumed-event check after the promise
 * queue has drained. Must be long enough for cross-VM microtask chains to
 * propagate (resolve in host → workflow code in VM → subscribe call back
 * in host). Any subscribe() arriving during this window cancels the check.
 */
export const DEFERRED_CHECK_DELAY_MS = 100;

/**
 * Effective deferred-check delay. Override: `WORKFLOW_DEFERRED_CHECK_DELAY_MS`.
 *
 * Unlike the other timing knobs this is not a polling interval but a
 * determinism safety margin: firing the unconsumed-event check before the
 * cross-VM subscribe() chain has landed rejects a healthy run with
 * `ReplayDivergenceError`. Floored at 10ms so a too-low override can't
 * manufacture spurious divergence (each false positive burns a
 * divergence-recovery retry and can escalate to a terminal
 * `CorruptedEventLogError`).
 */
const getDeferredCheckDelayMs = (): number =>
  envNumber('WORKFLOW_DEFERRED_CHECK_DELAY_MS', DEFERRED_CHECK_DELAY_MS, {
    integer: true,
    min: 10,
  });

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
   * Callback invoked after an event has been consumed. Consumers such as the
   * deterministic workflow clock must not observe events that are merely
   * inspected while waiting for user code to subscribe to the next operation.
   */
  onConsumedEvent?: (event: Event) => void;
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
  private onConsumedEvent?: (event: Event) => void;
  private onUnconsumedEvent: (event: Event) => void;
  private getPromiseQueue: () => Promise<void>;
  private pendingUnconsumedCheck: Promise<void> | null = null;
  private pendingUnconsumedTimeout: ReturnType<typeof setTimeout> | null = null;
  private unconsumedCheckVersion = 0;

  constructor(events: Event[], options: EventsConsumerOptions) {
    this.events = events;
    this.eventIndex = 0;
    this.onConsumedEvent = options.onConsumedEvent;
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

  private notifyConsumedEvent(event: Event) {
    if (!this.onConsumedEvent) {
      return;
    }
    try {
      this.onConsumedEvent(event);
    } catch (error) {
      eventsLogger.error('onConsumedEvent callback threw an error', {
        error,
      });
    }
  }

  private consume = () => {
    // Drain consecutively consumable events synchronously within a single
    // pass instead of paying one `process.nextTick` per consumed event.
    //
    // Why this is safe: a callback only consumes an event using a consumer
    // that is ALREADY registered (e.g. a long-lived step consumer walking
    // `step_created` → `step_started` → `step_completed`, or the structural
    // lifecycle consumer). New consumers are only ever registered by workflow
    // VM body code that runs asynchronously off `ctx.promiseQueue` after a
    // delivery `resolve()`; none of the callbacks here call `subscribe()`
    // synchronously. So within one pass `this.callbacks` is mutated only by
    // this loop (the `Finished` splice), and the next event's consumer is
    // either already present (advance now) or not yet registered — in which
    // case no callback consumes the event and we fall through to the
    // cross-VM-safe deferred unconsumed-event check below, exactly as before.
    while (true) {
      const currentEvent = this.events[this.eventIndex] ?? null;
      if (!this.consumeOne(currentEvent)) {
        // No callback consumed the current event; handle the terminal case.
        this.handleUnconsumed(currentEvent);
        return;
      }
      // A real event was consumed — advance to the next in the same pass. A
      // consumed `null` sentinel never returns true (see consumeOne), so the
      // synchronous drain can't spin past the end of the log.
    }
  };

  /**
   * Offer `currentEvent` to each registered callback in turn. Returns true
   * when a callback consumed a real (non-null) event and the drain should
   * advance to the next event in the same synchronous pass; false otherwise
   * (nothing consumed it, or the consumed event was the end-of-events
   * sentinel).
   */
  private consumeOne(currentEvent: Event | null): boolean {
    for (let i = 0; i < this.callbacks.length; i++) {
      const callback = this.callbacks[i];
      let handled = EventConsumerResult.NotConsumed;
      try {
        handled = callback(currentEvent);
      } catch (error) {
        eventsLogger.error('EventConsumer callback threw an error', { error });
      }
      if (
        handled !== EventConsumerResult.Consumed &&
        handled !== EventConsumerResult.Finished
      ) {
        continue;
      }
      if (currentEvent !== null) {
        this.notifyConsumedEvent(currentEvent);
      }
      // consumer handled this event, so increase the event index
      this.eventIndex++;
      // remove the callback if it has finished
      if (handled === EventConsumerResult.Finished) {
        this.callbacks.splice(i, 1);
      }
      // Continue draining only for real events. Real consumers return
      // NotConsumed for the `null` sentinel, but guard against a pathological
      // callback consuming it so the drain never spins past end-of-log.
      return currentEvent !== null;
    }
    return false;
  }

  private handleUnconsumed(currentEvent: Event | null) {
    // All callbacks returned NotConsumed for the current event.
    // If the current event is non-null (a real event, not end-of-events),
    // schedule a deferred check. We chain onto the promiseQueue so that any
    // pending async work (e.g., deserialization/decryption that triggers
    // resolve() → user code → subscribe()) completes first. If the event
    // is still unconsumed after the queue drains, it's truly orphaned.
    if (currentEvent !== null) {
      const checkVersion = ++this.unconsumedCheckVersion;
      this.pendingUnconsumedCheck = this.getPromiseQueue()
        .then(
          // Yield once after the first queue drain so promise chains resumed by
          // that drain can run across the VM boundary and append any follow-up
          // async work (for example: step_completed resolves -> for-await loop
          // resumes -> the next hook payload starts hydrating).
          () => new Promise<void>((resolve) => setTimeout(resolve, 0))
        )
        .then(() => this.getPromiseQueue())
        .then(() => {
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
          }, getDeferredCheckDelayMs());
        });
    }
  }
}
