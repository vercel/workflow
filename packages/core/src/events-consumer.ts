import { type Event, entityEventClass } from '@workflow/world';
import { eventsLogger } from './logger.js';

/**
 * Delay before firing the deferred unconsumed-event check after the promise
 * queue has drained. Must be long enough for cross-VM microtask chains to
 * propagate (resolve in host → workflow code in VM → subscribe call back
 * in host). Any subscribe() arriving during this window cancels the check.
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
   * Callback invoked when an event is skipped because it repeats an event
   * class the walk already consumed for the same entity. `firstEventType` is
   * the type that recorded the class, which is the one the workflow observed.
   * Diagnostics only: skipping is a normal outcome, not an error — though a
   * `firstEventType` differing from `event.eventType` says the two writers
   * decided the entity's outcome differently, which is worth more than an
   * info log.
   */
  onDuplicateEvent?: (event: Event, firstEventType: Event['eventType']) => void;
  /**
   * Returns the current promise queue. The unconsumed event check is chained
   * onto this queue so it only fires after all pending async work (e.g.,
   * deserialization) has completed. This prevents false positives when async
   * deserialization delays the resolve() that triggers the next subscribe().
   */
  getPromiseQueue: () => Promise<void>;
  /**
   * Whether no data delivery is in flight (`isDeliveryIdle` in private.ts).
   * The unconsumed-event check waits for this before it fires: a delivery in
   * flight means the workflow VM is mid-reaction, and an event it has not
   * claimed yet is an event it has not reached yet.
   *
   * Defaults to always-idle so the tests that drive a consumer with no
   * orchestrator context keep the pre-existing timing.
   */
  isDeliveryIdle?: () => boolean;
}

export class EventsConsumer {
  eventIndex: number;
  readonly events: Event[] = [];
  readonly callbacks: EventConsumerCallback[] = [];
  /**
   * `<class>:<correlationId>` for every event class the walk has already
   * consumed, mapped to the event type that recorded it. The type is kept so a
   * repeat that decided the same class *differently* (a `step_failed` behind a
   * `step_completed`) can be reported as more than a re-commit. See
   * {@link EventsConsumer.firstEventTypeOfClass}.
   */
  private readonly seenEventClasses = new Map<string, Event['eventType']>();
  private onConsumedEvent?: (event: Event) => void;
  private onUnconsumedEvent: (event: Event) => void;
  private onDuplicateEvent?: (
    event: Event,
    firstType: Event['eventType']
  ) => void;
  private getPromiseQueue: () => Promise<void>;
  private isDeliveryIdle: () => boolean;
  private pendingUnconsumedCheck: Promise<void> | null = null;
  private pendingUnconsumedTimeout: ReturnType<typeof setTimeout> | null = null;
  private unconsumedCheckVersion = 0;

  constructor(events: Event[], options: EventsConsumerOptions) {
    this.events = events;
    this.eventIndex = 0;
    this.onConsumedEvent = options.onConsumedEvent;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.onDuplicateEvent = options.onDuplicateEvent;
    this.getPromiseQueue = options.getPromiseQueue;
    this.isDeliveryIdle = options.isDeliveryIdle ?? (() => true);
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
        // Nobody wanted it. If it repeats a class this walk already consumed
        // for the same entity it is a straggler from a concurrent replay:
        // step over it in this pass rather than paying the deferred window for
        // a consumer that cannot come (see `firstEventTypeOfClass`).
        if (currentEvent !== null) {
          const firstType = this.firstEventTypeOfClass(currentEvent);
          if (firstType !== undefined) {
            this.skipDuplicateEvent(currentEvent, firstType);
            continue;
          }
        }
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
        this.recordEventClass(currentEvent);
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

  /**
   * The key `event`'s class is tracked under, or `undefined` for the event
   * types that belong to no class (`hook_received`, `hook_conflict`,
   * `attr_set`, `run_created`) and are therefore never skipped.
   *
   * Run events carry no correlation id. They are classes of the run itself, so
   * they all key off the same bucket.
   */
  private eventClassKey(event: Event): string | undefined {
    const eventClass = entityEventClass(event.eventType);
    return eventClass === undefined
      ? undefined
      : `${eventClass}:${event.correlationId}`;
  }

  /**
   * Remembers that `event`'s class is now decided for its entity, if the type
   * belongs to a class. First writer wins: the recorded type is the one the
   * workflow observed, and a later repeat is measured against it.
   */
  private recordEventClass(event: Event) {
    const key = this.eventClassKey(event);
    if (key !== undefined && !this.seenEventClasses.has(key)) {
      this.seenEventClasses.set(key, event.eventType);
    }
  }

  /**
   * The type that already decided `event`'s class for the same entity, or
   * `undefined` when nothing has: a second `step_created` for one step, a
   * second terminal outcome, a second `step_started` after the step's result is
   * already in the log.
   *
   * Such an event is committed but inert. Concurrent replays write into one
   * log without a currency guard, so a replay working from a prefix that
   * predates another replay's write can commit its own copy of work the log
   * already records. That copy cannot change what the workflow observed: the
   * outcome was decided by the first event of the class and every later replay
   * reads that same event at the same log position, so ignoring the straggler
   * is deterministic across replays.
   *
   * Classes are tracked separately, so passing one does not suppress another.
   * A step whose result is in the log still reaches its `step_created` and
   * `step_started` consumers if it has yet to see those classes.
   *
   * Consulted only after every registered callback has declined the event, so
   * it can never take an event a consumer wanted. A retry's `step_started` is
   * claimed by the step's live consumer and counts as an attempt exactly as
   * before, and a second `step_created` reaching a step that has not finished
   * is likewise consumed rather than skipped; only the copies nobody claims are
   * skipped.
   *
   * Unlike the divergence report, this does *not* wait out the deferred window
   * first, and it does not need to. The window buys time for a consumer that
   * has yet to register, and no such consumer can want this event: the class
   * was recorded by a consumption in this same replay, which means the entity's
   * consumer was registered and took an event of this class, and correlation
   * ids are minted from a monotonic ULID per body position, so nothing later in
   * the body registers a second consumer under this id. Waiting would cost
   * `DEFERRED_CHECK_DELAY_MS` per straggler per replay for information that
   * cannot arrive — 0.75% of production runs carry at least one straggler, and
   * the p99 among those carries 155.
   *
   * The invariant to preserve if hook identity ever becomes caller-supplied
   * (an idempotency key rather than a minted id): two `createHook` calls in one
   * body could then share a correlation id, and the second consumer's
   * `hook_created` would be a repeat of a class this replay already recorded.
   * That would make skipping wrong for `hook_created`, and is the reason the
   * class map lives next to the event types rather than being inferred.
   */
  private firstEventTypeOfClass(event: Event): Event['eventType'] | undefined {
    const key = this.eventClassKey(event);
    return key === undefined ? undefined : this.seenEventClasses.get(key);
  }

  /** Steps the walk over a repeat of an already-consumed class. */
  private skipDuplicateEvent(event: Event, firstType: Event['eventType']) {
    this.eventIndex++;
    // Deliberately not routed through `notifyConsumedEvent`: the deterministic
    // clock advances only on events the workflow actually observed. A skipped
    // event is invisible to the workflow body, and a log that happens to
    // contain one must produce the same timestamps as a log that does not.
    eventsLogger.debug(
      'Skipping event that repeats a class already in the log',
      {
        eventId: event.eventId,
        eventType: event.eventType,
        firstEventType: firstType,
        correlationId: event.correlationId,
      }
    );
    try {
      this.onDuplicateEvent?.(event, firstType);
    } catch (error) {
      eventsLogger.error('onDuplicateEvent callback threw an error', {
        error,
      });
    }
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
          // Wait out any delivery still in flight before starting the timer.
          // The queue draining says the host has no hydration work left; it
          // does not say the VM has finished reacting to what was hydrated.
          this.whenDeliveryIdle(checkVersion, () => {
            // Use a delayed setTimeout once deliveries are idle. The delay must
            // be long enough for promise chains to propagate across the VM
            // boundary (from resolve() in the host context through to the
            // workflow code calling subscribe() in the VM context). Node.js
            // does not guarantee that setTimeout(0) fires after all
            // cross-context microtasks settle, so we use a small but non-zero
            // delay. Any subscribe() call that arrives during this window will
            // cancel the check via version invalidation + clearTimeout.
            this.pendingUnconsumedTimeout = setTimeout(() => {
              this.pendingUnconsumedTimeout = null;
              if (this.unconsumedCheckVersion === checkVersion) {
                this.pendingUnconsumedCheck = null;
                this.onUnconsumedEvent(currentEvent);
              }
            }, DEFERRED_CHECK_DELAY_MS);
          });
        });
    }
  }

  /**
   * Run `fn` once no data delivery is in flight, polling the way
   * `scheduleWhenIdle` does: let the promise queue drain, re-check a timer
   * tick later, repeat.
   *
   * Without this the check is a bet that every delivery the walk is running
   * ahead of lands inside a fixed window. Consumption is synchronous while the
   * resolution it triggers is not: a step result hydrates in the host, resolves
   * from a detached continuation behind `awaitEarlierDeliveries`, and only then
   * does VM code run far enough to subscribe the next consumer. Replaying a
   * batch of N parallel step results leaves N-1 of them on that detached path
   * with the queue already drained, so the walk sits on the ordered event the
   * VM is about to draw and the window is the only thing standing between a
   * healthy run and `ReplayDivergenceError`. On a backend whose deliveries take
   * longer than the window, that bet loses.
   *
   * Termination is `hasParkedCommittedDelivery`'s: it counts only deliveries
   * that resolve on their own, so nothing here can gate its own retirement. A
   * genuinely orphaned event has no delivery to wait on and reaches `fn` on the
   * first poll.
   */
  private whenDeliveryIdle(checkVersion: number, fn: () => void): void {
    const poll = () => {
      this.pendingUnconsumedTimeout = null;
      if (this.unconsumedCheckVersion !== checkVersion) {
        return;
      }
      if (this.isDeliveryIdle()) {
        fn();
        return;
      }
      this.getPromiseQueue().then(() => {
        if (this.unconsumedCheckVersion !== checkVersion) {
          return;
        }
        // Held in the same field the fired check uses so subscribe() cancels a
        // poll in progress exactly as it cancels the check itself.
        this.pendingUnconsumedTimeout = setTimeout(poll, 0);
      });
    };
    poll();
  }
}
