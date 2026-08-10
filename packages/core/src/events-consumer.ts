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

/**
 * Event types the ordered walk may step over and deliver later.
 *
 * Everything else is replay-origin: a replay emits it, in the order its code
 * reaches it, so its position in the log is the record of what that replay
 * decided. Reaching one of those out of order means this replay decided
 * differently than the log holds, which is divergence and nothing else. The
 * types listed here are written by something outside the replay (a hook
 * delivery, a cancellation) or by a step runner, so they land wherever they
 * land: the replay's code path does not fix where they sit relative to the
 * events around them, and a mismatch there says nothing about divergence.
 *
 * An allowlist rather than the complement of the ordered set, so a type this
 * file has not been taught about keeps the strict old behaviour.
 *
 * `hook_disposed` is deliberately absent despite being about a hook: it is
 * written when the workflow's own `using` scope exits, so it is replay-origin.
 *
 * Two entries are listed by type even though a given instance of them may be
 * replay-origin: `attr_set` is replay-origin when its writer is the workflow,
 * and an inline step's `step_completed` is written by the replay that ran the
 * step. Splitting those out per event was considered and rejected. A replay
 * that reaches one of its own writes out of position has diverged, but a replay
 * that reaches an event it did NOT write, sitting where its own write would go,
 * has not: the writer field says who wrote the event, and not whether this
 * replay is the same one. Guessing wrong in that direction fails healthy runs,
 * which is the failure this file exists to stop, so the whole type is tolerated
 * and the {@link ONE_SHOT_EVENT_TYPES} check catches the case that is decidable
 * (a second resolution for something already resolved). The cost is that a
 * divergence involving these two types surfaces at the end of the replay,
 * through `strandedEvent`, rather than at the offending event.
 */
const PARKABLE_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set([
  'hook_received',
  'hook_conflict',
  'wait_completed',
  'step_started',
  'step_retrying',
  'step_completed',
  'step_failed',
  'attr_set',
  'run_cancelled',
]);

/**
 * Parkable types that can only ever resolve their correlation id once.
 *
 * A second one for the same id is not a delivery this replay has not reached
 * yet: it is a resolution for something already resolved, which no consumer
 * this replay or any later one registers can ever claim. `hook_received` is
 * absent because a hook legitimately fires many times under one id.
 */
const ONE_SHOT_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set([
  'wait_completed',
  'step_completed',
  'step_failed',
]);

/** Identifies the thing a one-shot resolution event resolves. */
function resolutionKey(eventType: string, correlationId: string): string {
  return `${eventType}:${correlationId}`;
}

/**
 * Types that end a run. Once one is in the log, no consumer will ever be
 * registered again, so a parked event still parked here will never be claimed.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set([
  'run_completed',
  'run_failed',
  'run_cancelled',
]);

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
  readonly events: Event[];
  readonly callbacks: EventConsumerCallback[] = [];
  /**
   * Events the ordered walk stepped over because nobody claimed them and their
   * type carries no ordering claim. Each keeps the index it held in the log:
   * consumers read {@link eventIndex} at consumption time to order their
   * delivery against the rest of the log, and a late delivery must still make
   * the claim its position gave it.
   *
   * Held in log order, drained in log order, and drained before every offer so
   * a consumer registered after the walk passed the event still receives it.
   */
  private readonly parked: { event: Event; index: number }[] = [];
  /**
   * Correlation ids of the {@link ONE_SHOT_EVENT_TYPES} events consumed so
   * far, so a second resolution for one of them is recognized as unclaimable
   * rather than parked for a consumer that cannot exist.
   */
  private readonly resolved = new Set<string>();
  private onConsumedEvent?: (event: Event) => void;
  private onUnconsumedEvent: (event: Event) => void;
  private getPromiseQueue: () => Promise<void>;
  private pendingUnconsumedCheck: Promise<void> | null = null;
  private pendingUnconsumedTimeout: ReturnType<typeof setTimeout> | null = null;
  private unconsumedCheckVersion = 0;

  constructor(events: Event[], options: EventsConsumerOptions) {
    // Own copy: the runtime mutates its event array in place, and a retained
    // session must only observe new events through append() so resume()'s
    // strict-extension check stays meaningful.
    this.events = [...events];
    this.eventIndex = 0;
    this.onConsumedEvent = options.onConsumedEvent;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.getPromiseQueue = options.getPromiseQueue;
  }

  /**
   * The oldest event the walk stepped over that no consumer has claimed yet,
   * if any. Parking is a bet that a consumer will be registered later, so at
   * any point where no consumer ever will be again — the replay finishing is
   * the definitive one — this answers which event the bet lost on.
   */
  get strandedEvent(): Event | undefined {
    return this.parked[0]?.event;
  }

  /**
   * What the walk is still holding, or `undefined` when it holds nothing.
   *
   * Read at every point a replay stops, including the suspensions that are not
   * settling points, so the held state reaches telemetry. A replay cannot tell
   * a delivery awaiting a later consumer from one no consumer will ever
   * register, so it reports rather than decides: the same `eventId` reported on
   * suspension after suspension of one run is the shape that says the bet
   * parking made is not going to pay off, and that shape is only visible across
   * replays.
   */
  get parkedSummary():
    | { count: number; eventId: string; eventType: Event['eventType'] }
    | undefined {
    const oldest = this.parked[0]?.event;
    if (!oldest) {
      return undefined;
    }
    return {
      count: this.parked.length,
      eventId: oldest.eventId,
      eventType: oldest.eventType,
    };
  }

  append(events: Event[]): void {
    for (const event of events) this.events.push(event);
    process.nextTick(this.consume);
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
      // Before every offer, not just on subscribe: a callback registered by
      // the work this same pass kicked off may be the owner of something
      // parked, and the parked event's delivery is ordered ahead of the head
      // event's by the index it holds.
      this.drainParked();
      const currentEvent = this.events[this.eventIndex] ?? null;
      const consumed = this.offer(currentEvent);
      if (consumed) {
        this.eventIndex++;
      }
      if (currentEvent === null) {
        // End of log. Consumers return NotConsumed for the `null` sentinel
        // (the one that recognizes it as its own boundary schedules the
        // suspension as a side effect and still declines it), so the drain
        // stops here rather than spinning past the end. `consumed` is only
        // true for a callback that claims the sentinel outright, which no
        // production consumer does.
        if (!consumed) {
          this.handleEndOfLog();
        }
        return;
      }
      if (!consumed) {
        this.scheduleUnconsumedCheck(currentEvent, true);
        return;
      }
      // A real event was consumed — advance to the next in the same pass.
    }
  };

  /**
   * Offer `currentEvent` to each registered callback in turn. Returns true
   * when a callback consumed it. Does not move {@link eventIndex}: the ordered
   * walk and the parked drain advance differently, so each does its own.
   */
  private offer(currentEvent: Event | null): boolean {
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
        if (
          currentEvent.correlationId &&
          ONE_SHOT_EVENT_TYPES.has(currentEvent.eventType)
        ) {
          this.resolved.add(
            resolutionKey(currentEvent.eventType, currentEvent.correlationId)
          );
        }
        this.notifyConsumedEvent(currentEvent);
      }
      // remove the callback if it has finished
      if (handled === EventConsumerResult.Finished) {
        this.callbacks.splice(i, 1);
      }
      return true;
    }
    return false;
  }

  /**
   * Offer everything parked, oldest first, until a pass claims nothing.
   *
   * Each offer runs with {@link eventIndex} moved back to the position the
   * parked event held in the log, because that is the position its consumer
   * will register a delivery barrier under. Restoring the walk pointer
   * afterwards is what keeps the two pointers from interfering.
   */
  private drainParked(): void {
    let progressed = this.parked.length > 0;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.parked.length; i++) {
        const entry = this.parked[i];
        const walkIndex = this.eventIndex;
        this.eventIndex = entry.index;
        let consumed: boolean;
        try {
          consumed = this.offer(entry.event);
        } finally {
          this.eventIndex = walkIndex;
        }
        if (consumed) {
          this.parked.splice(i, 1);
          // A `Finished` callback was spliced out of the list this pass, so
          // restart rather than keep walking a mutated array.
          progressed = this.parked.length > 0;
          break;
        }
      }
    }
  }

  /**
   * Step the ordered walk over an event nobody claimed, holding on to it for a
   * later consumer. Returns false when the event's type makes its position a
   * decision record, which is the one case where nobody claiming it means the
   * replay diverged.
   */
  private park(event: Event): boolean {
    if (!PARKABLE_EVENT_TYPES.has(event.eventType)) {
      return false;
    }
    if (
      event.correlationId &&
      this.resolved.has(resolutionKey(event.eventType, event.correlationId))
    ) {
      return false;
    }
    this.parked.push({ event, index: this.eventIndex });
    this.eventIndex++;
    eventsLogger.debug('Parked an unclaimed event for later delivery', {
      eventId: event.eventId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      parked: this.parked.length,
    });
    return true;
  }

  private handleEndOfLog() {
    // Everything still parked is waiting for a consumer some later replay will
    // register, which is the whole point of parking — except once the log
    // already holds the run's terminal event, because then there is no later
    // replay and no consumer will ever come.
    if (this.parked.length === 0) {
      return;
    }
    const last = this.events.at(-1);
    if (!last || !TERMINAL_EVENT_TYPES.has(last.eventType)) {
      // A later replay is still expected, so nothing here is decidable and
      // escalating would fail the healthy runs parking exists to keep alive.
      // Reaching the end of the log holding something is not by itself a fault,
      // so this stays at `debug`; {@link parkedSummary} is what carries the
      // state to the span, where a run that keeps stopping on the same held
      // event is visible and a single replay's view is not.
      eventsLogger.debug('Reached the end of the log still holding events', {
        eventId: this.parked[0].event.eventId,
        eventType: this.parked[0].event.eventType,
        correlationId: this.parked[0].event.correlationId,
        parked: this.parked.length,
      });
      return;
    }
    this.scheduleUnconsumedCheck(this.parked[0].event, false);
  }

  private scheduleUnconsumedCheck(currentEvent: Event, mayPark: boolean) {
    // All callbacks returned NotConsumed for the current event.
    // Schedule a deferred check. We chain onto the promiseQueue so that any
    // pending async work (e.g., deserialization/decryption that triggers
    // resolve() → user code → subscribe()) completes first. If the event
    // is still unconsumed after the queue drains, it's truly orphaned — or,
    // when its type carries no ordering claim, parked for a later consumer.
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
          if (this.unconsumedCheckVersion !== checkVersion) {
            return;
          }
          this.pendingUnconsumedCheck = null;
          if (mayPark) {
            if (this.events[this.eventIndex] !== currentEvent) {
              // An append() drain claimed it while the check was in flight.
              // Only subscribe() cancels the check, so this is reachable.
              return;
            }
            if (this.park(currentEvent)) {
              this.consume();
              return;
            }
          }
          this.onUnconsumedEvent(currentEvent);
        }, getDeferredCheckDelayMs());
      });
  }
}
