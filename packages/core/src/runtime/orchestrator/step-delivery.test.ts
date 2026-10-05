import { type Event, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  decideStepDelivery,
  firstDeliveryDecision,
  stepDeliveryNeedsLogRead,
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

  it('takes the message attempt on the happy path', () => {
    expect(firstDeliveryDecision(undefined)).toEqual({
      action: 'run',
      attempt: 1,
      startReason: 'first',
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
    ).toEqual({ action: 'run', attempt: 2, startReason: 'retry' });
  });

  it('marks a start after a start with no outcome as a redelivery', () => {
    const events = [ev('step_created'), ev('step_started')];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 3, nowMs: NOW })
    ).toEqual({ action: 'run', attempt: 2, startReason: 'redelivery' });
  });

  it('runs a never-started step as its first attempt', () => {
    expect(
      decideStepDelivery({
        events: [ev('step_created')],
        stepId: STEP,
        maxRetries: 0,
        nowMs: NOW,
      })
    ).toEqual({ action: 'run', attempt: 1, startReason: 'first' });
  });

  it('fails a maxRetries: 0 step that already started (at most once)', () => {
    const events = [ev('step_created'), ev('step_started')];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 0, nowMs: NOW })
    ).toEqual({ action: 'fail', attempt: 2, reason: 'max-retries' });
  });

  it('fails a step whose attempts exceed maxRetries + 1', () => {
    const events = [
      ev('step_created'),
      ev('step_started'),
      ev('step_retrying'),
      ev('step_started'),
    ];
    expect(
      decideStepDelivery({ events, stepId: STEP, maxRetries: 1, nowMs: NOW })
    ).toEqual({ action: 'fail', attempt: 3, reason: 'max-retries' });
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
    ).toEqual({ action: 'run', attempt: 1, startReason: 'first' });
  });
});
