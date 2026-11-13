import type { Event, EventsSubscribeOptions } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import { LOCAL_QUEUE_CONCURRENCY } from '../config.js';
import type { Store } from './store.js';

/**
 * How often a subscribed run's log is checked for events this process did
 * not write itself (another process sharing the database, or a write path
 * that does not notify). One indexed read per run per interval.
 */
const TAIL_CHECK_INTERVAL_MS = 50;

/**
 * The most subscriptions a process keeps live at once, as world-postgres caps
 * its feed. While its feed is live, a spec 9 orchestrator with nothing left to
 * run lingers on it, holding a queue slot; the cap keeps lingering deliveries
 * from taking every slot while their own steps wait for one. A subscription
 * past it is refused, and its orchestrator polls the log instead.
 */
export const DEFAULT_MAX_LIVE_SUBSCRIPTIONS =
  LOCAL_QUEUE_CONCURRENCY < 2 ? 0 : Math.floor(LOCAL_QUEUE_CONCURRENCY / 2);

interface Subscriber {
  nextSlot: number;
  onEvent: (event: Event) => void;
  onError?: (error: unknown) => void;
  closed: boolean;
}

/**
 * `events.subscribe` for the Local World. Every subscriber reads the log from
 * the slot after the last one it was given, so delivery is in slot order,
 * gapless and at most once per slot, whatever triggered the read. Writes made
 * through this process notify at once; anything else is picked up by a short
 * tail check while the run has subscribers.
 */
export function createLiveFeed(
  store: Store,
  maxLiveSubscriptions = DEFAULT_MAX_LIVE_SUBSCRIPTIONS
) {
  const subscribers = new Map<string, Set<Subscriber>>();
  let liveCount = 0;
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const scheduled = new Set<string>();

  function deliver(runId: string): void {
    const subs = subscribers.get(runId);
    if (!subs || subs.size === 0) return;
    let top: number;
    try {
      top = store.topSeq(runId);
    } catch (error) {
      for (const sub of [...subs]) fail(runId, sub, error);
      return;
    }
    for (const sub of [...subs]) deliverTo(runId, sub, top);
  }

  /** Hands `sub` the events from its next slot through `top`. */
  function deliverTo(runId: string, sub: Subscriber, top: number): void {
    if (sub.closed || sub.nextSlot > top) return;
    let events: Event[];
    try {
      events = store.eventsBetween(runId, sub.nextSlot - 1, top + 1);
    } catch (error) {
      fail(runId, sub, error);
      return;
    }
    for (const event of events) {
      if (sub.closed) return;
      const slot = eventIdToSlot(event.eventId);
      if (slot === null || slot < sub.nextSlot) continue;
      sub.nextSlot = slot + 1;
      try {
        sub.onEvent(event);
      } catch {
        // A subscriber's failure is its own; the feed keeps delivering.
      }
    }
  }

  function fail(runId: string, sub: Subscriber, error: unknown): void {
    if (!remove(runId, sub)) return;
    try {
      sub.onError?.(error);
    } catch {
      // The subscriber's own failure.
    }
  }

  /** Ends a subscription. Returns whether it was still live. */
  function remove(runId: string, sub: Subscriber): boolean {
    sub.closed = true;
    const subs = subscribers.get(runId);
    if (!subs?.delete(sub)) return false;
    liveCount--;
    if (subs.size > 0) return true;
    subscribers.delete(runId);
    const timer = timers.get(runId);
    if (timer) clearInterval(timer);
    timers.delete(runId);
    return true;
  }

  /** Called after a write to `runId`'s log commits. */
  function notify(runId: string | null | undefined): void {
    if (!runId || !subscribers.has(runId) || scheduled.has(runId)) return;
    // After the caller's own continuation, so a write's result reaches the
    // writer before the feed delivers its event.
    scheduled.add(runId);
    queueMicrotask(() => {
      scheduled.delete(runId);
      deliver(runId);
    });
  }

  return {
    notify,

    /**
     * Ends `runId`'s subscriptions through their `onError`. A lingering
     * delivery whose feed ends stops lingering, so this releases the run's
     * queue gate to a message waiting behind it (see `createQueue`'s
     * `onBlockedOrchestratorMessage`).
     */
    interrupt(runId: string, reason: string): void {
      const subs = subscribers.get(runId);
      if (!subs) return;
      const error = new Error(reason);
      for (const sub of [...subs]) fail(runId, sub, error);
    },

    subscribe(
      runId: string,
      afterSlot: number,
      onEvent: (event: Event) => void,
      options?: EventsSubscribeOptions
    ): () => void {
      if (liveCount >= maxLiveSubscriptions) {
        const reason =
          maxLiveSubscriptions <= 0
            ? 'Live run event feeds are off in this process: it has a single queue slot, which a lingering delivery would hold'
            : `This process already holds ${maxLiveSubscriptions} live run event feeds`;
        // Never synchronously: the caller has not received its unsubscribe
        // function yet.
        queueMicrotask(() => {
          try {
            options?.onError?.(new Error(reason));
          } catch {
            // The subscriber's own failure.
          }
        });
        return () => {};
      }
      const sub: Subscriber = {
        nextSlot: afterSlot + 1,
        onEvent,
        onError: options?.onError,
        closed: false,
      };
      let subs = subscribers.get(runId);
      if (!subs) {
        subs = new Set();
        subscribers.set(runId, subs);
      }
      subs.add(sub);
      liveCount++;
      if (!timers.has(runId)) {
        const timer = setInterval(() => deliver(runId), TAIL_CHECK_INTERVAL_MS);
        timer.unref?.();
        timers.set(runId, timer);
      }
      // Whatever is already above `afterSlot` is delivered on the next tick.
      notify(runId);
      return () => {
        remove(runId, sub);
      };
    },
  };
}
