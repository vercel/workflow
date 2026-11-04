import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  findEventSlotGap,
  maxEventSlot,
  mergeReportedEvents,
} from '../helpers.js';
import { EventLogIndex } from './log-index.js';

const at = (slot: number): Event =>
  ({
    eventId: slotToEventId(slot),
    eventType: 'step_completed',
    runId: 'wrun_index',
    correlationId: `step_${slot}`,
    createdAt: new Date(slot),
  }) as unknown as Event;
const slots = (...values: number[]) => values.map(at);

/** A deterministic shuffle, so a failure reproduces. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe('EventLogIndex', () => {
  it('answers what the log helpers answer, over random merges', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const random = rng(seed);
      const reference: Event[] = slots(1, 2, 3);
      const events: Event[] = slots(1, 2, 3);
      const index = new EventLogIndex(events);
      for (let round = 0; round < 40; round++) {
        // Mostly the next slots above the tail, sometimes a few below it or a
        // duplicate, now and then a jump that leaves a hole.
        const top = maxEventSlot(reference) ?? 0;
        const batch: Event[] = [];
        const count = 1 + Math.floor(random() * 4);
        for (let i = 0; i < count; i++) {
          const roll = random();
          const slot =
            roll < 0.7
              ? top + 1 + i
              : roll < 0.9
                ? Math.max(1, top - Math.floor(random() * 6))
                : top + 2 + Math.floor(random() * 5);
          batch.push(at(slot));
        }
        if (random() < 0.3) batch.reverse();
        expect(index.merge(batch)).toBe(mergeReportedEvents(reference, batch));
        expect(events.map((e) => e.eventId)).toEqual(
          reference.map((e) => e.eventId)
        );
        expect(index.maxSlot()).toBe(maxEventSlot(reference));
        expect(index.slotGap()).toEqual(findEventSlotGap(reference));
        expect(index.covers(events)).toBe(true);
      }
    }
  });

  it('sorts a log loaded out of order on its first merge, as the helper does', () => {
    const events = slots(1, 3, 2);
    const index = new EventLogIndex(events);
    expect(index.maxSlot()).toBe(3);
    expect(index.slotGap()).toBeUndefined();
    expect(index.merge(slots(4))).toBe(1);
    expect(events.map((e) => e.eventId)).toEqual(
      slots(1, 2, 3, 4).map((e) => e.eventId)
    );
  });

  it('reports a hole, does not count a missing first slot as one, and closes it once filled', () => {
    const events = slots(2, 3);
    const index = new EventLogIndex(events);
    expect(index.slotGap()).toBeUndefined();
    index.merge(slots(6));
    expect(index.slotGap()).toEqual({
      firstMissingSlot: 4,
      missingCount: 2,
      maxSlot: 6,
    });
    index.merge(slots(5, 4));
    expect(index.slotGap()).toBeUndefined();
    index.merge(slots(1));
    expect(events.map((e) => e.eventId)).toEqual(
      slots(1, 2, 3, 4, 5, 6).map((e) => e.eventId)
    );
  });

  it('skips the excluded top of the log for the highest slot', () => {
    const events = slots(1, 2, 3, 4, 5);
    const index = new EventLogIndex(events);
    const speculative = new Set([events[3], events[4]]);
    expect(index.maxSlotExcept((event) => speculative.has(event))).toBe(3);
    expect(index.maxSlotExcept(() => true)).toBeUndefined();
  });

  it('no longer covers its log once the log is replaced or changed outside it', () => {
    const events = slots(1, 2, 3);
    const index = new EventLogIndex(events);
    expect(index.covers(events)).toBe(true);
    expect(index.covers([...events])).toBe(false);
    events.splice(2, 1);
    expect(index.covers(events)).toBe(false);
  });

  it('throws for an event id without a slot, as maxEventSlot does', () => {
    const events = [
      ...slots(1),
      { ...at(2), eventId: 'evnt_not_a_slot' } as Event,
    ];
    const index = new EventLogIndex(events);
    expect(() => maxEventSlot(events)).toThrow();
    expect(() => index.maxSlot()).toThrow();
    expect(() => index.slotGap()).toThrow();
  });
});
