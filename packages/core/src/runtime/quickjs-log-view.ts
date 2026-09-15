import { type Event, eventIdToSlot, FIRST_EVENT_SLOT } from '@workflow/world';

/**
 * The QuickJS engine's bookkeeping for the run's event log, giving that engine
 * the same relationship to a World's write responses that the node:vm replay
 * loop has.
 *
 * The node engine holds the log as an array it replays from, so a page a World
 * hands back on a write (a skipped-slot report against `eventCount`, or an
 * inline delta against `sinceCursor`; see `CreateEventParams` in
 * `@workflow/world`) is merged into that array and the next replay reads it
 * there. The QuickJS engine holds a LIVE VM instead: events are delivered to it
 * incrementally through `continueWithEvents`, in log order, exactly once. So
 * for this engine a returned page is not merged into a log; it is queued to be
 * delivered. This class owns that queue and the three numbers around it:
 *
 * - `knownMaxSlot`, the highest position this invocation has seen anywhere
 *   (fed, buffered, or its own write). Reported as `eventCount` on every write
 *   this invocation makes from its view of the log, so the World can hand
 *   back what landed above it.
 * - `fedMaxSlot`, the highest position delivered to the VM. Delivery is
 *   strictly in position order with no gaps, because the VM consumes events
 *   as they arrive and a later replay will read the log in position order;
 *   feeding position 13 before 12 exists would let the two disagree.
 * - `cursor`, the read position for `events.list`, advanced by list pages and
 *   by a complete inline delta.
 *
 * Only PAGES are queued for delivery, never the created event a write returns
 * on its own. A World reads a report or a delta the way it reads a listing,
 * with payload refs resolved, so those events are what a listing would have
 * delivered. The created event on a create response is not: a World may hand
 * it back with its payload still a ref descriptor and telemetry fields
 * stripped (the Vercel World does, for every type whose entity the runtime
 * does not read off the response), and a VM given that copy of a `step_failed`
 * sees a step that failed with no error in it. The created event still counts
 * toward the position the next write names; it is delivered by the page that
 * covers it or by the next listing. `deliverEvent` opts a write in when its
 * event carries nothing a VM reads (`wait_completed`).
 *
 * Positions come from slot-numbered event ids. A log whose ids are not slots
 * (a World on the old id scheme, or a mocked World) turns tracking off for the
 * rest of the invocation: no `eventCount` is sent, nothing is buffered, and the
 * engine reads the log back the way it did before any of this existed.
 */
export class QuickJSLogView {
  private slotTracking = true;
  private knownMaxSlot: number | undefined;
  private fedMaxSlot: number | undefined;
  /** Events handed back by a World that the VM has not been given yet. */
  private readonly unfed = new Map<number, Event>();
  private cursor: string | null;

  constructor(fedEvents: readonly Event[], cursor: string | null) {
    this.cursor = cursor;
    this.markFed(fedEvents);
  }

  /** Read position for the next `events.list`, or `null` for the start. */
  get logCursor(): string | null {
    return this.cursor;
  }

  /** How many events are queued for delivery to the VM. */
  get bufferedCount(): number {
    return this.unfed.size;
  }

  /** Whether positions are being tracked (see class doc). */
  get tracking(): boolean {
    return this.slotTracking;
  }

  /**
   * The `eventCount` to attach to a write made from this view. Empty while no
   * position is known (an empty log) or once tracking has been turned off.
   */
  snapshotParams(): { eventCount?: number } {
    return this.slotTracking && this.knownMaxSlot !== undefined
      ? { eventCount: this.knownMaxSlot }
      : {};
  }

  /** A page of `events.list` was read to `cursor`. */
  advanceCursor(cursor: string | null): void {
    if (cursor !== null) {
      this.cursor = cursor;
    }
  }

  /**
   * Events delivered to the VM by the caller (the initial load, or an
   * `events.list` page). Removes them from the delivery queue if a write
   * response had already handed them back.
   */
  markFed(events: readonly Event[]): void {
    for (const event of events) {
      const slot = this.slotOf(event);
      if (slot === undefined) continue;
      this.unfed.delete(slot);
      if (this.fedMaxSlot === undefined || slot > this.fedMaxSlot) {
        this.fedMaxSlot = slot;
      }
    }
  }

  /**
   * Absorb a write's response: note the committed event's position, and
   * queue the skipped-slot report a World attached to it.
   *
   * A truncated page (`hasMore`) is dropped whole, the same policy as
   * `absorbSkippedSlotReport` in the node engine: it covers a span of
   * positions but carries only some of them, and queuing part of a span
   * would have this view claim, on its next write, to have seen positions it
   * never received. The committed event is queued only under `deliverEvent`
   * (see the class doc for why not by default); its position always counts.
   */
  absorb(
    result: {
      event?: Event;
      events?: readonly Event[];
      hasMore?: boolean;
    },
    options: { deliverEvent?: boolean } = {}
  ): { queued: number; truncated: boolean } {
    let queued = 0;
    if (result.event) {
      if (options.deliverEvent === true) {
        if (this.queue(result.event)) queued++;
      } else {
        this.slotOf(result.event);
      }
    }
    const page = result.events ?? [];
    if (page.length === 0) {
      return { queued, truncated: false };
    }
    if (result.hasMore === true) {
      return { queued, truncated: true };
    }
    for (const event of page) {
      if (this.queue(event)) queued++;
    }
    return { queued, truncated: false };
  }

  /**
   * Absorb the inline delta a step-terminal write returned for
   * `sinceCursor`, and advance the read cursor past it when that is safe.
   *
   * The delta is everything after `sentCursor`, so it may be taken only if
   * the view still stands at that cursor (a list in between would have moved
   * it, and appending a delta computed from an older position could deliver
   * events behind ones already fed). The cursor advances only when the queue
   * then holds every position between what the VM has and the delta's end:
   * with a hole in between, a later `events.list` from the advanced cursor
   * would never return the missing event and the VM would stall on it.
   *
   * @returns whether the cursor was advanced.
   */
  absorbDelta(
    sentCursor: string,
    delta: { events: readonly Event[]; cursor: string | null; hasMore: boolean }
  ): boolean {
    if (!this.slotTracking || this.cursor !== sentCursor) {
      return false;
    }
    if (delta.hasMore) {
      return false;
    }
    for (const event of delta.events) {
      this.queue(event);
    }
    if (!this.queueIsDense()) {
      return false;
    }
    this.advanceCursor(delta.cursor);
    return true;
  }

  /**
   * Drain the events that can be delivered to the VM now: the queued run of
   * consecutive positions directly above the highest one already fed. A queued
   * event above a position nothing has filled yet stays queued until a list
   * fills the gap.
   */
  takeContiguous(): Event[] {
    if (!this.slotTracking) {
      return [];
    }
    const out: Event[] = [];
    // A VM started on an empty log is waiting for the first position.
    let next =
      this.fedMaxSlot === undefined ? FIRST_EVENT_SLOT : this.fedMaxSlot + 1;
    for (;;) {
      const event = this.unfed.get(next);
      if (event === undefined) break;
      this.unfed.delete(next);
      out.push(event);
      next++;
    }
    if (out.length > 0) {
      this.fedMaxSlot = next - 1;
    }
    return out;
  }

  private queueIsDense(): boolean {
    if (this.knownMaxSlot === undefined) {
      return this.unfed.size === 0;
    }
    const fed = this.fedMaxSlot ?? FIRST_EVENT_SLOT - 1;
    return this.unfed.size === this.knownMaxSlot - fed;
  }

  /** Queue one event for delivery unless the VM already has it. */
  private queue(event: Event): boolean {
    const slot = this.slotOf(event);
    if (slot === undefined) return false;
    if (this.fedMaxSlot !== undefined && slot <= this.fedMaxSlot) {
      return false;
    }
    if (this.unfed.has(slot)) return false;
    this.unfed.set(slot, event);
    return true;
  }

  /**
   * The event's position, bumping `knownMaxSlot`. `undefined` once an id
   * turns out not to be a slot, which turns tracking off for good.
   */
  private slotOf(event: Event): number | undefined {
    if (!this.slotTracking) return undefined;
    const slot =
      typeof event.eventId === 'string' ? eventIdToSlot(event.eventId) : null;
    if (slot === null) {
      this.slotTracking = false;
      this.knownMaxSlot = undefined;
      this.unfed.clear();
      return undefined;
    }
    if (this.knownMaxSlot === undefined || slot > this.knownMaxSlot) {
      this.knownMaxSlot = slot;
    }
    return slot;
  }
}
