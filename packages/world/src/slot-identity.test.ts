import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  FIRST_SLOT,
  isSlotId,
  SLOT_ID_WIDTH,
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
    // parses as a ULID — this is what keeps every existing schema, sort key and
    // range fence working unchanged.
    expect(ulidToDate(body)).not.toBeNull();
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

  it('reads no slot out of a body of the wrong width', () => {
    expect(slotFromId('evnt_1')).toBeUndefined();
    expect(slotFromId(`evnt_${'1'.repeat(SLOT_ID_WIDTH + 1)}`)).toBeUndefined();
  });
});
