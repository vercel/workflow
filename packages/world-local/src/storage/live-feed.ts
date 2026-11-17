import type { Event, EventsSubscribeOptions } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import type { BlockedRuns } from '../blocked-runs.js';
import { LOCAL_QUEUE_CONCURRENCY } from '../config.js';
import type { Store } from './store.js';

/**
 * How often the subscribed runs' logs are checked for events this process
 * did not write (another process sharing the database). One indexed read
 * for all subscribed runs per interval.
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

const BLOCKED_REASON = 'An orchestrator message is waiting for this run';

export interface LiveFeedOptions {
  /** Defaults to {@link DEFAULT_MAX_LIVE_SUBSCRIPTIONS}. */
  maxLiveSubscriptions?: number;
  /**
   * Runs with a message waiting that a lingering delivery would hold up:
   * their subscriptions end when they become blocked, and new ones are
   * refused while they stay blocked.
   */
  blockedRuns?: BlockedRuns;
}

interface Subscriber {
  nextSlot: number;
  onEvent: (event: Event) => void;
  onError?: (error: unknown) => void;
  closed: boolean;
}

/**
 * `events.subscribe` for the Local World. Every subscriber reads the log from
 * the slot after the last one it was given, so delivery is in slot order,
 * gapless and at most once per slot, whatever triggered the read. An event
 * this process appends is delivered once its transaction commits (see
 * `notify`); anything else is picked up by a shared tail check while any run
 * has subscribers.
 */
export function createLiveFeed(store: Store, options: LiveFeedOptions = {}) {
  const maxLiveSubscriptions =
    options.maxLiveSubscriptions ?? DEFAULT_MAX_LIVE_SUBSCRIPTIONS;
  const subscribers = new Map<string, Set<Subscriber>>();
  const scheduled = new Set<string>();
  let liveCount = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stopBlockedListener = options.blockedRuns?.onBlocked((runId) =>
    interrupt(runId, BLOCKED_REASON)
  );

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

  /** Reads the top of every subscribed run's log at once. */
  function tailCheck(): void {
    const runIds = [...subscribers.keys()];
    if (runIds.length === 0) return;
    let tops: Map<string, number>;
    try {
      tops = store.topSeqs(runIds);
    } catch (error) {
      for (const runId of runIds) failRun(runId, error);
      return;
    }
    for (const runId of runIds) {
      const top = tops.get(runId) ?? 0;
      for (const sub of [...(subscribers.get(runId) ?? [])]) {
        deliverTo(runId, sub, top);
      }
    }
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

  function failRun(runId: string, error: unknown): void {
    for (const sub of [...(subscribers.get(runId) ?? [])]) {
      fail(runId, sub, error);
    }
  }

  /** Ends `runId`'s subscriptions through their `onError`. */
  function interrupt(runId: string, reason: string): void {
    if (subscribers.has(runId)) failRun(runId, new Error(reason));
  }

  /** Ends a subscription. Returns whether it was still live. */
  function remove(runId: string, sub: Subscriber): boolean {
    sub.closed = true;
    const subs = subscribers.get(runId);
    if (!subs?.delete(sub)) return false;
    liveCount--;
    if (subs.size === 0) subscribers.delete(runId);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    return true;
  }

  /** Refuses a subscription through its `onError`. */
  function refuse(
    reason: string,
    onError: ((error: unknown) => void) | undefined
  ): () => void {
    // Never synchronously: the caller has not received its unsubscribe
    // function yet.
    queueMicrotask(() => {
      try {
        onError?.(new Error(reason));
      } catch {
        // The subscriber's own failure.
      }
    });
    return () => {};
  }

  /**
   * Called when this process appends to `runId`'s log. Reads in a microtask:
   * a World transaction never awaits, so the append has committed (or rolled
   * back) by then, and a burst of appends to one run is read once. The feed
   * may deliver an event before the writer's own call returns.
   */
  function notify(runId: string | null | undefined): void {
    if (!runId || !subscribers.has(runId) || scheduled.has(runId)) return;
    scheduled.add(runId);
    queueMicrotask(() => {
      scheduled.delete(runId);
      deliver(runId);
    });
  }

  return {
    notify,

    subscribe(
      runId: string,
      afterSlot: number,
      onEvent: (event: Event) => void,
      subscribeOptions?: EventsSubscribeOptions
    ): () => void {
      const onError = subscribeOptions?.onError;
      if (closed) return refuse('The World is closed', onError);
      if (options.blockedRuns?.isBlocked(runId)) {
        return refuse(BLOCKED_REASON, onError);
      }
      if (liveCount >= maxLiveSubscriptions) {
        return refuse(
          maxLiveSubscriptions <= 0
            ? 'Live run event feeds are off in this process: it has a single queue slot, which a lingering delivery would hold'
            : `This process already holds ${maxLiveSubscriptions} live run event feeds`,
          onError
        );
      }
      const sub: Subscriber = {
        nextSlot: afterSlot + 1,
        onEvent,
        onError,
        closed: false,
      };
      let subs = subscribers.get(runId);
      if (!subs) {
        subs = new Set();
        subscribers.set(runId, subs);
      }
      subs.add(sub);
      liveCount++;
      if (!timer) {
        timer = setInterval(tailCheck, TAIL_CHECK_INTERVAL_MS);
        timer.unref?.();
      }
      // Whatever is already above `afterSlot` is delivered on the next tick.
      notify(runId);
      return () => {
        remove(runId, sub);
      };
    },

    /** Ends every subscription and refuses new ones. For `world.close()`. */
    close(): void {
      if (closed) return;
      closed = true;
      stopBlockedListener?.();
      const error = new Error('The World is closed');
      for (const runId of [...subscribers.keys()]) failRun(runId, error);
    },
  };
}
