import type { Event } from '@workflow/world';
import { eventsLogger } from './logger.js';

/**
 * Watchdog ceiling: max time the deferred unconsumed-event check will wait
 * for the VM-idle signal (`isVmIdle` returning true) before forcing a
 * decision. Used purely as a safety net so a lost decrement somewhere in
 * the `pendingVmWork` accounting can't hang a run forever.
 *
 * The primary mechanism for the deferred check is the VM-idle observer
 * (`onceVmIdle`), which fires deterministically when both
 * `pendingDeliveries` and `pendingVmWork` have settled. The previous
 * implementation used a 100 ms wall-clock guess (see `DEFERRED_CHECK_DELAY_MS`
 * below); the counter replaces that. This constant only kicks in if the
 * counter mechanism is broken.
 */
export const UNCONSUMED_CHECK_WATCHDOG_MS = 5000;

/**
 * @deprecated The deferred unconsumed-event check is now driven by the
 * VM-idle counter (`pendingDeliveries` + `pendingVmWork`), not a fixed
 * wall-clock delay. This constant is preserved only for tests that
 * imported it for delay-arithmetic; its value is no longer consulted by
 * runtime code. Use `UNCONSUMED_CHECK_WATCHDOG_MS` for the watchdog
 * ceiling.
 */
export const DEFERRED_CHECK_DELAY_MS = 100;

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
  /**
   * Returns true when both `pendingDeliveries` and `pendingVmWork` are 0 —
   * i.e. the VM has no in-flight network deliveries AND no body-continuation
   * reactions pending. The deferred unconsumed-event check only fires when
   * this is true: an "unconsumed" event observed while the VM is still
   * processing a delivery is almost always a timing artifact, not real
   * corruption.
   *
   * Optional for backwards compatibility with older `WorkflowOrchestratorContext`
   * shapes that don't carry the `pendingVmWork` counter; when omitted, the
   * deferred check falls back to the watchdog-timeout-only behaviour.
   */
  isVmIdle?: () => boolean;
  /**
   * Register a one-shot callback to be fired when the VM becomes idle
   * (both counters reach 0 after a decrement). Used by the deferred check
   * to wait for true idle without polling. Returns an unsubscribe function
   * so the consumer can cancel the registration if a new subscribe()
   * arrives in the meantime (the canonical cancellation pattern).
   */
  onceVmIdle?: (callback: () => void) => () => void;
}

export class EventsConsumer {
  eventIndex: number;
  readonly events: Event[] = [];
  readonly callbacks: EventConsumerCallback[] = [];
  private onUnconsumedEvent: (event: Event) => void;
  private getPromiseQueue: () => Promise<void>;
  private isVmIdle: (() => boolean) | undefined;
  private onceVmIdle: ((cb: () => void) => () => void) | undefined;
  private pendingUnconsumedCheck: Promise<void> | null = null;
  private pendingUnconsumedTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingUnconsumedUnsubscribe: (() => void) | null = null;
  private unconsumedCheckVersion = 0;

  constructor(events: Event[], options: EventsConsumerOptions) {
    this.events = events;
    this.eventIndex = 0;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.getPromiseQueue = options.getPromiseQueue;
    this.isVmIdle = options.isVmIdle;
    this.onceVmIdle = options.onceVmIdle;
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
    // Also clear the pending setTimeout / VM-idle observer if not yet fired.
    if (this.pendingUnconsumedCheck !== null) {
      this.unconsumedCheckVersion++;
      this.pendingUnconsumedCheck = null;
      if (this.pendingUnconsumedTimeout !== null) {
        clearTimeout(this.pendingUnconsumedTimeout);
        this.pendingUnconsumedTimeout = null;
      }
      if (this.pendingUnconsumedUnsubscribe !== null) {
        this.pendingUnconsumedUnsubscribe();
        this.pendingUnconsumedUnsubscribe = null;
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
    // is still unconsumed after the queue drains AND the VM is idle, it's
    // truly orphaned.
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
          if (this.unconsumedCheckVersion !== checkVersion) return;
          this.fireUnconsumedWhenVmIdle(currentEvent, checkVersion);
        });
    }
  };

  /**
   * Fire `onUnconsumedEvent` once the VM has settled, not after a fixed
   * wall-clock delay. "Settled" means both `pendingDeliveries` and
   * `pendingVmWork` are 0 — i.e. the body has finished reacting to any
   * in-flight delivery and any next-wave `subscribe()` calls have had
   * their chance to register.
   *
   * If the consumer wasn't configured with `isVmIdle`/`onceVmIdle` (older
   * orchestrator wiring), fall back to the watchdog timeout only — same
   * behaviour as before, just deferred longer to reduce false positives.
   */
  private fireUnconsumedWhenVmIdle(
    currentEvent: Event,
    checkVersion: number
  ): void {
    // Each re-entry installs a fresh watchdog. Clear any prior one so
    // recursive re-registration (observer fired but VM not yet idle) doesn't
    // leak timers — and so a stale timer can't fire onUnconsumedEvent a
    // second time after a fresh fire/cancel.
    if (this.pendingUnconsumedTimeout !== null) {
      clearTimeout(this.pendingUnconsumedTimeout);
      this.pendingUnconsumedTimeout = null;
    }

    const fire = () => {
      // Idempotency guard: `pendingUnconsumedCheck` is null'd both on
      // successful fire AND when `subscribe()` cancels the check. Combined
      // with the version check below, this prevents stale timers, stale
      // observers, or a leaked recursion path from double-firing
      // `onUnconsumedEvent`.
      if (this.pendingUnconsumedCheck === null) return;
      if (this.unconsumedCheckVersion !== checkVersion) return;
      this.pendingUnconsumedCheck = null;
      if (this.pendingUnconsumedTimeout !== null) {
        clearTimeout(this.pendingUnconsumedTimeout);
        this.pendingUnconsumedTimeout = null;
      }
      if (this.pendingUnconsumedUnsubscribe !== null) {
        this.pendingUnconsumedUnsubscribe();
        this.pendingUnconsumedUnsubscribe = null;
      }
      this.onUnconsumedEvent(currentEvent);
    };

    // Watchdog: under any circumstance, never wait more than
    // UNCONSUMED_CHECK_WATCHDOG_MS. This protects against a stuck
    // `pendingVmWork` counter (e.g. an exception in a delivery's
    // microtask chain).
    this.pendingUnconsumedTimeout = setTimeout(
      fire,
      UNCONSUMED_CHECK_WATCHDOG_MS
    );

    if (this.isVmIdle && this.onceVmIdle) {
      // Fast path: already idle — fire on the next microtask boundary so
      // any subscribe() arriving in the same synchronous tick can still
      // cancel us (preserves prior cancellation semantics).
      if (this.isVmIdle()) {
        queueMicrotask(fire);
        return;
      }
      // Wait for the next VM-idle transition. The observer is single-shot.
      this.pendingUnconsumedUnsubscribe = this.onceVmIdle(() => {
        this.pendingUnconsumedUnsubscribe = null;
        // Re-check idle on a microtask boundary — by the time the observer
        // fires, a new delivery may already have started.
        queueMicrotask(() => {
          if (this.pendingUnconsumedCheck === null) return;
          if (this.unconsumedCheckVersion !== checkVersion) return;
          if (this.isVmIdle?.()) {
            fire();
          } else {
            // New delivery in flight — re-register and wait again.
            this.fireUnconsumedWhenVmIdle(currentEvent, checkVersion);
          }
        });
      });
    }
    // Else: no counter wiring — watchdog timeout will eventually fire.
  }
}
