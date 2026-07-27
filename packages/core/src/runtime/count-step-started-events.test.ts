import { type Event, SPEC_VERSION_CURRENT } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { countStepStartedEvents } from './count-step-started-events.js';

describe('countStepStartedEvents', () => {
  const stepId = 'step_TARGET';
  let seq = 0;
  const start = (ownerMessageId?: string, correlationId = stepId): Event =>
    ({
      eventType: 'step_started',
      runId: 'wrun_count_test',
      eventId: `evnt_${String(seq++).padStart(4, '0')}`,
      createdAt: new Date(),
      specVersion: SPEC_VERSION_CURRENT,
      correlationId,
      eventData: {
        stepName: 'step//file//fn',
        ...(ownerMessageId !== undefined ? { ownerMessageId } : {}),
      },
    }) as Event;

  it('returns 0 for null/undefined/empty logs', () => {
    expect(countStepStartedEvents(null, stepId)).toBe(0);
    expect(countStepStartedEvents(undefined, stepId)).toBe(0);
    expect(countStepStartedEvents([], stepId)).toBe(0);
  });

  it('unscoped: counts every step_started for the step, ignoring other steps and event types', () => {
    const events: Event[] = [
      start('msg_A'),
      start(undefined),
      start('msg_B', 'step_OTHER'),
      {
        eventType: 'step_completed',
        runId: 'wrun_count_test',
        eventId: 'evnt_done',
        createdAt: new Date(),
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
        eventData: { result: undefined },
      } as unknown as Event,
    ];
    expect(countStepStartedEvents(events, stepId)).toBe(2);
  });

  it('ownedBy: counts only starts stamped with the given messageId', () => {
    const events: Event[] = [
      start('msg_OWNER'), // this message's real attempt 1
      start('msg_RACER_1'), // stale replay racing the batch
      start('msg_RACER_2'), // wake replay racing the batch
      start(undefined), // bare start from a dispatched step message
      start('msg_OWNER'), // this message's recovery re-run (attempt 2)
    ];
    expect(
      countStepStartedEvents(events, stepId, {
        type: 'ownedBy',
        messageId: 'msg_OWNER',
      })
    ).toBe(2);
  });

  it('totalAttempts: bare starts plus the largest single owner, so racer one-off stamps do not accumulate', () => {
    const events: Event[] = [
      start('msg_OWNER'),
      start('msg_OWNER'),
      start('msg_RACER_1'),
      start('msg_RACER_2'),
      start(undefined),
    ];
    // 1 bare + max-per-owner 2 (msg_OWNER) = 3; the racers' single starts
    // are shadowed by the owner's larger count.
    expect(
      countStepStartedEvents(events, stepId, { type: 'totalAttempts' })
    ).toBe(3);
  });

  it('regression (workflow#3069): racing invocations must not exhaust the owned-recovery retry ceiling', () => {
    // Shape observed in the inline-batches CI flake: the owning message
    // started the step once, and concurrent invocations racing on the same
    // pending batch (each stamping its own messageId, plus a bare start from
    // a dispatched step message) wrote duplicate starts for the same logical
    // attempt. With maxRetries=3 the guard fires when attempt > 4.
    const events: Event[] = [
      start('msg_OWNER'),
      start('msg_RACER_1'),
      start('msg_RACER_2'),
      start(undefined),
    ];
    const maxRetries = 3;

    // Unscoped counting (the old behavior) reads 4 prior starts, so the
    // owner's recovery re-run would compute attempt 5 > 4 and fail the run
    // with a false "exceeded max retries".
    const unscopedAttempt = countStepStartedEvents(events, stepId) + 1;
    expect(unscopedAttempt).toBeGreaterThan(maxRetries + 1);

    // Owner-scoped counting reads only the owner's single real attempt: the
    // recovery re-run is attempt 2, comfortably inside the ceiling.
    const ownedAttempt =
      countStepStartedEvents(events, stepId, {
        type: 'ownedBy',
        messageId: 'msg_OWNER',
      }) + 1;
    expect(ownedAttempt).toBe(2);
    expect(ownedAttempt).toBeLessThanOrEqual(maxRetries + 1);

    // The background ceiling's lifecycle total stays inside it too (1 owner
    // attempt + 1 bare attempt → next attempt 3).
    const totalAttempt =
      countStepStartedEvents(events, stepId, { type: 'totalAttempts' }) + 1;
    expect(totalAttempt).toBe(3);
    expect(totalAttempt).toBeLessThanOrEqual(maxRetries + 1);
  });

  it('still bounds real timeout retries: each recovery re-run by the owner counts toward the ceiling', () => {
    // A genuinely timing-out step: the owning message is redelivered again
    // and again, each recovery re-stamping its messageId (the #3035
    // scenario the guard exists for). The owner scope must NOT weaken this.
    const events: Event[] = [
      start('msg_OWNER'),
      start('msg_OWNER'),
      start('msg_OWNER'),
      start('msg_OWNER'),
    ];
    const maxRetries = 3;
    const attempt =
      countStepStartedEvents(events, stepId, {
        type: 'ownedBy',
        messageId: 'msg_OWNER',
      }) + 1;
    expect(attempt).toBeGreaterThan(maxRetries + 1);
  });

  it('mixed owned→bare timeout sequence trips the combined background ceiling', () => {
    // A step that timed out under inline owned recovery, whose ownership
    // then lapsed (lease expired / bare start cleared it) and which kept
    // timing out under queued/bare retries. Neither phase alone exceeds the
    // ceiling, but the lifecycle total must: with maxRetries=3 the guard
    // fires when attempt > 4.
    const events: Event[] = [
      start('msg_OWNER'), // owned attempt 1
      start('msg_OWNER'), // owned attempt 2 (crash recovery)
      start('msg_OWNER'), // owned attempt 3 (crash recovery)
      start(undefined), // attempt 4 (lease expired → queued)
      start(undefined), // attempt 5 (queued retry)
    ];
    const maxRetries = 3;
    const attempt =
      countStepStartedEvents(events, stepId, { type: 'totalAttempts' }) + 1;
    expect(attempt).toBe(6);
    expect(attempt).toBeGreaterThan(maxRetries + 1);
  });
});
