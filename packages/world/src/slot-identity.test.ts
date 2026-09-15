import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import {
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  isSlotBody,
  isSlotEventId,
  slotToEventId,
} from './slot-identity.js';
import { ulidToDate, validateUlidTimestamp } from './ulid.js';

describe('slotToEventId', () => {
  it('mints a fixed-width id whose string order is slot order', () => {
    const ids = [1, 2, 9, 10, 99, 100, 1000].map(slotToEventId);
    for (const id of ids) {
      expect(id).toHaveLength(EVENT_ID_PREFIX.length + EVENT_ID_BODY_LENGTH);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('round-trips through eventIdToSlot', () => {
    for (const slot of [FIRST_EVENT_SLOT, 7, 12345, Number.MAX_SAFE_INTEGER]) {
      expect(eventIdToSlot(slotToEventId(slot))).toBe(slot);
    }
  });

  it('refuses slots it cannot represent exactly', () => {
    expect(() => slotToEventId(0)).toThrow(RangeError);
    expect(() => slotToEventId(-1)).toThrow(RangeError);
    expect(() => slotToEventId(1.5)).toThrow(RangeError);
    expect(() => slotToEventId(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      RangeError
    );
  });
});

describe('isSlotEventId', () => {
  it('reads an id however it is prefixed', () => {
    const body = String(42).padStart(EVENT_ID_BODY_LENGTH, '0');
    expect(isSlotEventId(`evnt_${body}`)).toBe(true);
    expect(isSlotEventId(`wevt_${body}`)).toBe(true);
    expect(isSlotEventId(body)).toBe(true);
    expect(eventIdToSlot(`wevt_${body}`)).toBe(42);
  });

  it('never mistakes a ULID for a slot', () => {
    for (let i = 0; i < 100; i++) {
      const id = ulid();
      expect(isSlotBody(id)).toBe(false);
      expect(eventIdToSlot(`evnt_${id}`)).toBeNull();
    }
  });

  it('rejects bodies of the wrong shape', () => {
    // Right length, but the timestamp region is not all zeros.
    expect(isSlotBody('0000000001'.padEnd(EVENT_ID_BODY_LENGTH, '0'))).toBe(
      false
    );
    // Right prefix of zeros, but a non-digit in the counter region.
    expect(isSlotBody('0'.repeat(EVENT_ID_BODY_LENGTH - 1) + 'A')).toBe(false);
    // Wrong length.
    expect(
      isSlotBody('0'.repeat(EVENT_ID_BODY_LENGTH - 1) + '1'.repeat(2))
    ).toBe(false);
    expect(isSlotBody('')).toBe(false);
  });
});

describe('time is never derived from a slot id', () => {
  it('returns null rather than the epoch', () => {
    // The trap this guards: `decodeTime` on a slot body succeeds and yields 0.
    // A caller that took that at face value would date every event to 1970.
    const body = slotToEventId(1).slice(EVENT_ID_PREFIX.length);
    expect(ulidToDate(body)).toBeNull();
    expect(
      ulidToDate(slotToEventId(999_999).slice(EVENT_ID_PREFIX.length))
    ).toBeNull();
  });

  it('still decodes a real ULID', () => {
    const id = ulid();
    expect(ulidToDate(id)?.getTime()).toBeGreaterThan(0);
  });

  it('fails validation instead of reporting 56 years of drift', () => {
    const slotAsRunId = `wrun_${slotToEventId(1).slice(EVENT_ID_PREFIX.length)}`;
    expect(validateUlidTimestamp(slotAsRunId, 'wrun_')).toMatch(
      /is not a valid ULID/
    );
  });
});
