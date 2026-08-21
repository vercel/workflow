import type { Event } from '@workflow/world';
import { envNumber } from '@workflow/world/env-config';
import {
  entityEventClass,
  isSealedNoopEvent,
} from '@workflow/world/event-metadata';
import { eventsLogger } from './logger.js';

/**
 * Delay before firing the deferred unconsumed-event check after the promise
 * queue has drained. Must be long enough for cross-VM microtask chains to
 * propagate (resolve in host → workflow code in VM → subscribe call back
 * in host). Any subscribe() arriving during this window cancels the check.
 */
export const DEFERRED_CHECK_DELAY_MS = 100;

/**
 * Floor for the deferred-check delay, so a too-low override can't manufacture
 * spurious divergence (each false positive burns a divergence-recovery retry
 * and can escalate to a terminal `CorruptedEventLogError`).
 *
 * Exported so tests needing the shortest legal delay can ask for it instead of
 * hardcoding a number this floor would silently clamp up.
 */
export const MIN_DEFERRED_CHECK_DELAY_MS = 10;

/**
 * Effective deferred-check delay. Override: `WORKFLOW_DEFERRED_CHECK_DELAY_MS`.
 *
 * Unlike the other timing knobs this is not a polling interval but a
 * determinism safety margin: firing the unconsumed-event check before the
 * cross-VM subscribe() chain has landed rejects a healthy run with
 * `ReplayDivergenceError`.
 */
const getDeferredCheckDelayMs = (): number =>
  envNumber('WORKFLOW_DEFERRED_CHECK_DELAY_MS', DEFERRED_CHECK_DELAY_MS, {
    integer: true,
    min: MIN_DEFERRED_CHECK_DELAY_MS,
  });

/**
 * Event types the ordered walk may step over and deliver later.
 *
 * Membership is not about who wrote the event. It is about whether the event
 * can reach the head of the walk with nothing registered to consume it, which
 * is the only situation parking exists for.
 *
 * Most types cannot. They are replay-origin: a replay emits them, in the order
 * its code reaches them, so their position in the log is the record of what
 * that replay decided. Reaching one of those out of order means this replay
 * decided differently than the log holds, which is divergence and nothing else.
 *
 * Step lifecycle events are not replay-origin, and are still absent, because
 * they always have a claimant. `step()` subscribes its consumer before the
 * step's first event can exist; `step_created` is ordered, so the walk cannot
 * pass it unless a consumer takes it; and that consumer stays subscribed until
 * `step_completed` or `step_failed`, after which the World refuses any further
 * write for that step. There is no window in which a replay knows about a step
 * and has nothing registered to consume its events, so parking them would only
 * defer reports of what is divergence either way. The same holds for
 * `wait_created` and its consumer. `wait_completed` is listed anyway: a sleep
 * can also be completed out of band, by the API that force-completes pending
 * waits, and tolerating a stray one is the cheaper direction to be wrong in.
 *
 * An allowlist rather than the complement of the ordered set, so a type this
 * file has not been taught about keeps the strict old behavior.
 *
 * `hook_disposed` is deliberately absent despite being about a hook: it is
 * written when the workflow's own `using` scope exits, so it is replay-origin.
 *
 * `attr_set` is listed by type even though a given instance of it may be
 * replay-origin, since it is replay-origin when its writer is the workflow.
 * Splitting that out per event was considered and rejected. A replay that
 * reaches one of its own writes out of position has diverged, but a replay that
 * reaches an event it did NOT write, sitting where its own write would go, has
 * not: the writer field says who wrote the event, and not whether this replay
 * is the same one. Guessing wrong in that direction fails healthy runs, which
 * is the failure this file exists to stop, so the whole type is tolerated. The
 * cost is that a divergence involving `attr_set` surfaces at the end of the
 * replay, through `strandedEvent`, rather than at the offending event.
 */
const PARKABLE_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set([
  'hook_received',
  'hook_conflict',
  'wait_completed',
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
 *
 * Must stay a subset of {@link PARKABLE_EVENT_TYPES}: {@link park} is the only
 * reader of what this records, and it rejects a non-parkable type before it
 * looks, so an entry outside that set is dead weight on a hot path.
 */
const ONE_SHOT_EVENT_TYPES: ReadonlySet<Event['eventType']> = new Set([
  'wait_completed',
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
   * Callback invoked when an event is skipped because it repeats an event
   * class the walk already consumed for the same entity. `firstEventType` is
   * the type that recorded the class, which is the one the workflow observed.
   * Diagnostics only: skipping is a normal outcome, not an error, though a
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
   * Required rather than defaulting to always-idle: always-idle is exactly the
   * pre-gate behavior, so a defaulted option would let a construction site opt
   * a whole replay path back out without saying so. Tests that drive a consumer
   * with no orchestrator context pass `() => true` to keep the pre-existing
   * timing, and say so at the call site.
   */
  isDeliveryIdle: () => boolean;
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
    // Own copy: the runtime mutates its event array in place, and a retained
    // session must only observe new events through append() so resume()'s
    // strict-extension check stays meaningful.
    this.events = [...events];
    this.eventIndex = 0;
    this.onConsumedEvent = options.onConsumedEvent;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.onDuplicateEvent = options.onDuplicateEvent;
    this.getPromiseQueue = options.getPromiseQueue;
    this.isDeliveryIdle = options.isDeliveryIdle;
  }

  /**
   * The oldest event the walk stepped over that no consumer has claimed yet,
   * if any. Parking is a bet that a consumer will be registered later, so at
   * any point where no consumer ever will be again (the replay finishing is
   * the definitive one), this answers which event the bet lost on.
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
    // either already present (advance now) or not yet registered, in which
    // case no callback consumes the event and we fall through to the
    // cross-VM-safe deferred unconsumed-event check below, exactly as before.
    while (true) {
      // Before every offer, not just on subscribe: a callback registered by
      // the work this same pass kicked off may be the owner of something
      // parked, and the parked event's delivery is ordered ahead of the head
      // event's by the index it holds.
      this.drainParked();
      const currentEvent = this.events[this.eventIndex] ?? null;
      if (currentEvent !== null && isSealedNoopEvent(currentEvent)) {
        this.skipSealedNoop(currentEvent);
        continue;
      }
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
        // Nobody wanted it. If it repeats a class this walk already consumed
        // for the same entity it is a straggler from a concurrent replay:
        // step over it in this pass rather than paying the deferred window for
        // a consumer that cannot come (see `firstEventTypeOfClass`).
        const firstType = this.firstEventTypeOfClass(currentEvent);
        if (firstType !== undefined) {
          this.skipDuplicateEvent(currentEvent, firstType);
          continue;
        }
        this.scheduleUnconsumedCheck(currentEvent, true);
        return;
      }
      // A real event was consumed, so advance to the next in the same pass.
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
        this.recordEventClass(currentEvent);
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
   * `getDeferredCheckDelayMs()` per straggler per replay for information that
   * cannot arrive: 0.75% of production runs carry at least one straggler, and
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

  /**
   * Steps the walk over a sealed-log `noop` (specVersion >= 7): the World's
   * backend wrote it to occupy a slot whose writer allocated the position and
   * died, so the log's density arithmetic holds. It is invisible to the
   * workflow: no consumer is offered it, no event class is recorded, and the
   * deterministic clock does not advance, exactly as with
   * {@link skipDuplicateEvent}, so a log that happens to contain one produces the same
   * timestamps as a log that does not. (Its `createdAt` is the seal time,
   * which can even postdate later slots' events; letting it touch the clock
   * would leak the sealer's wall clock into replay.)
   */
  private skipSealedNoop(event: Event) {
    this.eventIndex++;
    eventsLogger.debug('Skipping sealed-log noop event', {
      eventId: event.eventId,
    });
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

  private handleEndOfLog() {
    // Everything still parked is waiting for a consumer some later replay will
    // register, which is the whole point of parking, except once the log
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
    // is still unconsumed after the queue drains, it's truly orphaned, or,
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
        // Wait out any delivery still in flight before starting the timer.
        // The queue draining says the host has no hydration work left; it
        // does not say the VM has finished reacting to what was hydrated.
        this.whenDeliveryIdle(checkVersion, () => {
          // Use a delayed setTimeout once deliveries are idle. The delay must
          // be long enough for promise chains to propagate across the VM
          // boundary (from resolve() in the host context through to the
          // workflow code calling subscribe() in the VM context). Node.js does
          // not guarantee that setTimeout(0) fires after all cross-context
          // microtasks settle, so we use a small but non-zero delay. Any
          // subscribe() call that arrives during this window will cancel the
          // check via version invalidation + clearTimeout.
          this.pendingUnconsumedTimeout = setTimeout(() => {
            this.pendingUnconsumedTimeout = null;
            if (this.unconsumedCheckVersion !== checkVersion) {
              return;
            }
            this.pendingUnconsumedCheck = null;
            this.resolveUnconsumedEvent(currentEvent, mayPark);
          }, getDeferredCheckDelayMs());
        });
      });
  }

  /**
   * Decide what a still-unconsumed event is, now that the promise queue has
   * drained and the delivery gate says the VM is not mid-reaction.
   *
   * `mayPark` is false only for the end-of-log recheck of an event {@link park}
   * already holds. Nothing in the first branch applies to one of those: it is
   * not the event at the cursor, so the identity guard is not meaningful, and
   * it is parked already.
   *
   * A duplicate class never arrives here. {@link consume} steps over one in the
   * pass that offered it, before this check is ever scheduled, and a class
   * recorded while the check was in flight can only have been recorded by a
   * consumption inside {@link consume}, whose next pass re-offers this event
   * and steps over it there, leaving the identity guard above to drop the
   * in-flight check.
   */
  private resolveUnconsumedEvent(currentEvent: Event, mayPark: boolean) {
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
   * healthy run and `ReplayDivergenceError`.
   *
   * Shortening the window shows that mechanism directly: on identical event logs
   * the local race repro corrupts 34 of 42 runs at a 10ms window and 0 of 114 at
   * the 100ms default. That measures how the bet loses, not that the default
   * loses it, and no measurement of a delivery outrunning 100ms exists either
   * way. So read this as retiring the bet rather than as repairing an observed
   * failure of that number: the delay is a user-settable env override, which
   * leaves the old behavior one configuration away from losing on any backend.
   *
   * Termination is `hasParkedCommittedDelivery`'s: it counts only deliveries
   * that resolve on their own, so nothing here can gate its own retirement. A
   * genuinely orphaned event has no delivery to wait on and reaches `fn` on the
   * first poll.
   *
   * What the gate gives up: for the ordered events that still reach
   * `onUnconsumedEvent` rather than {@link park}, this stops being the thing
   * that catches a diverged log while a delivery is in flight. The suspension
   * and this check now wake from the same `isDeliveryIdle` edge, and
   * `scheduleWhenIdle` fires on the first timer tick after idle while this waits
   * a further `getDeferredCheckDelayMs()`. So a run with a pending `sleep()`
   * suspends first, and `onWorkflowError` drops the divergence arriving second
   * (its `'suspended'` branch demotes to `'replay'` and surfaces nothing),
   * leaving a later `resume()` to decline into a cold replay. Pre-gate the
   * suspension already won that race whenever the delivery landed inside the
   * fixed window, so what changed is that the outcome stopped depending on
   * timing. Nothing should treat this check as the mechanism that reports
   * divergence on a log the run is still delivering into.
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
        // poll in progress too. The two cancellations are not identical: for the
        // poll it is the version bump that does the work and the clearTimeout is
        // belt-and-braces. Two state machines write this one field, so a poll
        // invalidated between scheduling and firing can null out a handle the
        // live chain has since stored, which is why every path out of `poll` and
        // out of the fired check re-checks the version rather than trusting the
        // handle.
        this.pendingUnconsumedTimeout = setTimeout(poll, 0);
      });
    };
    poll();
  }
}
