import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  chainTimersBeforeCompletion,
  invocationResends,
  ownedWaitChains,
  passesResendGate,
  STEP_RESEND_MAX_AGE_MS,
  schedulesWaitTimer,
  stepsToReenqueue,
  waitTimersToArm,
  withRetryCreator,
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
  // Every event `ev` makes is created at the epoch.
  const nowMs = 0;
  const resends = (
    events: Event[],
    extra: Partial<Parameters<typeof stepsToReenqueue>[0]> = {}
  ) =>
    stepsToReenqueue({
      events,
      messageId: MSG,
      deliveryCount: 2,
      nowMs,
      ...extra,
    });

  it('re-sends an unstarted background step on a redelivery of its creator', () => {
    expect(resends([created('step_a')]).resend).toEqual(['step_a']);
  });

  it('never re-sends on a first delivery', () => {
    expect(resends([created('step_a')], { deliveryCount: 1 })).toEqual({
      resend: [],
      tooOld: [],
    });
  });

  it('re-sends an unstarted background step whatever message created it, and on a World with no delivery count', () => {
    // A coalesced re-run or a handoff continuation of another message: the
    // creator's own redelivery may have been coalesced away.
    for (const deliveryCount of [2, 5, undefined]) {
      expect(
        resends([created('step_a')], {
          messageId: 'msg_other',
          deliveryCount,
        }).resend
      ).toEqual(['step_a']);
    }
    // A step created before creators were recorded, too.
    expect(
      resends([created('step_a', { creatorMessageId: undefined })]).resend
    ).toEqual(['step_a']);
  });

  it('never re-sends a step that has started, or one with an outcome', () => {
    expect(
      resends([created('step_a'), ev('step_started', 'step_a')]).resend
    ).toEqual([]);
    expect(
      resends([created('step_a'), ev('step_failed', 'step_a')]).resend
    ).toEqual([]);
  });

  it('leaves a step alone once its creation is past the re-send age bound', () => {
    const events = [created('step_a')];
    expect(
      resends(events, { nowMs: nowMs + STEP_RESEND_MAX_AGE_MS - 1 })
    ).toEqual({ resend: ['step_a'], tooOld: [] });
    expect(resends(events, { nowMs: nowMs + STEP_RESEND_MAX_AGE_MS })).toEqual({
      resend: [],
      tooOld: ['step_a'],
    });
  });

  it('skips the steps the invocation already re-sent or found too old', () => {
    expect(
      resends([created('step_a'), created('step_b')], {
        exclude: new Set(['step_a']),
      }).resend
    ).toEqual(['step_b']);
  });

  it('never re-sends an inline step that has not moved to the background', () => {
    expect(resends([created('step_a', { inline: true })]).resend).toEqual([]);
  });

  it('re-sends an inline step whose retry moved to the background, on a redelivery of the message that moved it, within the age bound of the move', () => {
    const events = [
      created('step_a', { inline: true }),
      ev('step_started', 'step_a'),
      ev('step_retrying', 'step_a', { creatorMessageId: MSG }),
    ];
    expect(resends(events).resend).toEqual(['step_a']);
    expect(
      resends(events, { nowMs: nowMs + STEP_RESEND_MAX_AGE_MS }).tooOld
    ).toEqual(['step_a']);
  });

  it('never re-sends a background retry for another message, or for a World with no delivery count', () => {
    // The step's own message retries in place past the dedupe window; an
    // unrelated orchestrator redelivery must not send it a second message.
    const events = [
      created('step_a', { inline: true, creatorMessageId: 'msg_orch1' }),
      ev('step_started', 'step_a'),
      ev('step_retrying', 'step_a', { creatorMessageId: 'msg_orch1' }),
      ev('step_started', 'step_a'),
      ev('step_retrying', 'step_a'),
    ];
    for (const deliveryCount of [2, undefined]) {
      expect(
        resends(events, { messageId: 'msg_unrelated_hook', deliveryCount })
          .resend
      ).toEqual([]);
      // Nor the orchestrator that moved it, once the step's own message has
      // started it: that message owns it until it ends.
      expect(
        resends(events, { messageId: 'msg_orch1', deliveryCount }).resend
      ).toEqual([]);
    }
  });

  it('never re-sends an inline retry another message moved, or one without a recorded creator', () => {
    const moved = (extra: Record<string, unknown>) => [
      created('step_a', { inline: true }),
      ev('step_started', 'step_a'),
      ev('step_retrying', 'step_a', extra),
    ];
    expect(
      resends(moved({ creatorMessageId: 'msg_orch1' }), {
        messageId: 'msg_other',
      }).resend
    ).toEqual([]);
    expect(resends(moved({})).resend).toEqual([]);
  });

  it('on recovery re-sends every step that runs from its own message, started or not, on a first delivery and past the age bound', () => {
    const events = [
      created('step_unstarted'),
      created('step_started'),
      ev('step_started', 'step_started'),
      created('step_done'),
      ev('step_started', 'step_done'),
      ev('step_completed', 'step_done'),
      created('step_inline', { inline: true }),
      ev('step_started', 'step_inline'),
      created('step_inline_retried', { inline: true }),
      ev('step_started', 'step_inline_retried'),
      ev('step_retrying', 'step_inline_retried'),
      ev('step_started', 'step_inline_retried'),
    ];
    expect(
      resends(events, {
        recovery: true,
        deliveryCount: 1,
        messageId: 'msg_recovery',
        nowMs: nowMs + 2 * STEP_RESEND_MAX_AGE_MS,
      })
    ).toEqual({
      resend: ['step_unstarted', 'step_started', 'step_inline_retried'],
      tooOld: [],
    });
  });
});

describe('passesResendGate', () => {
  it('passes any delivery but the first of its message, and every recovery delivery', () => {
    expect(passesResendGate({ deliveryCount: 1 })).toBe(false);
    expect(passesResendGate({ deliveryCount: 2 })).toBe(true);
    expect(passesResendGate({ deliveryCount: undefined })).toBe(true);
    expect(passesResendGate({ deliveryCount: 1, recovery: true })).toBe(true);
  });
});

describe('invocationResends', () => {
  it('shares one state across the coalesced re-runs of an invocation, and none without an invocation start', () => {
    const key = { runId: 'wrun_1', messageId: MSG, invocationStartedAt: 42 };
    const state = invocationResends(key);
    state.sent.add('step_a');
    expect(invocationResends(key)).toBe(state);
    expect(
      invocationResends({ ...key, invocationStartedAt: 43 }).sent.size
    ).toBe(0);
    expect(
      invocationResends({ ...key, messageId: 'msg_other' }).sent.size
    ).toBe(0);
    const unkeyed = { ...key, invocationStartedAt: undefined };
    expect(invocationResends(unkeyed)).not.toBe(invocationResends(unkeyed));
  });
});

describe('withRetryCreator', () => {
  it('stamps only a step_retrying', () => {
    expect(
      withRetryCreator(
        { eventType: 'step_retrying', eventData: { attempt: 1 } },
        MSG
      )
    ).toEqual({
      eventType: 'step_retrying',
      eventData: { attempt: 1, creatorMessageId: MSG },
    });
    const completed = { eventType: 'step_completed', eventData: {} };
    expect(withRetryCreator(completed, MSG)).toBe(completed);
    const retrying = { eventType: 'step_retrying', eventData: {} };
    expect(withRetryCreator(retrying, undefined)).toBe(retrying);
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

  it("names each completing wait's chain's next open wait, except the timer's own and creatorless ones", () => {
    const open = [
      { correlationId: 'a1', resumeAtMs: 10, event: wait('a1', 'msg_a') },
      { correlationId: 'a2', resumeAtMs: 30, event: wait('a2', 'msg_a') },
      { correlationId: 'a3', resumeAtMs: 20, event: wait('a3', 'msg_a') },
      { correlationId: 'b1', resumeAtMs: 10, event: wait('b1', 'msg_b') },
      { correlationId: 'b2', resumeAtMs: 40, event: wait('b2', 'msg_b') },
      { correlationId: 'c1', resumeAtMs: 10, event: wait('c1', 'msg_c') },
      { correlationId: 'c2', resumeAtMs: 40, event: wait('c2', 'msg_c') },
      { correlationId: 'x1', resumeAtMs: 10, event: wait('x1') },
      { correlationId: 'x2', resumeAtMs: 40, event: wait('x2') },
    ];
    const next = (completing: string[], timerFor?: string) =>
      chainTimersBeforeCompletion({ openWaits: open, completing, timerFor })
        .map((w) => w.correlationId)
        .sort();
    // a1 and a3 complete together: a2 is next.
    expect(next(['a1', 'a3', 'b1', 'x1'])).toEqual(['a2', 'b2']);
    expect(next(['a1', 'c1'], 'c1')).toEqual(['a3']);
    // The last wait of its chain: nothing to arm.
    expect(next(['b1', 'b2'])).toEqual([]);
  });
});
