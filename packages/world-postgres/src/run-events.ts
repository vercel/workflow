import type {
  Event,
  EventListResponse,
  EventsSubscribeOptions,
  ListEventsParams,
} from '@workflow/world';
import { eventIdToSlot, slotToEventId } from '@workflow/world';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { DrizzleHandle } from './drizzle/index.js';
import { listenChannel } from './streamer.js';

/**
 * The live event feed of a spec 9 run (`events.subscribe`), on Postgres
 * `LISTEN`/`NOTIFY`.
 *
 * Every committed event write of a spec 9 run announces the run on
 * {@link RUN_EVENTS_TOPIC} (see {@link announceRunEvents}). A subscription
 * listens on one connection shared by the process and, for each announcement
 * of its run, reads the log from the slot after the last one it delivered and
 * delivers what continues the sequence, in slot order, each slot once. The
 * notification is a signal only: what is delivered is always read from the
 * table, so a duplicated, merged or reordered `NOTIFY` changes nothing, and a
 * position not committed yet (a hole) stops delivery until a later
 * announcement fills it.
 *
 * The feed is best effort, as the World contract allows: a dropped `LISTEN`
 * connection, or a failed read, ends every subscription it affects through
 * `onError`, and the runtime falls back to its log-tail poll. A lost
 * announcement (the writer's process died between its commit and its
 * `NOTIFY`) is found by the next announcement of the run, or by that poll.
 */

/** `NOTIFY` channel carrying the run ids of committed spec 9 event writes. */
export const RUN_EVENTS_TOPIC = 'workflow_run_events';

/**
 * How long a failed `LISTEN` attempt keeps new subscriptions failing before
 * the next one tries again, as for the run-status listener.
 */
const LISTEN_RETRY_BACKOFF_MS = 5_000;

/** Events one read of a subscription asks for. */
const READ_PAGE_SIZE = 200;

/**
 * Announce a committed event write of a spec 9 run to its live feed.
 *
 * Best effort and never awaited by the write: a lost announcement costs a
 * subscriber the runtime's poll interval and nothing else. Called after the
 * write's transaction committed, outside it, like the run-terminal `NOTIFY`:
 * a `NOTIFY` inside the write's transaction could fail the write itself.
 */
export function announceRunEvents(drizzle: DrizzleHandle, runId: string): void {
  void Promise.resolve()
    .then(() =>
      drizzle.execute(sql`SELECT pg_notify(${RUN_EVENTS_TOPIC}, ${runId})`)
    )
    .catch(() => {
      // Intentionally ignored. See above.
    });
}

type ReadEvents = (params: ListEventsParams) => Promise<EventListResponse>;

export interface RunEventsFeedOptions {
  /**
   * The most subscriptions this process keeps live at once. A subscription
   * past it fails at once (through `onError`), and its orchestrator polls the
   * log instead. While its feed is live, a spec 9 orchestrator with nothing
   * left to run lingers on it (`WORKFLOW_ORCHESTRATOR_LINGER_MS`), holding a
   * Graphile worker slot; the cap keeps lingering deliveries from taking
   * every slot of the process while their own background steps wait for one.
   * `0` turns the feed off: every subscription is refused.
   */
  maxLiveSubscriptions: number;
}

export interface RunEventsFeed {
  subscribe(
    runId: string,
    afterSlot: number,
    onEvent: (event: Event) => void,
    options: EventsSubscribeOptions | undefined,
    read: ReadEvents
  ): () => void;
  /** Ends every subscription and the shared `LISTEN` connection. */
  close(): Promise<void>;
}

interface Subscription {
  readonly runId: string;
  /** The highest slot delivered (or the subscription's `afterSlot`). */
  lastSlot: number;
  reading: boolean;
  /** An announcement arrived while a read was in flight. */
  dirty: boolean;
  closed: boolean;
  readonly onEvent: (event: Event) => void;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly read: ReadEvents;
}

export function createRunEventsFeed(
  pool: Pool,
  options: RunEventsFeedOptions
): RunEventsFeed {
  const byRun = new Map<string, Set<Subscription>>();
  let liveCount = 0;
  let listener: Promise<{ close: () => Promise<void> }> | undefined;
  /** Whether the shared `LISTEN` connection is up. */
  let connected = false;
  let retryListenAfter = 0;
  let closed = false;

  const remove = (subscription: Subscription): void => {
    if (subscription.closed) return;
    subscription.closed = true;
    liveCount--;
    const set = byRun.get(subscription.runId);
    set?.delete(subscription);
    if (set?.size === 0) byRun.delete(subscription.runId);
  };

  /** Ends a subscription for a transport reason and tells its caller. */
  const fail = (subscription: Subscription, error: unknown): void => {
    if (subscription.closed) return;
    remove(subscription);
    try {
      subscription.onError?.(error);
    } catch {
      // The caller's callback must not break the feed.
    }
  };

  const failAll = (error: unknown): void => {
    for (const set of [...byRun.values()]) {
      for (const subscription of [...set]) fail(subscription, error);
    }
  };

  /** Reads and delivers what continues the subscription's slot sequence. */
  const catchUp = async (subscription: Subscription): Promise<void> => {
    if (subscription.closed) return;
    if (subscription.reading) {
      subscription.dirty = true;
      return;
    }
    subscription.reading = true;
    try {
      let more = true;
      while (more && !subscription.closed) {
        subscription.dirty = false;
        const page = await subscription.read({
          runId: subscription.runId,
          pagination: {
            sortOrder: 'asc',
            limit: READ_PAGE_SIZE,
            ...(subscription.lastSlot >= 1
              ? { cursor: slotToEventId(subscription.lastSlot) }
              : {}),
          },
          resolveData: 'all',
        });
        let contiguous = true;
        for (const event of page.data) {
          if (subscription.closed) return;
          const slot = eventIdToSlot(event.eventId);
          if (slot === null || slot <= subscription.lastSlot) continue;
          // A position not committed yet: wait for the announcement that
          // fills it rather than deliver past it.
          if (slot !== subscription.lastSlot + 1) {
            contiguous = false;
            break;
          }
          subscription.lastSlot = slot;
          subscription.onEvent(event);
        }
        more = subscription.dirty || (contiguous && page.hasMore);
      }
    } catch (error) {
      fail(subscription, error);
    } finally {
      subscription.reading = false;
    }
  };

  const onAnnouncement = async (runId: string): Promise<void> => {
    const set = byRun.get(runId);
    if (!set) return;
    for (const subscription of set) void catchUp(subscription);
  };

  /** The shared `LISTEN` connection, opened on the first subscription. */
  const ensureListening = ():
    | Promise<{ close: () => Promise<void> }>
    | undefined => {
    if (listener) return listener;
    if (closed || Date.now() < retryListenAfter) return undefined;
    const opening = listenChannel(pool, RUN_EVENTS_TOPIC, onAnnouncement, {
      onDisconnect: () => {
        connected = false;
        failAll(new Error(`LISTEN ${RUN_EVENTS_TOPIC} connection lost`));
      },
      onReconnect: () => {
        connected = !closed;
      },
    });
    listener = opening;
    opening.then(
      () => {
        connected = !closed;
      },
      () => {
        listener = undefined;
        retryListenAfter = Date.now() + LISTEN_RETRY_BACKOFF_MS;
      }
    );
    return opening;
  };

  return {
    subscribe(runId, afterSlot, onEvent, subscribeOptions, read) {
      const subscription: Subscription = {
        runId,
        lastSlot: afterSlot,
        reading: false,
        dirty: false,
        closed: false,
        onEvent,
        onError: subscribeOptions?.onError,
        read,
      };
      const unsubscribe = () => remove(subscription);
      const refuse = (reason: string) => {
        subscription.closed = true;
        // Never synchronously: the caller has not received its
        // unsubscribe function yet.
        queueMicrotask(() => {
          try {
            subscribeOptions?.onError?.(new Error(reason));
          } catch {
            // See `fail`.
          }
        });
        return () => {};
      };
      if (closed) return refuse('The World is closed');
      if (options.maxLiveSubscriptions <= 0) {
        return refuse(
          'Live run event feeds are off in this process: it has a single worker slot, which a lingering delivery would hold'
        );
      }
      if (liveCount >= options.maxLiveSubscriptions) {
        return refuse(
          `This process already holds ${options.maxLiveSubscriptions} live run event feeds`
        );
      }
      const opening = ensureListening();
      if (!opening) return refuse(`LISTEN ${RUN_EVENTS_TOPIC} unavailable`);
      liveCount++;
      let set = byRun.get(runId);
      if (!set) {
        set = new Set();
        byRun.set(runId, set);
      }
      set.add(subscription);
      // Read once the connection listens: anything committed before then
      // was announced to no one.
      opening.then(
        () => {
          if (subscription.closed) return;
          if (!connected) {
            fail(
              subscription,
              new Error(`LISTEN ${RUN_EVENTS_TOPIC} connection lost`)
            );
            return;
          }
          void catchUp(subscription);
        },
        (error) => fail(subscription, error)
      );
      return unsubscribe;
    },

    async close() {
      closed = true;
      connected = false;
      for (const set of [...byRun.values()]) {
        for (const subscription of [...set]) remove(subscription);
      }
      const pending = listener;
      listener = undefined;
      const active = await pending?.catch(() => undefined);
      await active?.close().catch(() => undefined);
    },
  };
}
