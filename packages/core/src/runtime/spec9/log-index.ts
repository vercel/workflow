import {
  type Event,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  requireEventSlot,
} from '@workflow/world';
import { type EventSlotGap, findEventSlotGap } from '../helpers.js';

/**
 * At most this many events are merged out of order by insertion; more are
 * appended and the log sorted once, as `mergeReportedEvents` does.
 */
const MAX_INSERTED_OUT_OF_ORDER = 32;

const byEventId = (a: Event, b: Event) =>
  a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;

/**
 * Incremental state of a loaded event log, so that what each in-band write
 * reads of the log costs O(1) instead of a scan of the whole log: the ids it
 * holds, its highest slot (`maxEventSlot`), and a dense-prefix watermark that
 * answers whether it has a hole (`findEventSlotGap`) without a pass.
 *
 * The index describes one `events` array, and only while every change to it
 * goes through {@link merge}. {@link covers} tells a caller whether it still
 * does: a different array (a full load, a gap settle) or a length that
 * changed behind its back (a run-ahead repair removing speculative events)
 * means it must be built again, which is one pass, as a full load already is.
 *
 * Merging keeps the log in slot order (event id order) and returns how many
 * events were new, as `mergeReportedEvents` does. Events above the log's
 * highest one, the common case for a write's own event and what it reported,
 * are appended; a few below it are inserted in place; many are appended and
 * the log sorted once.
 */
export class EventLogIndex {
  readonly events: Event[];
  private readonly ids = new Set<string>();
  private readonly slots = new Set<number>();
  /** Events whose id carries no slot; {@link maxSlot} throws on the first. */
  private unslotted: string | undefined;
  private max: number | undefined;
  /**
   * Every slot from the first through this one is occupied. The first slot
   * counts as occupied even when absent: it belongs to `run_created`, which
   * may land after a log read that races the run's start (see
   * `findEventSlotGap`).
   */
  private denseThrough = FIRST_EVENT_SLOT;
  /** Whether `events` is in event id order. */
  private sorted = true;
  private trackedLength = 0;

  constructor(events: Event[]) {
    this.events = events;
    let previous: string | undefined;
    for (const event of events) {
      if (previous !== undefined && event.eventId < previous) {
        this.sorted = false;
      }
      previous = event.eventId;
      this.track(event);
    }
    this.advanceWatermark();
    this.trackedLength = events.length;
  }

  /** Whether this index still describes `events`. */
  covers(events: readonly Event[]): boolean {
    return events === this.events && events.length === this.trackedLength;
  }

  has(eventId: string): boolean {
    return this.ids.has(eventId);
  }

  /**
   * The highest slot the log occupies, or `undefined` for an empty log
   * (`maxEventSlot`, which throws for an event id that carries no slot).
   */
  maxSlot(): number | undefined {
    if (this.unslotted !== undefined) requireEventSlot(this.unslotted);
    return this.max;
  }

  /**
   * The highest slot among the events `skip` does not exclude, or
   * `undefined` when it excludes all of them. Excluded events sit at the top
   * of the log (a run-ahead's speculative events, at their predicted slots),
   * so a sorted log is walked down from its end past them.
   */
  maxSlotExcept(skip: (event: Event) => boolean): number | undefined {
    if (this.unslotted !== undefined) requireEventSlot(this.unslotted);
    const events = this.events;
    if (this.sorted) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (!skip(event)) return requireEventSlot(event.eventId);
      }
      return undefined;
    }
    let max: number | undefined;
    for (const event of events) {
      if (skip(event)) continue;
      const slot = requireEventSlot(event.eventId);
      if (max === undefined || slot > max) max = slot;
    }
    return max;
  }

  /**
   * The log's hole, or `undefined` (`findEventSlotGap`). A log that is dense
   * up to its highest slot answers from the watermark; only one with a hole
   * pays the scan that describes it.
   */
  slotGap(): EventSlotGap | undefined {
    if (this.unslotted !== undefined) requireEventSlot(this.unslotted);
    if (this.max === undefined || this.denseThrough >= this.max) {
      return undefined;
    }
    return findEventSlotGap(this.events);
  }

  /**
   * Merges `events` into the log in event id order, skipping ids it already
   * holds, and returns how many were new (`mergeReportedEvents`).
   */
  merge(events: readonly Event[]): number {
    if (events.length === 0) return 0;
    const added: Event[] = [];
    for (const event of events) {
      if (this.ids.has(event.eventId)) continue;
      this.track(event);
      added.push(event);
    }
    if (added.length === 0) return 0;
    const target = this.events;
    let tail = target.length > 0 ? target[target.length - 1]!.eventId : '';
    let inOrder = this.sorted;
    if (inOrder) {
      for (const event of added) {
        if (event.eventId < tail) {
          inOrder = false;
          break;
        }
        tail = event.eventId;
      }
    }
    if (inOrder) {
      for (const event of added) target.push(event);
    } else if (this.sorted && added.length <= MAX_INSERTED_OUT_OF_ORDER) {
      for (const event of added) insertSorted(target, event);
    } else {
      for (const event of added) target.push(event);
      target.sort(byEventId);
      this.sorted = true;
    }
    this.advanceWatermark();
    this.trackedLength = target.length;
    return added.length;
  }

  private track(event: Event): void {
    this.ids.add(event.eventId);
    const slot = eventIdToSlot(event.eventId);
    if (slot === null) {
      this.unslotted ??= event.eventId;
      return;
    }
    this.slots.add(slot);
    if (this.max === undefined || slot > this.max) this.max = slot;
  }

  private advanceWatermark(): void {
    while (this.slots.has(this.denseThrough + 1)) this.denseThrough++;
  }
}

/** Inserts `event` into the sorted `target` after every lower event id. */
function insertSorted(target: Event[], event: Event): void {
  let low = 0;
  let high = target.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (target[mid]!.eventId < event.eventId) low = mid + 1;
    else high = mid;
  }
  target.splice(low, 0, event);
}
