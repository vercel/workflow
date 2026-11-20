import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { dueWaits, openWaits } from './log-state.js';

let slot = 0;
function ev(
  eventType: string,
  correlationId: string,
  eventData: Record<string, unknown>
): Event {
  slot++;
  return {
    eventId: slotToEventId(slot),
    runId: 'wrun_1',
    createdAt: new Date(0),
    eventType,
    correlationId,
    eventData,
  } as unknown as Event;
}

const call = { key: 'k', limit: 1, periodMs: 1_000, expiresAt: new Date(1e13) };

describe('open rate limit calls', () => {
  it('is a waiting call until its rate_acquired or rate_failed', () => {
    const waiting = ev('rate_created', 'rate_a', {
      ...call,
      acquireAt: new Date(10),
    });
    expect(openWaits([waiting])).toMatchObject([
      { kind: 'rate', correlationId: 'rate_a', resumeAtMs: 10 },
    ]);
    expect(
      openWaits([waiting, ev('rate_acquired', 'rate_a', { createdSlot: 1 })])
    ).toEqual([]);
    expect(
      openWaits([
        waiting,
        ev('rate_failed', 'rate_a', { ...call, reason: 'max_wait' }),
      ])
    ).toEqual([]);
  });

  it('follows the newest rate_created of a call reserved again', () => {
    const first = ev('rate_created', 'rate_a', {
      ...call,
      acquireAt: new Date(10),
    });
    const again = ev('rate_created', 'rate_a', {
      ...call,
      acquireAt: new Date(50),
    });
    const [open] = openWaits([first, again]);
    expect(open?.resumeAtMs).toBe(50);
    // Its completion names the newest event's slot.
    expect(open?.event.eventId).toBe(again.eventId);
    expect(dueWaits([first, again], 20)).toEqual([]);
  });

  it('is never woken early by run.wakeUp()', () => {
    const waiting = ev('rate_created', 'rate_b', {
      ...call,
      acquireAt: new Date(10),
    });
    expect(dueWaits([waiting], 0, new Set(['rate_b']))).toEqual([]);
  });
});
