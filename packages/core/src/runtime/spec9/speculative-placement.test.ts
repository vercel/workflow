import {
  type Event,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  slotToEventId,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  committedBelowPrediction,
  displacesSpeculation,
  foldReadEvents,
  settledOutcomeFold,
  speculativeSlotFor,
} from './speculative-placement.js';

const at = (
  slot: number,
  eventType: Event['eventType'],
  correlationId: string
): Event =>
  ({
    eventId: slotToEventId(slot),
    runId: 'wrun_placement',
    eventType,
    correlationId,
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    createdAt: new Date(0),
  }) as Event;

/** A log's unconfirmed speculative events, looked up by id. */
const speculative = (...events: Event[]) => {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  return (eventId: string) => byId.get(eventId);
};

describe('speculativeSlotFor', () => {
  it('is the prediction when nothing is held at or above it', () => {
    expect(
      speculativeSlotFor({
        predicted: 7,
        heldMaxSlot: 6,
        unconfirmedSlots: [5, 6],
      })
    ).toBe(7);
  });

  it('is one past the highest slot the log holds when the prediction is not above it', () => {
    // The log learned of slots 7 and 8 (a load) that the prediction missed.
    expect(
      speculativeSlotFor({ predicted: 7, heldMaxSlot: 8, unconfirmedSlots: [] })
    ).toBe(9);
  });

  it('is one past an unconfirmed speculative slot the log does not hold yet', () => {
    // An outcome written ahead at slot 9 joins the log only once its step
    // settles; a later prediction that fell back to 8 must not sit below it.
    expect(
      speculativeSlotFor({
        predicted: 8,
        heldMaxSlot: 7,
        unconfirmedSlots: [9],
      })
    ).toBe(10);
  });

  it('places the first event of an empty log at the prediction', () => {
    expect(
      speculativeSlotFor({
        predicted: 1,
        heldMaxSlot: undefined,
        unconfirmedSlots: [],
      })
    ).toBe(1);
  });
});

describe('foldReadEvents', () => {
  const started = at(5, 'step_started', 'step_b');

  it('folds every event when the log holds no speculative event', () => {
    const events = [
      at(4, 'hook_received', 'hook_x'),
      at(5, 'step_completed', 'step_a'),
    ];
    expect(foldReadEvents(events, speculative())).toEqual({
      fold: events,
      displaced: false,
      complete: true,
    });
  });

  it('leaves out the commit of a speculative write read before its answer, and says the read is incomplete', () => {
    // No repair is due: the speculative copy stands for the event. But the
    // event is not in the log by this read, so a reader must not move its
    // position past it (the write's answer may not bring it either).
    const below = at(4, 'hook_received', 'hook_x');
    const above = at(6, 'hook_received', 'hook_x');
    expect(
      foldReadEvents(
        [below, at(5, 'step_started', 'step_b'), above],
        speculative(started)
      )
    ).toEqual({ fold: [below, above], displaced: false, complete: false });
  });

  it('reports an event committed where another event sits speculatively, and folds nothing from it on', () => {
    // The case an incremental load used to drop silently: a step's outcome
    // committed at the slot another step's speculative start was placed at.
    // The log's order is wrong from that slot on, so what follows waits for
    // the repair too.
    const below = at(4, 'hook_received', 'hook_x');
    expect(
      foldReadEvents(
        [
          below,
          at(5, 'step_completed', 'step_a'),
          at(6, 'step_started', 'step_c'),
        ],
        speculative(started)
      )
    ).toEqual({ fold: [below], displaced: true, complete: false });
  });

  it('tells two events of one step apart by type', () => {
    expect(
      foldReadEvents([at(5, 'step_completed', 'step_b')], speculative(started))
        .displaced
    ).toBe(true);
  });

  it('is complete for an empty read', () => {
    expect(foldReadEvents([], speculative(started))).toEqual({
      fold: [],
      displaced: false,
      complete: true,
    });
  });
});

describe('displacesSpeculation', () => {
  const outcome = at(8, 'step_completed', 'step_b');

  it('is false for an event at a slot with no speculative event', () => {
    expect(
      displacesSpeculation(
        at(7, 'step_completed', 'step_a'),
        speculative(outcome)
      )
    ).toBe(false);
  });

  it('is false for the commit of the speculative write itself', () => {
    expect(
      displacesSpeculation(
        at(8, 'step_completed', 'step_b'),
        speculative(outcome)
      )
    ).toBe(false);
  });

  it('is true for another event committed at a speculative slot', () => {
    expect(
      displacesSpeculation(
        at(8, 'step_completed', 'step_a'),
        speculative(outcome)
      )
    ).toBe(true);
  });
});

describe('settledOutcomeFold', () => {
  it('folds an outcome written on the awaited path', () => {
    expect(
      settledOutcomeFold({
        writtenAhead: false,
        unconfirmed: false,
        slotHeld: true,
      })
    ).toBe('fold');
  });

  it('folds an unconfirmed outcome written ahead whose slot is free', () => {
    expect(
      settledOutcomeFold({
        writtenAhead: true,
        unconfirmed: true,
        slotHeld: false,
      })
    ).toBe('fold');
  });

  it('does not fold the speculative copy of an outcome whose write already settled', () => {
    // Whether or not its predicted id is free: the committed event is in
    // the log, and the copy may carry an id that is another event's by now.
    for (const slotHeld of [true, false]) {
      expect(
        settledOutcomeFold({ writtenAhead: true, unconfirmed: false, slotHeld })
      ).toBe('committed');
    }
  });

  it('calls for a repair when an unconfirmed outcome written ahead finds its slot taken', () => {
    expect(
      settledOutcomeFold({
        writtenAhead: true,
        unconfirmed: true,
        slotHeld: true,
      })
    ).toBe('displaced');
  });
});

describe('committedBelowPrediction', () => {
  it('is false when every displaced write committed above its predicted slot', () => {
    expect(
      committedBelowPrediction([
        [slotToEventId(5), slotToEventId(6)],
        [slotToEventId(6), slotToEventId(8)],
      ])
    ).toBe(false);
    expect(committedBelowPrediction([])).toBe(false);
  });

  it('is true when one committed below its predicted slot', () => {
    expect(
      committedBelowPrediction([
        [slotToEventId(5), slotToEventId(6)],
        [slotToEventId(9), slotToEventId(7)],
      ])
    ).toBe(true);
  });

  it('compares slots, not id strings', () => {
    // The same slots under two id prefixes: as strings the committed id
    // sorts first, though it is the higher slot.
    const predicted = slotToEventId(5).replace(/^evnt_/, 'wevt_');
    expect(committedBelowPrediction([[predicted, slotToEventId(6)]])).toBe(
      false
    );
    expect(committedBelowPrediction([[slotToEventId(6), predicted]])).toBe(
      true
    );
  });

  it('ignores an id that carries no slot', () => {
    expect(
      committedBelowPrediction([
        [slotToEventId(5), 'evnt_01M7S8YC8TXN0DKM8K949QVX96'],
      ])
    ).toBe(false);
  });
});
