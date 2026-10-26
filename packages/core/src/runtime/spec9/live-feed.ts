import { type Event, eventIdToSlot, type World } from '@workflow/world';
import { runtimeLogger } from '../../logger.js';
import { REPLAY_RESOLVE_DATA } from '../helpers.js';
import {
  getOrchestratorReadTimeoutMs,
  readWithDeadline,
} from './read-deadline.js';

/**
 * Default interval of the orchestrator's log-tail poll while no live push
 * covers the run, in milliseconds: the World has no `events.subscribe`, the
 * subscription failed or ended, or the push showed it missed an event.
 */
export const DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS = 2_000;

/**
 * Interval of the orchestrator's log-tail poll while no live push covers the
 * run (`WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS`, default
 * {@link DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS}). `0` disables polling, which
 * leaves the live feed (when the World has one) and queue wakes.
 */
export function getOrchestratorPollIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS;
}

/**
 * Default interval of the log-tail poll while the World's live push is up,
 * in milliseconds. The poll is then only the safety net for a push that
 * never arrives without any sign: the push is dense and in slot order, and a
 * closed or ended subscription reports itself (see {@link LiveLogFeed}).
 */
export const DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS = 10_000;

/**
 * Interval of the log-tail poll while the live push is up
 * (`WORKFLOW_ORCHESTRATOR_FEED_POLL_INTERVAL_MS`, default
 * {@link DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS}). {@link LiveLogFeed}
 * never polls more often than its interval without a push, so `0` means the
 * same interval as without one.
 */
export function getOrchestratorFeedPollIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKFLOW_ORCHESTRATOR_FEED_POLL_INTERVAL_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS;
}

/**
 * How far the log-tail poll's interval backs off while the live feed is
 * healthy: up to this many times the live-push interval. Each poll that finds
 * nothing the feed had not already delivered doubles the interval; any sign
 * of feed trouble puts it back at the interval without a push.
 */
export const ORCHESTRATOR_POLL_MAX_BACKOFF_FACTOR = 2;

/** Default of {@link getOrchestratorLingerMs}, in milliseconds. */
export const DEFAULT_ORCHESTRATOR_LINGER_MS = 30_000;

/**
 * How long an orchestrator delivery stays live after its last pass found
 * nothing to run, while the run still waits on work done elsewhere: an open
 * hook or a background step (`WORKFLOW_ORCHESTRATOR_LINGER_MS`, default
 * {@link DEFAULT_ORCHESTRATOR_LINGER_MS}). Every event another writer appends
 * in that time starts a new pass in the same delivery, and the next pass that
 * finds nothing to run starts the time again, so a burst of resumes or step
 * outcomes is handled by one warm invocation instead of one queued wake each.
 * Only taken on a World with a live feed (`events.subscribe`): without one,
 * waiting costs a function held open for a poll's latency. Any open hook is
 * enough to take it (see `awaitsExternalWork`), so a run with a long-lived
 * hook holds each of its deliveries this long after its last pass. `0`
 * disables it.
 */
export function getOrchestratorLingerMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKFLOW_ORCHESTRATOR_LINGER_MS;
  if (raw === undefined || raw === '') return DEFAULT_ORCHESTRATOR_LINGER_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_ORCHESTRATOR_LINGER_MS;
}

/**
 * Feeds the events other writers append to a run into a live orchestrator,
 * in slot order and without gaps.
 *
 * Two sources: the World's optional `events.subscribe` push, and a poll of
 * the log tail. An event is accepted only when it occupies exactly the next
 * slot after the last accepted one, so a late, duplicated or out-of-order
 * push is dropped and the poll fills in. Correctness never depends on the
 * push.
 *
 * The poll is the safety net for a push that never arrives, so it runs at the
 * live-push interval only while the push is demonstrably keeping up: the
 * subscription is live and the previous poll found nothing the push had not
 * already delivered. It starts there when the subscription opens, and each
 * clean poll doubles the interval, up to
 * {@link ORCHESTRATOR_POLL_MAX_BACKOFF_FACTOR} times the live-push interval.
 * A feed error, a failed poll, a poll that delivers an event the push missed,
 * or a pushed event that leaves a gap behind it puts the interval back at the
 * one without a push at once, rescheduling a poll that was due later.
 *
 * What the push can miss without a sign is only the newest event, with
 * nothing pushed after it and the socket still open: a later push would show
 * the gap, and a closed socket or an ended subscription calls `onError`. The
 * capped backoff bounds how long such an event waits for the poll.
 */
export class LiveLogFeed {
  private nextSlot: number;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private stopped = false;
  private cursor: string | null;
  private readonly pending = new Map<number, Event>();
  /** Whether the World's push subscription is live. */
  private feedLive = false;
  /** The interval the next scheduled poll waits. */
  private currentIntervalMs: number;
  /** When the scheduled poll is due, if one is scheduled. */
  private timerDueAtMs: number | undefined;

  constructor(
    private readonly world: Pick<World, 'events'>,
    private readonly runId: string,
    options: {
      /** Highest slot the orchestrator already holds. */
      afterSlot: number;
      /** `events.list` cursor positioned after that slot. */
      cursor: string | null;
      /** Poll interval while no live push covers the run; `0` never polls. */
      pollIntervalMs: number;
      /**
       * Poll interval while the live push is up. Never below
       * `pollIntervalMs`; defaults to it.
       */
      feedPollIntervalMs?: number;
      onEvents: (events: Event[]) => void;
    }
  ) {
    this.nextSlot = options.afterSlot + 1;
    this.cursor = options.cursor;
    this.pollIntervalMs = options.pollIntervalMs;
    this.feedPollIntervalMs = Math.max(
      options.feedPollIntervalMs ?? 0,
      options.pollIntervalMs
    );
    this.currentIntervalMs = options.pollIntervalMs;
    this.onEvents = options.onEvents;
  }

  /** The interval the next scheduled poll waits, in milliseconds. */
  get nextPollIntervalMs(): number {
    return this.currentIntervalMs;
  }

  private readonly pollIntervalMs: number;
  private readonly feedPollIntervalMs: number;
  private readonly onEvents: (events: Event[]) => void;

  start(): void {
    const subscribe = this.world.events.subscribe;
    if (subscribe) {
      // Live until `onError` (which may run synchronously) or a throw says
      // otherwise.
      this.feedLive = true;
      try {
        this.unsubscribe = subscribe.call(
          this.world.events,
          this.runId,
          this.nextSlot - 1,
          (event) => this.offer([event], 'push'),
          {
            onError: (error) => {
              this.feedLive = false;
              this.feedTrouble();
              runtimeLogger.debug('Live event feed stopped; polling only', {
                workflowRunId: this.runId,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          }
        );
      } catch (error) {
        this.feedLive = false;
        runtimeLogger.debug('Live event feed unavailable; polling only', {
          workflowRunId: this.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (this.feedLive) this.currentIntervalMs = this.feedPollIntervalMs;
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    this.feedLive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDueAtMs = undefined;
  }

  /**
   * Poll once now, outside the schedule. Each page read runs under the
   * orchestrator's read deadline, once: a poll that runs out of time ends,
   * and the next scheduled one asks again from the same cursor, instead of
   * one held read stopping every later poll.
   */
  async pollNow(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    let clean = this.feedLive;
    try {
      let hasMore = true;
      while (hasMore && !this.stopped) {
        const cursor = this.cursor ?? undefined;
        const page = await readWithDeadline(
          (signal) =>
            this.world.events.list({
              runId: this.runId,
              pagination: { sortOrder: 'asc', cursor },
              resolveData: REPLAY_RESOLVE_DATA,
              ...(signal ? { signal } : {}),
            }),
          {
            timeoutMs: getOrchestratorReadTimeoutMs(),
            attempts: 1,
            label: 'Live event feed poll',
            runId: this.runId,
          }
        );
        this.cursor = page.cursor ?? this.cursor;
        hasMore = page.hasMore;
        // An event only the poll delivered is one the push missed.
        if (this.offer(page.data, 'poll') > 0) clean = false;
      }
    } catch (error) {
      clean = false;
      runtimeLogger.debug('Live event feed poll failed', {
        workflowRunId: this.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
    if (clean && this.feedLive && this.pending.size === 0) {
      this.currentIntervalMs = Math.min(
        this.currentIntervalMs * 2,
        this.feedPollIntervalMs * ORCHESTRATOR_POLL_MAX_BACKOFF_FACTOR
      );
    } else {
      this.currentIntervalMs = this.pollIntervalMs;
    }
  }

  private schedulePoll(delayMs = this.currentIntervalMs): void {
    if (this.stopped || this.pollIntervalMs <= 0) return;
    this.timerDueAtMs = Date.now() + delayMs;
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      this.timerDueAtMs = undefined;
      await this.pollNow();
      this.schedulePoll();
    }, delayMs);
    // Never keep a process alive for the poll alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Back to the interval without a push: the push may be missing events. A poll
   * scheduled later than one interval from now is moved up to it; one in
   * flight schedules the next at the configured interval when it ends.
   */
  private feedTrouble(): void {
    this.currentIntervalMs = this.pollIntervalMs;
    if (
      this.timer === undefined ||
      this.timerDueAtMs === undefined ||
      this.timerDueAtMs <= Date.now() + this.pollIntervalMs
    ) {
      return;
    }
    clearTimeout(this.timer);
    this.schedulePoll(this.pollIntervalMs);
  }

  /** Accepts what continues the slot sequence; returns how many it passed on. */
  private offer(events: readonly Event[], source: 'push' | 'poll'): number {
    if (this.stopped) return 0;
    for (const event of events) {
      const slot = eventIdToSlot(event.eventId);
      if (slot === null || slot < this.nextSlot) continue;
      this.pending.set(slot, event);
    }
    const ready: Event[] = [];
    let next = this.pending.get(this.nextSlot);
    while (next !== undefined) {
      ready.push(next);
      this.pending.delete(this.nextSlot);
      this.nextSlot++;
      next = this.pending.get(this.nextSlot);
    }
    // A pushed event above a gap: the push skipped a slot.
    if (source === 'push' && this.pending.size > 0) this.feedTrouble();
    if (ready.length > 0) this.onEvents(ready);
    return ready.length;
  }
}
