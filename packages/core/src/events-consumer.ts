import { type Event, envNumber } from '@workflow/world';
import { eventsLogger } from './logger.js';

/**
 * Clean-room rewrite of the event-log consumer.
 *
 * The consumer walks the run's event log in order and offers each event to a
 * set of subscriber callbacks (step/hook/sleep/abort consumers plus the
 * structural lifecycle consumer). It is the arbiter of two questions:
 *
 *  1. "Which callback owns the event at the cursor?" — answered synchronously,
 *     first match in subscription order wins, cursor advances only on a claim.
 *  2. "Is the event at the cursor orphaned?" — an event nobody claims is only
 *     evidence of replay divergence once the workflow VM has provably stopped
 *     reacting. Answering this too eagerly rejects a healthy replay with
 *     `ReplayDivergenceError`, burns a divergence-recovery retry, and can
 *     escalate to a terminal `CorruptedEventLogError`.
 *
 * Question 2 is where the previous implementation was fragile: consumption is
 * synchronous but the resolutions it triggers are not. A step result hydrates
 * in the host, resolves from a detached continuation behind
 * `awaitEarlierDeliveries`, and only then does VM code run far enough to
 * `subscribe()` the consumer for the next event — so the walk routinely sits
 * on an ordered event that nobody has claimed yet while the workflow is
 * mid-flight on its way to claiming it. Under `node:vm` the cross-realm
 * microtask chains involved (resolve in host → workflow code in VM →
 * subscribe back in host) have no scheduling guarantee relative to host
 * timers, so any fixed-delay check is a bet.
 *
 * This implementation replaces the scattered version counters and shared
 * timeout handles with a single explicit orphan-confirmation protocol (see
 * `runOrphanProbe`) that:
 *
 *  - is invalidated by *any* activity — `subscribe()`, `append()`, or an
 *    event being consumed — not just `subscribe()` as before;
 *  - waits for full quiescence (promise queue drained across a macrotask
 *    boundary, then no delivery in flight) before arming the grace window;
 *  - after the grace window elapses, re-verifies quiescence and synchronously
 *    re-offers the event one final time, and only declares the event orphaned
 *    if nothing claims it — converting a lost timing bet into a restart of
 *    the protocol instead of a false divergence.
 *
 * It also fixes a latent cursor bug: consuming the end-of-log `null` sentinel
 * no longer advances the cursor (previously it did, which would silently skip
 * the next appended event on a retained session).
 */

/**
 * Grace window between reaching full quiescence and declaring the event at
 * the cursor orphaned. Must be long enough for cross-VM microtask chains to
 * propagate: Node.js does not guarantee that `setTimeout(0)` fires after all
 * cross-context microtasks settle, so a small but non-zero delay is required.
 * Any activity arriving during the window aborts the probe.
 */
export const DEFERRED_CHECK_DELAY_MS = 100;

/**
 * Effective grace window. Override: `WORKFLOW_DEFERRED_CHECK_DELAY_MS`.
 *
 * This is not a polling interval but a determinism safety margin. Measured on
 * the event-log race repro against world-postgres, on identical event logs:
 * 0 of 114 runs corrupted with a 100ms window, 34 of 42 with a 10ms one.
 * Floored at 10ms so a too-low override can't manufacture spurious
 * divergence.
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
   * Callback invoked when a non-null event cannot be consumed by any
   * registered callback after the orphan-confirmation protocol has run to
   * completion, indicating an orphaned or invalid event in the event log.
   */
  onUnconsumedEvent: (event: Event) => void;
  /**
   * Returns the current promise queue. The orphan-confirmation protocol only
   * proceeds once this queue has drained, so pending async work (e.g.,
   * deserialization/decryption) always gets the chance to resume workflow
   * code that claims the event first.
   */
  getPromiseQueue: () => Promise<void>;
  /**
   * Whether no data delivery is in flight (`isDeliveryIdle` in private.ts).
   * A delivery in flight means the workflow VM is mid-reaction, and an event
   * it has not claimed yet is an event it has not reached yet — the
   * orphan-confirmation protocol waits it out, however long it takes.
   *
   * Defaults to always-idle for consumers driven without an orchestrator
   * context (tests).
   */
  isDeliveryIdle?: () => boolean;
}

/**
 * State for one in-flight orphan-confirmation protocol run. A probe is
 * created when the walk stalls on an unclaimed event and is aborted by any
 * activity (subscribe/append/consume). Aborting wakes a sleeping probe
 * immediately so no timer or promise chain outlives its relevance.
 */
interface OrphanProbe {
  aborted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  wake: (() => void) | null;
}

export class EventsConsumer {
  /**
   * Cursor into `events`: the index of the next event to be claimed. Public
   * because subscribers register delivery barriers keyed by the log index of
   * the event they are consuming.
   */
  eventIndex = 0;
  readonly events: Event[];
  readonly callbacks: EventConsumerCallback[] = [];

  private readonly onConsumedEvent?: (event: Event) => void;
  private readonly onUnconsumedEvent: (event: Event) => void;
  private readonly getPromiseQueue: () => Promise<void>;
  private readonly isDeliveryIdle: () => boolean;

  private drainScheduled = false;
  private activeProbe: OrphanProbe | null = null;

  constructor(events: Event[], options: EventsConsumerOptions) {
    // Own copy: the runtime mutates its event array in place, and a retained
    // session must only observe new events through append() so resume()'s
    // strict-extension check stays meaningful.
    this.events = [...events];
    this.onConsumedEvent = options.onConsumedEvent;
    this.onUnconsumedEvent = options.onUnconsumedEvent;
    this.getPromiseQueue = options.getPromiseQueue;
    this.isDeliveryIdle = options.isDeliveryIdle ?? (() => true);
  }

  /**
   * Registers a callback to be offered events from the cursor onward. The
   * callback can return:
   *  - `EventConsumerResult.Consumed`: the event is claimed and will not be
   *    offered to any other callback; the callback stays registered.
   *  - `EventConsumerResult.NotConsumed`: the event is offered to the next
   *    callback in subscription order.
   *  - `EventConsumerResult.Finished`: the event is claimed and the callback
   *    is removed.
   *
   * Callbacks are also offered a `null` sentinel whenever the walk reaches
   * the end of the log, which consumers use to schedule suspension.
   */
  subscribe(fn: EventConsumerCallback): void {
    this.callbacks.push(fn);
    this.recordActivity();
    this.scheduleDrain();
  }

  /**
   * Appends newly observed events (retained-session resume). The walk picks
   * them up from wherever the cursor currently is.
   */
  append(events: Event[]): void {
    for (const event of events) {
      this.events.push(event);
    }
    this.recordActivity();
    this.scheduleDrain();
  }

  /**
   * Any activity — a new subscriber, new events, or a consumed event —
   * invalidates the in-flight orphan probe: the stall it was confirming is no
   * longer the state of the world. The next drain that stalls starts a fresh
   * probe with a fresh grace window.
   */
  private recordActivity(): void {
    const probe = this.activeProbe;
    if (probe === null) {
      return;
    }
    this.activeProbe = null;
    probe.aborted = true;
    if (probe.timer !== null) {
      clearTimeout(probe.timer);
      probe.timer = null;
    }
    // Wake a sleeping probe immediately so it observes `aborted` and unwinds
    // rather than holding its timer's word for it.
    probe.wake?.();
  }

  /**
   * Coalesces drain requests: however many subscribe()/append() calls land in
   * one tick, the log is walked once on the next tick.
   */
  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    process.nextTick(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  /**
   * Walks the log from the cursor, synchronously claiming every consecutive
   * event some callback owns. Stops at the first event nobody claims (and
   * starts the orphan-confirmation protocol for it) or at the end of the log
   * (and offers the `null` sentinel).
   *
   * Draining synchronously is safe because callbacks never call subscribe()
   * synchronously: new consumers are only registered by workflow VM code that
   * runs asynchronously off `ctx.promiseQueue` after a delivery resolves. So
   * within one pass `this.callbacks` is only mutated by the `Finished` splice
   * in `offer()`.
   */
  private drain(): void {
    while (true) {
      const event = this.events[this.eventIndex];
      if (event === undefined) {
        this.offerSentinel();
        return;
      }
      if (!this.offer(event)) {
        this.beginOrphanProbe(event);
        return;
      }
    }
  }

  /**
   * Offers a real event to each callback in subscription order. The first
   * callback returning `Consumed` or `Finished` claims it: the cursor
   * advances, `onConsumedEvent` fires, and a `Finished` callback is removed.
   * Returns whether the event was claimed.
   */
  private offer(event: Event): boolean {
    for (let i = 0; i < this.callbacks.length; i++) {
      const result = this.invokeCallback(this.callbacks[i], event);
      if (
        result !== EventConsumerResult.Consumed &&
        result !== EventConsumerResult.Finished
      ) {
        continue;
      }
      if (result === EventConsumerResult.Finished) {
        this.callbacks.splice(i, 1);
      }
      this.eventIndex++;
      // A claim is activity: it invalidates any in-flight orphan probe.
      this.recordActivity();
      if (this.onConsumedEvent) {
        try {
          this.onConsumedEvent(event);
        } catch (error) {
          eventsLogger.error('onConsumedEvent callback threw an error', {
            error,
          });
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Offers the end-of-log sentinel to every callback. The sentinel is not an
   * event: it never advances the cursor, and "consuming" it is meaningless —
   * a callback returning `Finished` is removed (it is done listening), while
   * `Consumed` is treated as `NotConsumed`.
   */
  private offerSentinel(): void {
    for (let i = 0; i < this.callbacks.length; i++) {
      const result = this.invokeCallback(this.callbacks[i], null);
      if (result === EventConsumerResult.Finished) {
        this.callbacks.splice(i, 1);
        i--;
      }
    }
  }

  private invokeCallback(
    callback: EventConsumerCallback,
    event: Event | null
  ): EventConsumerResult {
    try {
      return callback(event);
    } catch (error) {
      eventsLogger.error('EventConsumer callback threw an error', { error });
      return EventConsumerResult.NotConsumed;
    }
  }

  private beginOrphanProbe(event: Event): void {
    if (this.activeProbe !== null) {
      // Defensive: drains are coalesced and every trigger invalidates the
      // probe first, so a live probe here is the same stall still being
      // confirmed.
      return;
    }
    const probe: OrphanProbe = { aborted: false, timer: null, wake: null };
    this.activeProbe = probe;
    this.runOrphanProbe(event, probe).catch((error) => {
      eventsLogger.error('orphan-confirmation protocol threw an error', {
        error,
      });
    });
  }

  /**
   * The orphan-confirmation protocol. Declares `event` orphaned only after
   * all of the following hold, in order, with the probe surviving every step:
   *
   *  1. The promise queue has drained, a macrotask boundary has passed (so
   *     promise chains resumed by that drain can run across the VM boundary
   *     and enqueue follow-up async work), and the queue has drained again.
   *  2. No delivery is in flight. This is a poll, not a timeout: a step
   *     result parked on the detached continuation behind
   *     `awaitEarlierDeliveries` can take arbitrarily long to land, and the
   *     walk sitting on the event the VM is about to claim must wait it out.
   *     Termination is `hasParkedCommittedDelivery`'s: it counts only
   *     deliveries that resolve on their own, so nothing here gates its own
   *     retirement. A genuinely orphaned event has no delivery to wait on.
   *  3. The grace window has elapsed with no activity.
   *  4. Quiescence still holds after the window, and a final synchronous
   *     re-offer of the event finds no claimant. If either check fails the
   *     protocol restarts from (1) instead of firing.
   *
   * Any subscribe()/append()/claim at any point aborts the probe (and wakes
   * it, if sleeping).
   */
  private async runOrphanProbe(
    event: Event,
    probe: OrphanProbe
  ): Promise<void> {
    while (!probe.aborted) {
      // (1) + (2)
      await this.quiesce(probe);
      if (probe.aborted) return;

      // (3) The grace window.
      await this.sleep(probe, getDeferredCheckDelayMs());
      if (probe.aborted) return;

      // (4)
      const verdict = await this.confirmStall(event, probe);
      if (verdict === 'retry') {
        continue;
      }
      if (verdict === 'orphaned') {
        this.activeProbe = null;
        this.onUnconsumedEvent(event);
      }
      return;
    }
  }

  /**
   * Probe phases (1) and (2): drain the host's hydration queue across a
   * macrotask boundary (so promise chains resumed by the drain can run across
   * the VM boundary and enqueue follow-up async work), then wait out any
   * delivery still in flight. The queue draining says the host has no
   * hydration work left; it does not say the VM has finished reacting to what
   * was hydrated.
   */
  private async quiesce(probe: OrphanProbe): Promise<void> {
    await this.getPromiseQueue();
    if (probe.aborted) return;
    await this.sleep(probe, 0);
    if (probe.aborted) return;
    await this.getPromiseQueue();

    while (!probe.aborted && !this.isDeliveryIdle()) {
      await this.getPromiseQueue();
      if (probe.aborted) return;
      await this.sleep(probe, 0);
    }
  }

  /**
   * Probe phase (4): confirm the grace window was actually quiet. Timers
   * firing on schedule is not evidence that cross-realm microtask chains have
   * settled, so verify rather than trust: if a delivery started, the stall
   * was false and the protocol restarts; if a final synchronous re-offer
   * finds a claimant, the walk resumes.
   */
  private async confirmStall(
    event: Event,
    probe: OrphanProbe
  ): Promise<'orphaned' | 'retry' | 'aborted'> {
    await this.getPromiseQueue();
    if (probe.aborted) return 'aborted';
    if (!this.isDeliveryIdle()) return 'retry';
    if (this.offer(event)) {
      // Claimed after all (offer() aborted the probe). Resume the walk.
      this.scheduleDrain();
      return 'aborted';
    }
    return probe.aborted ? 'aborted' : 'orphaned';
  }

  /**
   * Cancellable sleep: resolves after `ms`, or immediately when the probe is
   * aborted (the caller checks `probe.aborted` after every await).
   */
  private sleep(probe: OrphanProbe, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        if (probe.timer !== null) {
          clearTimeout(probe.timer);
          probe.timer = null;
        }
        probe.wake = null;
        resolve();
      };
      probe.wake = done;
      probe.timer = setTimeout(done, ms);
    });
  }
}
