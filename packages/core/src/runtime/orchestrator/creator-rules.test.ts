import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { schedulesWaitTimer, stepsToReenqueue } from './creator-rules.js';

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

describe('schedulesWaitTimer', () => {
  const wait = (creatorMessageId?: string) =>
    ev('wait_created', 'wait_a', {
      resumeAt: new Date(0),
      creatorMessageId,
    });

  it('schedules from the creating invocation and its redeliveries', () => {
    expect(
      schedulesWaitTimer({
        wait: wait(MSG),
        correlationId: 'wait_a',
        messageId: MSG,
        timerFor: undefined,
      })
    ).toBe(true);
  });

  it('does not schedule from another delivery', () => {
    expect(
      schedulesWaitTimer({
        wait: wait(MSG),
        correlationId: 'wait_a',
        messageId: 'msg_wake',
        timerFor: undefined,
      })
    ).toBe(false);
  });

  it('re-arms from the wait timer delivery itself', () => {
    expect(
      schedulesWaitTimer({
        wait: wait(MSG),
        correlationId: 'wait_a',
        messageId: 'msg_timer',
        timerFor: 'wait_a',
      })
    ).toBe(true);
  });

  it('schedules a wait this delivery is about to write', () => {
    expect(
      schedulesWaitTimer({
        wait: undefined,
        correlationId: 'wait_a',
        messageId: 'msg_wake',
        timerFor: undefined,
      })
    ).toBe(true);
  });
});
