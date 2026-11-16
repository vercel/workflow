import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  decideStepDelivery,
  firstDeliveryDecision,
  mayBePendingRetry,
  pendingRetryDecision,
  STEP_DELIVERY_STALL_WINDOW_MS,
  stepDeliveryNeedsLogRead,
  stepDeliveryStalled,
} from './step-delivery.js';

const STEP = 'step_a';
let slot = 0;
function ev(eventType: string, extra: Record<string, unknown> = {}): Event {
  slot++;
  return {
    eventId: slotToEventId(slot),
    runId: 'wrun_1',
    createdAt: new Date(0),
    eventType,
    correlationId: eventType.startsWith('run_') ? undefined : STEP,
    eventData: { stepName: 's', ...extra },
  } as unknown as Event;
}

const NOW = 1_000_000;

describe('stepDeliveryNeedsLogRead', () => {
  it('skips the read only on a first delivery that is not a retry', () => {
    expect(
      stepDeliveryNeedsLogRead({ deliveryCount: 1, stepAttempt: undefined })
    ).toBe(false);
    expect(stepDeliveryNeedsLogRead({ deliveryCount: 1, stepAttempt: 1 })).toBe(
      false
    );
    expect(
      stepDeliveryNeedsLogRead({ deliveryCount: 2, stepAttempt: undefined })
    ).toBe(true);
    expect(
      stepDeliveryNeedsLogRead({ deliveryCount: undefined, stepAttempt: 1 })
    ).toBe(true);
    expect(stepDeliveryNeedsLogRead({ deliveryCount: 1, stepAttempt: 2 })).toBe(
      true
    );
  });

  it('reads the log on the first delivery of a re-sent message', () => {
    expect(
      stepDeliveryNeedsLogRead({
        deliveryCount: 1,
        stepAttempt: undefined,
        stepResent: true,
      })
    ).toBe(true);
  });

  it('takes the message attempt on the happy path', () => {
    expect(firstDeliveryDecision(undefined)).toEqual({
      action: 'run',
      attempt: 1,
    });
  });
});

describe('decideStepDelivery', () => {
  it('acks without a body when the step is terminal', () => {
    const events = [
      ev('step_created'),
      ev('step_started'),
      ev('step_completed'),
    ];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toEqual({ action: 'ack', reason: 'step-terminal' });
  });

  it('acks without a body when the run is terminal', () => {
    const events = [ev('step_created'), ev('run_cancelled')];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toEqual({ action: 'ack', reason: 'run-terminal' });
  });

  it('redelivers when retryAfter is not reached yet', () => {
    const events = [
      ev('step_created'),
      ev('step_started'),
      ev('step_retrying', { retryAfter: new Date(NOW + 10_500) }),
    ];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toEqual({
      action: 'redeliver',
      timeoutSeconds: 11,
      reason: 'retry-after',
    });
  });

  it('runs a due retry with attempt = starts + 1 and reason retry', () => {
    const events = [
      ev('step_created'),
      ev('step_started'),
      ev('step_retrying', { retryAfter: new Date(NOW - 1) }),
    ];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toMatchObject({
      action: 'run',
      attempt: 2,
      firstStartedAt: expect.any(Date),
    });
  });

  it('marks a start after a start with no outcome as a redelivery', () => {
    const events = [ev('step_created'), ev('step_started')];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toMatchObject({ action: 'run', attempt: 2 });
  });

  it('runs a never-started step as its first attempt', () => {
    expect(
      decideStepDelivery({
        events: [ev('step_created')],
        stepId: STEP,
        maxRetries: 0,
        nowMs: NOW,
      })
    ).toEqual({ action: 'run', attempt: 1 });
  });

  it('fails a maxRetries: 0 step that already started (at most once)', () => {
    const started = ev('step_started');
    const events = [ev('step_created'), started];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 0, nowMs: NOW })
    ).toEqual({
      action: 'fail',
      attempt: 2,
      reason: 'max-retries',
      lastStartedAt: new Date(started.createdAt),
    });
  });

  it('fails a step whose attempts exceed maxRetries + 1', () => {
    const firstStart = ev('step_started');
    const lastStart = { ...ev('step_started'), createdAt: new Date(NOW) };
    const events = [
      ev('step_created'),
      firstStart,
      ev('step_retrying'),
      lastStart,
    ];
    // The failure reports the start of the attempt that left no outcome.
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 1, nowMs: NOW })
    ).toEqual({
      action: 'fail',
      attempt: 3,
      reason: 'max-retries',
      lastStartedAt: new Date(NOW),
    });
  });

  it('ignores other steps', () => {
    const other = { ...ev('step_completed'), correlationId: 'step_b' } as Event;
    expect(
      decideStepDelivery({
        events: [ev('step_created'), other],
        stepId: STEP,
        maxRetries: 3,
        nowMs: NOW,
      })
    ).toEqual({ action: 'run', attempt: 1 });
  });
});

describe('stepDeliveryStalled', () => {
  const WINDOW = STEP_DELIVERY_STALL_WINDOW_MS;
  const at = (ms: number, eventType: string, extra = {}) => ({
    ...ev(eventType, extra),
    createdAt: new Date(ms),
  });
  const stalled = (events: Event[], nowMs: number) =>
    stepDeliveryStalled({ events, stepId: STEP, nowMs });

  it('is stalled once the step shows no activity for the whole window', () => {
    const events = [at(0, 'step_created')];
    expect(stalled(events, WINDOW - 1)).toBe(false);
    expect(stalled(events, WINDOW + 1)).toBe(true);
    // No creation in the log at all (a read behind the write): stalled.
    expect(stalled([], 0)).toBe(true);
  });

  it('counts a recent start, and the time a retry was due', () => {
    expect(
      stalled([at(0, 'step_created'), at(WINDOW, 'step_started')], WINDOW + 1)
    ).toBe(false);
    const retrying = at(0, 'step_retrying', {
      retryAfter: new Date(3 * WINDOW),
    });
    expect(stalled([at(0, 'step_created'), retrying], 3 * WINDOW + 1)).toBe(
      false
    );
    expect(stalled([at(0, 'step_created'), retrying], 4 * WINDOW + 1)).toBe(
      true
    );
  });

  it("ignores other steps' events", () => {
    const other = { ...at(WINDOW, 'step_started'), correlationId: 'step_b' };
    expect(stalled([at(0, 'step_created'), other], WINDOW + 1)).toBe(true);
  });
});

describe('pendingRetryDecision', () => {
  it('defers until a retryAfter still ahead, from the step retrying event alone', () => {
    expect(
      pendingRetryDecision(
        ev('step_retrying', { retryAfter: new Date(NOW + 10_500) }),
        NOW
      )
    ).toEqual({
      action: 'redeliver',
      timeoutSeconds: 11,
      reason: 'retry-after',
    });
  });

  it('accepts retryAfter as a string, as a lazily read event carries it', () => {
    expect(
      pendingRetryDecision(
        ev('step_retrying', {
          retryAfter: new Date(NOW + 2_000).toISOString(),
        }),
        NOW
      )
    ).toMatchObject({ action: 'redeliver', timeoutSeconds: 2 });
  });

  it('leaves every other case to the full log read', () => {
    // Due, or past.
    expect(
      pendingRetryDecision(
        ev('step_retrying', { retryAfter: new Date(NOW) }),
        NOW
      )
    ).toBeUndefined();
    // No retryAfter, or an unreadable one.
    expect(pendingRetryDecision(ev('step_retrying'), NOW)).toBeUndefined();
    expect(
      pendingRetryDecision(ev('step_retrying', { retryAfter: 'soon' }), NOW)
    ).toBeUndefined();
    // Any other latest event: a start, an outcome, a creation, nothing.
    for (const type of [
      'step_started',
      'step_completed',
      'step_failed',
      'step_created',
    ]) {
      expect(pendingRetryDecision(ev(type), NOW)).toBeUndefined();
    }
    expect(pendingRetryDecision(undefined, NOW)).toBeUndefined();
  });
});

describe('mayBePendingRetry', () => {
  it('tries the step read on a redelivery, an unknown count, or a retry moved to the background', () => {
    expect(
      mayBePendingRetry({ deliveryCount: 2, stepAttempt: undefined })
    ).toBe(true);
    expect(
      mayBePendingRetry({ deliveryCount: undefined, stepAttempt: undefined })
    ).toBe(true);
    expect(mayBePendingRetry({ deliveryCount: 1, stepAttempt: 2 })).toBe(true);
    // A re-sent message's first delivery: its step never started.
    expect(
      mayBePendingRetry({ deliveryCount: 1, stepAttempt: undefined })
    ).toBe(false);
  });
});
