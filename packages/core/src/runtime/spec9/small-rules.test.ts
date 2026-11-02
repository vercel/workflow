import type { Event } from '@workflow/world';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetConsumedPositionsForTests,
  isNoopDelivery,
  recordConsumedPosition,
} from './consumed-position.js';
import {
  DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS,
  getInlineStepDeadlineMarginMs,
  mayStartInlineStep,
} from './deadline.js';
import { analyzeLogSteps, awaitsExternalWork } from './log-state.js';
import {
  MAX_STEP_MESSAGE_RETENTION_SECONDS,
  retryOutlivesMessage,
  STEP_RETRY_EXPIRY_SLACK_SECONDS,
  stepMessageRetentionSeconds,
} from './step-retention.js';

const world = {} as never;
afterEach(() => __resetConsumedPositionsForTests(world));

describe('step message retention', () => {
  it('gives a retrying step the queue maximum', () => {
    expect(stepMessageRetentionSeconds(3)).toBe(
      MAX_STEP_MESSAGE_RETENTION_SECONDS
    );
    expect(stepMessageRetentionSeconds(0)).toBeLessThan(
      MAX_STEP_MESSAGE_RETENTION_SECONDS
    );
  });

  it('fails a retry that would land after the message expires', () => {
    const createdAt = new Date(0);
    const retention = MAX_STEP_MESSAGE_RETENTION_SECONDS;
    const lastSafeMs = (retention - STEP_RETRY_EXPIRY_SLACK_SECONDS) * 1000;
    expect(
      retryOutlivesMessage({
        messageCreatedAt: createdAt,
        retentionSeconds: retention,
        retryAtMs: lastSafeMs,
      })
    ).toBe(false);
    expect(
      retryOutlivesMessage({
        messageCreatedAt: createdAt,
        retentionSeconds: retention,
        retryAtMs: lastSafeMs + 1,
      })
    ).toBe(true);
    expect(
      retryOutlivesMessage({
        messageCreatedAt: undefined,
        retentionSeconds: retention,
        retryAtMs: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(false);
  });
});

describe('inline step deadline', () => {
  it('stops starting inline steps inside the margin', () => {
    const marginMs = getInlineStepDeadlineMarginMs({});
    expect(marginMs).toBe(DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS);
    const deadlineMs = 10 * marginMs;
    expect(
      mayStartInlineStep({
        nowMs: deadlineMs - marginMs - 1,
        deadlineMs,
        marginMs,
      })
    ).toBe(true);
    expect(
      mayStartInlineStep({ nowMs: deadlineMs - marginMs, deadlineMs, marginMs })
    ).toBe(false);
    expect(
      mayStartInlineStep({ nowMs: 0, deadlineMs: undefined, marginMs })
    ).toBe(true);
    expect(
      getInlineStepDeadlineMarginMs({
        WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS: '5',
      })
    ).toBe(5);
  });
});

describe('cheap no-op deliveries', () => {
  it('skips a delivery whose tail is the consumed position and has no due timer', () => {
    recordConsumedPosition(world, 'wrun_a', { slot: 7, nextTimerAtMs: 2_000 });
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 7, nowMs: 1_000 })
    ).toBe(true);
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 8, nowMs: 1_000 })
    ).toBe(false);
    expect(
      isNoopDelivery({ world, runId: 'wrun_a', tailSlot: 7, nowMs: 2_000 })
    ).toBe(false);
    expect(
      isNoopDelivery({ world, runId: 'wrun_b', tailSlot: 7, nowMs: 0 })
    ).toBe(false);
  });
});

describe('inline steps in the log', () => {
  let slot = 0;
  const event = (
    eventType: string,
    eventData: Record<string, unknown> = {}
  ): Event =>
    ({
      eventType,
      correlationId: 'step_a',
      eventId: `evnt_${String(++slot).padStart(26, '0')}`,
      runId: 'wrun_a',
      createdAt: new Date(slot * 1000),
      eventData: { stepName: 'a', ...eventData },
    }) as unknown as Event;
  const inlineStart = () =>
    event('step_started', { attempt: 1, inline: true, workflowName: 'w' });

  it('runs an open inline step again in the orchestrator', () => {
    const [step] = analyzeLogSteps([inlineStart()]);
    expect(step).toMatchObject({ starts: 1, runnableInline: true });
  });

  it('leaves an inline step to its own message once it retried, after its next start too', () => {
    const retried = [inlineStart(), event('step_retrying', { attempt: 1 })];
    expect(analyzeLogSteps(retried)[0]?.runnableInline).toBe(false);
    const restarted = [...retried, event('step_started', { attempt: 2 })];
    expect(analyzeLogSteps(restarted)[0]).toMatchObject({
      starts: 2,
      lastIsRetrying: false,
      runnableInline: false,
    });
    // The same rule as the run's external work.
    expect(awaitsExternalWork(restarted)).toBe(true);
  });
});
