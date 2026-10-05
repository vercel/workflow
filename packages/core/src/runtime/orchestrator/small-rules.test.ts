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
import {
  FENCE_REDELIVERY_DELAY_SECONDS,
  getFenceRedeliveryDelaySeconds,
} from './in-band-writer.js';
import {
  MAX_STEP_MESSAGE_RETENTION_SECONDS,
  retryOutlivesMessage,
  STEP_RETRY_EXPIRY_SLACK_SECONDS,
  stepMessageRetentionSeconds,
} from './step-retention.js';

afterEach(() => __resetConsumedPositionsForTests());

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

describe('fence redelivery delay', () => {
  it('defaults small and is configurable', () => {
    expect(getFenceRedeliveryDelaySeconds({})).toBe(
      FENCE_REDELIVERY_DELAY_SECONDS
    );
    expect(
      getFenceRedeliveryDelaySeconds({
        WORKFLOW_FENCE_REDELIVERY_DELAY_SECONDS: '1',
      })
    ).toBe(1);
  });
});

describe('cheap no-op deliveries', () => {
  it('skips a delivery whose tail is the consumed position and has no due timer', () => {
    recordConsumedPosition('wrun_a', { slot: 7, nextTimerAtMs: 2_000 });
    expect(isNoopDelivery({ runId: 'wrun_a', tailSlot: 7, nowMs: 1_000 })).toBe(
      true
    );
    expect(isNoopDelivery({ runId: 'wrun_a', tailSlot: 8, nowMs: 1_000 })).toBe(
      false
    );
    expect(isNoopDelivery({ runId: 'wrun_a', tailSlot: 7, nowMs: 2_000 })).toBe(
      false
    );
    expect(isNoopDelivery({ runId: 'wrun_b', tailSlot: 7, nowMs: 0 })).toBe(
      false
    );
  });
});
