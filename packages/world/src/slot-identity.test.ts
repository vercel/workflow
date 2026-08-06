import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FIRST_SLOT,
  isSlotId,
  MAX_SLOT,
  maxSlotOf,
  SLOT_ID_WIDTH,
  slotEventId,
  slotFromId,
  slotIdBody,
} from './slot-identity.js';
import { ulidToDate } from './ulid.js';

describe('slotIdBody', () => {
  it('pads to ULID width so a slot is accepted wherever a ULID is', () => {
    const body = slotIdBody(FIRST_SLOT);
    expect(body).toHaveLength(SLOT_ID_WIDTH);
    expect(`evnt_${body}`).toHaveLength(`evnt_${ulid()}`.length);
    // Crockford base32 starts with the decimal digits, so the padded body
    // satisfies the ULID syntax — this is what keeps every existing schema,
    // sort key and range fence working unchanged.
    expect(z.string().ulid().safeParse(body).success).toBe(true);
  });

  it('orders lexicographically by slot at a fixed width', () => {
    const ascending = [1, 2, 9, 10, 100].map(slotIdBody);
    expect([...ascending].sort()).toEqual(ascending);
  });

  it('rejects slots outside the dense numbering', () => {
    expect(() => slotIdBody(0)).toThrow();
    expect(() => slotIdBody(-1)).toThrow();
    expect(() => slotIdBody(1.5)).toThrow();
  });

  it('rejects a slot too large for exact arithmetic', () => {
    expect(slotIdBody(MAX_SLOT)).toHaveLength(SLOT_ID_WIDTH);
    expect(() => slotIdBody(MAX_SLOT + 1)).toThrow(RangeError);
    // 1e21 is an integer that `String` renders as `1e+21`, which pads to
    // exactly 26 characters. A width check alone would pass it and mint
    // `0000000000000000000001e+21` as an id.
    expect(() => slotIdBody(1e21)).toThrow(RangeError);
  });
});

describe('slotFromId', () => {
  it('round-trips a prefixed id', () => {
    expect(slotFromId(`step_${slotIdBody(42)}`)).toBe(42);
  });

  it('round-trips a bare body', () => {
    expect(slotFromId(slotIdBody(42))).toBe(42);
  });

  it('reads no slot out of a ULID id', () => {
    expect(slotFromId(`evnt_${ulid()}`)).toBeUndefined();
    expect(isSlotId(`evnt_${ulid()}`)).toBe(false);
  });

  it('reads no slot out of the all-zero range fence', () => {
    // Slot 0 is the inclusive lower fence for range queries over a run's
    // events, never an event.
    expect(slotFromId('0'.repeat(SLOT_ID_WIDTH))).toBeUndefined();
  });

  it('reads no slot out of a body past exact arithmetic', () => {
    // A 26-digit decimal can name a number a double cannot hold. Reading one
    // as a slot would seed `maxSlotOf`, and every id derived from it by
    // addition would be one this module minted and cannot parse back, so it
    // reads as a ULID and is rejected downstream as an identity mismatch.
    expect(slotFromId(`evnt_${'9'.repeat(SLOT_ID_WIDTH)}`)).toBeUndefined();
    expect(slotFromId(`evnt_${slotIdBody(MAX_SLOT)}`)).toBe(MAX_SLOT);
  });

  it('reads no slot out of a body of the wrong width', () => {
    expect(slotFromId('evnt_1')).toBeUndefined();
    expect(slotFromId(`evnt_${'1'.repeat(SLOT_ID_WIDTH + 1)}`)).toBeUndefined();
  });
});

describe('a slot carries no timestamp', () => {
  it('reports no time rather than epoch 0', () => {
    // Passing the ULID syntax check is what makes a slot portable; decoding a
    // *time* out of one is always a bug. Two that this guards: the sandbox
    // clock is set from the events it consumes, so epoch 0 would rewind a
    // replaying workflow's `Date.now()` to 1970; and world-local prefilters
    // cursor pagination on the time in the filename, so epoch 0 would hide
    // every slot-numbered event from an ascending page.
    expect(ulidToDate(slotIdBody(FIRST_SLOT))).toBeNull();
    expect(ulidToDate(slotEventId(FIRST_SLOT))).toBeNull();
    expect(ulidToDate(slotIdBody(123_456))).toBeNull();
  });

  it('still reads the time out of a ULID', () => {
    expect(ulidToDate(ulid())?.getTime()).toBeGreaterThan(0);
  });
});

describe('maxSlotOf', () => {
  it('finds the highest slot regardless of position', () => {
    // A log is merged from several loads and is not sorted, so the last element
    // is not necessarily the highest slot.
    expect(
      maxSlotOf([slotEventId(3), slotEventId(7), slotEventId(1)].map(toEvent))
    ).toBe(7);
  });

  it('reports 0 for an empty or ULID-numbered log', () => {
    expect(maxSlotOf([])).toBe(0);
    expect(maxSlotOf([toEvent(`evnt_${ulid()}`)])).toBe(0);
  });

  it('ignores ULID ids mixed in with slots', () => {
    // A mixed log violates slot identity's purity invariant, but the scan must
    // still report the highest slot rather than throwing or returning 0.
    expect(
      maxSlotOf([toEvent(`evnt_${ulid()}`), toEvent(slotEventId(2))])
    ).toBe(2);
  });
});

function toEvent(eventId: string): { eventId: string } {
  return { eventId };
}
