import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  ownedWaitChains,
  schedulesWaitTimer,
  stepsToReenqueue,
  waitTimersToArm,
} from './creator-rules.js';

let slot = 0;
function ev(
  eventType: string,
  correlationId: string,
  eventData: Record<string, unknown> = {}
): Event {
  slot++;
  return {
    eventId: slotToEventId(slot),
    runId: 'wrun_1',
    createdAt: new Date(0),
    eventType,
    correlationId,
    eventData: { stepName: 's', input: new Uint8Array(), ...eventData },
  } as unknown as Event;
}

const MSG = 'msg_creator';

describe('stepsToReenqueue', () => {
  const created = (cid: string, extra: Record<string, unknown> = {}) =>
    ev('step_created', cid, {
      inline: false,
      creatorMessageId: MSG,
      ...extra,
    });

  it('re-enqueues an unstarted background step on a redelivery of its creator', () => {
    expect(
      stepsToReenqueue({
        events: [created('step_a')],
        messageId: MSG,
        deliveryCount: 2,
      })
    ).toEqual(['step_a']);
  });

  it('never re-enqueues on a first delivery', () => {
    expect(
      stepsToReenqueue({
        events: [created('step_a')],
        messageId: MSG,
        deliveryCount: 1,
      })
    ).toEqual([]);
  });

  it('never re-enqueues from another message', () => {
    expect(
      stepsToReenqueue({
        events: [created('step_a')],
        messageId: 'msg_other',
        deliveryCount: 3,
      })
    ).toEqual([]);
  });

  it('never re-enqueues a step that has started', () => {
    expect(
      stepsToReenqueue({
        events: [created('step_a'), ev('step_started', 'step_a')],
        messageId: MSG,
        deliveryCount: 2,
      })
    ).toEqual([]);
  });

  it('never re-enqueues an inline step that has not moved to the background', () => {
    expect(
      stepsToReenqueue({
        events: [created('step_a', { inline: true })],
        messageId: MSG,
        deliveryCount: 2,
      })
    ).toEqual([]);
  });

  it('re-enqueues an inline step whose retry moved to the background', () => {
    expect(
      stepsToReenqueue({
        events: [
          created('step_a', { inline: true }),
          ev('step_started', 'step_a'),
          ev('step_retrying', 'step_a'),
        ],
        messageId: MSG,
        deliveryCount: 2,
      })
    ).toEqual(['step_a']);
  });
});

describe('wait timer ownership', () => {
  const wait = (correlationId: string, creatorMessageId?: string, at = 0) =>
    ev('wait_created', correlationId, {
      resumeAt: new Date(at),
      creatorMessageId,
    });
  const owns = (
    params: Partial<Parameters<typeof ownedWaitChains>[0]> & {
      events: Event[];
    }
  ) =>
    ownedWaitChains({
      messageId: 'msg_wake',
      completedWaits: [],
      timerFor: undefined,
      redelivery: false,
      ...params,
    });

  it('owns its own message chain, and no other by default', () => {
    const events = [wait('wait_a', MSG)];
    expect([...owns({ events, messageId: MSG })]).toEqual([MSG]);
    expect(
      schedulesWaitTimer({
        wait: events[0],
        correlationId: 'wait_a',
        timerFor: undefined,
        ownedChains: owns({ events }),
      })
    ).toBe(false);
  });

  it('owns the chain of a wait it completed, whatever its message', () => {
    const events = [wait('wait_a', MSG), wait('wait_b', MSG)];
    const ownedChains = owns({ events, completedWaits: ['wait_a'] });
    expect(ownedChains.has(MSG)).toBe(true);
    expect(
      schedulesWaitTimer({
        wait: events[1],
        correlationId: 'wait_b',
        timerFor: undefined,
        ownedChains,
      })
    ).toBe(true);
  });

  it("owns a timer's chain on a redelivery of the timer only", () => {
    const events = [wait('wait_a', MSG), wait('wait_b', MSG)];
    expect(owns({ events, timerFor: 'wait_a' }).has(MSG)).toBe(false);
    expect(
      owns({ events, timerFor: 'wait_a', redelivery: true }).has(MSG)
    ).toBe(true);
  });

  it('re-arms from the wait timer delivery itself', () => {
    expect(
      schedulesWaitTimer({
        wait: wait('wait_a', MSG),
        correlationId: 'wait_a',
        timerFor: 'wait_a',
        ownedChains: new Set(['msg_timer']),
      })
    ).toBe(true);
  });

  it('schedules a wait this delivery is about to write', () => {
    expect(
      schedulesWaitTimer({
        wait: undefined,
        correlationId: 'wait_a',
        timerFor: undefined,
        ownedChains: new Set(['msg_wake']),
      })
    ).toBe(true);
  });

  it('arms the earliest wait of each chain, and the timer delivery its own wait', () => {
    const open = [
      { correlationId: 'a1', resumeAtMs: 10, event: wait('a1', 'msg_a') },
      { correlationId: 'a2', resumeAtMs: 5, event: wait('a2', 'msg_a') },
      { correlationId: 'b1', resumeAtMs: 20, event: wait('b1', 'msg_b') },
      // Not in the log yet: in the chain of this delivery's message.
      { correlationId: 'own', resumeAtMs: 30 },
    ];
    expect(
      waitTimersToArm(open, 'msg_own', undefined)
        .map((wait) => wait.correlationId)
        .sort()
    ).toEqual(['a2', 'b1', 'own']);
    expect(
      waitTimersToArm(open, 'msg_own', 'a1')
        .map((wait) => wait.correlationId)
        .sort()
    ).toEqual(['a1', 'a2', 'b1', 'own']);
  });
});
