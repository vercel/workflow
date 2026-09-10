import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  _resetReplayTimeoutWarnCacheForTests,
  getExhaustedDeliveryBudget,
  getInlineOwnershipLeaseSeconds,
  getMaxInlineSteps,
  getMaxQueueDeliveries,
  getReplayTimeoutMs,
  INLINE_OWNERSHIP_LEASE_SECONDS,
  isInlineOwnershipEnabled,
  isOptimisticInlineStartEnabled,
  isOptimisticInlineStartExplicitlyDisabled,
  isTurboEnabled,
  MAX_BATCH_FANOUT_EVENTS,
  MAX_INLINE_OWNERSHIP_LEASE_SECONDS,
  MAX_INLINE_STEPS,
  MAX_MAX_INLINE_STEPS,
  MAX_QUEUE_DELIVERIES,
  MAX_QUEUE_DELIVERIES_WITH_EXPIRY,
  MAX_REPLAY_TIMEOUT_MS,
  MIN_MAX_INLINE_STEPS,
  MIN_REPLAY_TIMEOUT_MS,
  QUEUE_DELIVERY_EXPIRY_MARGIN_MS,
  REPLAY_TIMEOUT_MS,
} from './constants.js';

describe('getReplayTimeoutMs', () => {
  const originalEnv = process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
    _resetReplayTimeoutWarnCacheForTests();
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_REPLAY_TIMEOUT_MS;
    } else {
      process.env.WORKFLOW_REPLAY_TIMEOUT_MS = originalEnv;
    }
    warnSpy.mockRestore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the default when the env var is empty', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the default and warns when the env var is non-numeric', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'not-a-number';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('not a positive finite number');
  });

  it('returns the default and warns when the env var is zero', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '0';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the default and warns when the env var is negative', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '-100';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps to MIN_REPLAY_TIMEOUT_MS and warns when below floor', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '5000';
    expect(getReplayTimeoutMs()).toBe(MIN_REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('below minimum');
  });

  it('clamps to MAX_REPLAY_TIMEOUT_MS and warns when above ceiling', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '9999999';
    expect(getReplayTimeoutMs()).toBe(MAX_REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('above maximum');
  });

  it('honors an in-range override without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '600000';
    expect(getReplayTimeoutMs()).toBe(600_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts the lower-bound value exactly without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = String(MIN_REPLAY_TIMEOUT_MS);
    expect(getReplayTimeoutMs()).toBe(MIN_REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts the upper-bound value exactly without warning', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = String(MAX_REPLAY_TIMEOUT_MS);
    expect(getReplayTimeoutMs()).toBe(MAX_REPLAY_TIMEOUT_MS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects Infinity and falls back to the default', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'Infinity';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects NaN and falls back to the default', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = 'NaN';
    expect(getReplayTimeoutMs()).toBe(REPLAY_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('only warns once per distinct raw env var value', () => {
    process.env.WORKFLOW_REPLAY_TIMEOUT_MS = '5000';
    getReplayTimeoutMs();
    getReplayTimeoutMs();
    getReplayTimeoutMs();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getMaxInlineSteps', () => {
  const originalEnv = process.env.WORKFLOW_MAX_INLINE_STEPS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_MAX_INLINE_STEPS;
    } else {
      process.env.WORKFLOW_MAX_INLINE_STEPS = originalEnv;
    }
    warnSpy.mockRestore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns a valid in-range override', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '5';
    expect(getMaxInlineSteps()).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clamps to the minimum (1 = single inline step)', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '1';
    expect(getMaxInlineSteps()).toBe(MIN_MAX_INLINE_STEPS);
  });

  it('clamps values above the maximum and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = String(MAX_MAX_INLINE_STEPS + 100);
    expect(getMaxInlineSteps()).toBe(MAX_MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-integer and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '2.5';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-numeric value and warns', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = 'lots';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default on a non-positive value', () => {
    process.env.WORKFLOW_MAX_INLINE_STEPS = '0';
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
  });
});

describe('isOptimisticInlineStartEnabled', () => {
  const originalEnv = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START = originalEnv;
    }
  });

  it('defaults to disabled when unset', () => {
    delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    expect(isOptimisticInlineStartEnabled()).toBe(false);
  });

  it('is enabled by an explicit "1"', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '1';
    expect(isOptimisticInlineStartEnabled()).toBe(true);
  });

  it('is enabled by "true" (case-insensitive)', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = 'TRUE';
    expect(isOptimisticInlineStartEnabled()).toBe(true);
  });

  it('stays disabled for any other value', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = 'yes';
    expect(isOptimisticInlineStartEnabled()).toBe(false);
  });
});

describe('isOptimisticInlineStartExplicitlyDisabled', () => {
  const originalEnv = process.env.WORKFLOW_OPTIMISTIC_INLINE_START;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    } else {
      process.env.WORKFLOW_OPTIMISTIC_INLINE_START = originalEnv;
    }
  });

  it('is false when unset (off-by-default, but not an explicit opt-out)', () => {
    delete process.env.WORKFLOW_OPTIMISTIC_INLINE_START;
    expect(isOptimisticInlineStartExplicitlyDisabled()).toBe(false);
  });

  it('is false when empty', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '';
    expect(isOptimisticInlineStartExplicitlyDisabled()).toBe(false);
  });

  it('is true for an explicit "0"', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '0';
    expect(isOptimisticInlineStartExplicitlyDisabled()).toBe(true);
  });

  it('is true for "false" (case-insensitive)', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = 'False';
    expect(isOptimisticInlineStartExplicitlyDisabled()).toBe(true);
  });

  it('is false when enabled', () => {
    process.env.WORKFLOW_OPTIMISTIC_INLINE_START = '1';
    expect(isOptimisticInlineStartExplicitlyDisabled()).toBe(false);
  });
});

describe('isTurboEnabled', () => {
  const originalEnv = process.env.WORKFLOW_TURBO;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_TURBO;
    } else {
      process.env.WORKFLOW_TURBO = originalEnv;
    }
  });

  it('defaults to enabled when unset', () => {
    delete process.env.WORKFLOW_TURBO;
    expect(isTurboEnabled()).toBe(true);
  });

  it('defaults to enabled when empty', () => {
    process.env.WORKFLOW_TURBO = '';
    expect(isTurboEnabled()).toBe(true);
  });

  it('is disabled by an explicit "0"', () => {
    process.env.WORKFLOW_TURBO = '0';
    expect(isTurboEnabled()).toBe(false);
  });

  it('is disabled by "false" (case-insensitive)', () => {
    process.env.WORKFLOW_TURBO = 'FALSE';
    expect(isTurboEnabled()).toBe(false);
  });

  it('stays enabled for "1" and other truthy values', () => {
    process.env.WORKFLOW_TURBO = '1';
    expect(isTurboEnabled()).toBe(true);
    process.env.WORKFLOW_TURBO = 'yes';
    expect(isTurboEnabled()).toBe(true);
  });
});

describe('getMaxQueueDeliveries', () => {
  const ENV = 'WORKFLOW_MAX_QUEUE_DELIVERIES';

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it('returns the default when unset', () => {
    expect(getMaxQueueDeliveries()).toBe(MAX_QUEUE_DELIVERIES);
  });

  it('allows a stricter (lower) override', () => {
    process.env[ENV] = String(MAX_QUEUE_DELIVERIES - 1);
    expect(getMaxQueueDeliveries()).toBe(MAX_QUEUE_DELIVERIES - 1);
  });

  it('clamps an above-default override back to the retention-safe default', () => {
    // The delivery budget must stay within VQS message retention so the
    // handler-side failure path runs before the message expires; an override
    // may only lower it, never raise it.
    process.env[ENV] = String(MAX_QUEUE_DELIVERIES + 100);
    expect(getMaxQueueDeliveries()).toBe(MAX_QUEUE_DELIVERIES);
  });

  it('uses the larger safety-net cap when the queue reports message expiry', () => {
    expect(getMaxQueueDeliveries(true)).toBe(MAX_QUEUE_DELIVERIES_WITH_EXPIRY);
    expect(MAX_QUEUE_DELIVERIES_WITH_EXPIRY).toBeGreaterThan(
      MAX_QUEUE_DELIVERIES
    );
  });

  it('clamps an override against the cap that applies to the queue', () => {
    process.env[ENV] = String(MAX_QUEUE_DELIVERIES + 100);
    expect(getMaxQueueDeliveries(true)).toBe(MAX_QUEUE_DELIVERIES + 100);
    process.env[ENV] = String(MAX_QUEUE_DELIVERIES_WITH_EXPIRY + 100);
    expect(getMaxQueueDeliveries(true)).toBe(MAX_QUEUE_DELIVERIES_WITH_EXPIRY);
  });
});

describe('getExhaustedDeliveryBudget', () => {
  const ENV = 'WORKFLOW_MAX_QUEUE_DELIVERIES';
  const now = Date.UTC(2026, 0, 1);
  const DAY_MS = 24 * 60 * 60 * 1000;

  afterEach(() => {
    delete process.env[ENV];
  });

  describe('without message expiry', () => {
    it('allows deliveries up to the fixed cap', () => {
      expect(
        getExhaustedDeliveryBudget({ attempt: MAX_QUEUE_DELIVERIES }, now)
      ).toBeUndefined();
    });

    it('is exhausted once the fixed cap is exceeded', () => {
      const exhausted = getExhaustedDeliveryBudget(
        { attempt: MAX_QUEUE_DELIVERIES + 1 },
        now
      );
      expect(exhausted?.maxQueueDeliveries).toBe(MAX_QUEUE_DELIVERIES);
      expect(exhausted?.reason).toContain(
        `${MAX_QUEUE_DELIVERIES + 1}/${MAX_QUEUE_DELIVERIES}`
      );
    });
  });

  describe('with message expiry', () => {
    it('keeps retrying past the fixed cap while the message has time left', () => {
      // The whole point of the time-based budget: a backend outage that lasts
      // longer than 48 deliveries' worth of backoff does not fail the run as
      // long as the queue still holds the message.
      expect(
        getExhaustedDeliveryBudget(
          {
            attempt: MAX_QUEUE_DELIVERIES + 1,
            expiresAt: new Date(now + DAY_MS / 2),
          },
          now
        )
      ).toBeUndefined();
    });

    it('is exhausted once the message is within the expiry margin', () => {
      const exhausted = getExhaustedDeliveryBudget(
        {
          attempt: 30,
          expiresAt: new Date(now + QUEUE_DELIVERY_EXPIRY_MARGIN_MS - 1),
        },
        now
      );
      expect(exhausted?.reason).toContain('message expires in');
      expect(exhausted?.reason).toContain('30 deliveries');
    });

    it('is not exhausted exactly at the margin', () => {
      expect(
        getExhaustedDeliveryBudget(
          {
            attempt: 30,
            expiresAt: new Date(now + QUEUE_DELIVERY_EXPIRY_MARGIN_MS),
          },
          now
        )
      ).toBeUndefined();
    });

    it('reports a non-negative remaining time for an already-expired message', () => {
      const exhausted = getExhaustedDeliveryBudget(
        { attempt: 5, expiresAt: new Date(now - 1000) },
        now
      );
      expect(exhausted?.reason).toContain('expires in 0s');
    });

    it('still enforces the safety-net attempt cap', () => {
      const exhausted = getExhaustedDeliveryBudget(
        {
          attempt: MAX_QUEUE_DELIVERIES_WITH_EXPIRY + 1,
          expiresAt: new Date(now + DAY_MS),
        },
        now
      );
      expect(exhausted?.maxQueueDeliveries).toBe(
        MAX_QUEUE_DELIVERIES_WITH_EXPIRY
      );
    });

    it('honors a lowered override ahead of the time budget', () => {
      process.env[ENV] = '5';
      expect(
        getExhaustedDeliveryBudget(
          { attempt: 6, expiresAt: new Date(now + DAY_MS) },
          now
        )?.maxQueueDeliveries
      ).toBe(5);
    });
  });
});

describe('isInlineOwnershipEnabled', () => {
  const originalEnv = process.env.WORKFLOW_INLINE_OWNERSHIP;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_INLINE_OWNERSHIP;
    } else {
      process.env.WORKFLOW_INLINE_OWNERSHIP = originalEnv;
    }
  });

  it('defaults to enabled when unset', () => {
    delete process.env.WORKFLOW_INLINE_OWNERSHIP;
    expect(isInlineOwnershipEnabled()).toBe(true);
  });

  it('defaults to enabled when empty', () => {
    process.env.WORKFLOW_INLINE_OWNERSHIP = '';
    expect(isInlineOwnershipEnabled()).toBe(true);
  });

  it('is disabled by an explicit "0" (kill switch)', () => {
    process.env.WORKFLOW_INLINE_OWNERSHIP = '0';
    expect(isInlineOwnershipEnabled()).toBe(false);
  });

  it('is disabled by "false" (case-insensitive)', () => {
    process.env.WORKFLOW_INLINE_OWNERSHIP = 'FALSE';
    expect(isInlineOwnershipEnabled()).toBe(false);
  });

  it('stays enabled for "1" and other truthy values', () => {
    process.env.WORKFLOW_INLINE_OWNERSHIP = '1';
    expect(isInlineOwnershipEnabled()).toBe(true);
    process.env.WORKFLOW_INLINE_OWNERSHIP = 'yes';
    expect(isInlineOwnershipEnabled()).toBe(true);
  });
});

describe('getInlineOwnershipLeaseSeconds', () => {
  const ENV = 'WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS';

  beforeEach(() => {
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  it('returns the default when unset', () => {
    expect(getInlineOwnershipLeaseSeconds()).toBe(
      INLINE_OWNERSHIP_LEASE_SECONDS
    );
  });

  it('allows a custom override', () => {
    process.env[ENV] = '120';
    expect(getInlineOwnershipLeaseSeconds()).toBe(120);
  });

  it('clamps above the queue max-delay ceiling', () => {
    // Backstops must fit in a single delayed queue message (900s SQS cap),
    // so the lease is clamped rather than requiring delay chaining.
    process.env[ENV] = '3600';
    expect(getInlineOwnershipLeaseSeconds()).toBe(
      MAX_INLINE_OWNERSHIP_LEASE_SECONDS
    );
  });

  it('clamps a non-positive override up to 1', () => {
    process.env[ENV] = '0';
    expect(getInlineOwnershipLeaseSeconds()).toBe(1);
  });
});

describe('pre-claimed inline pairs fit one batch chunk', () => {
  it('keeps two rows per inline step inside MAX_BATCH_FANOUT_EVENTS', () => {
    // The suspension fold folds each lazy-inline step into an adjacent
    // [step_created, step_started] pair, and the inline slice sorts to the
    // front of the batch — so every pair lands in the FIRST chunk exactly
    // while two rows per inline step fit inside one chunk.
    //
    // Past that, pairs spill into a trailing chunk. `handleSuspension` gates
    // its return on every pair-carrying chunk so that degrades safely, but a
    // spilled pair costs the caller its claim/body overlap for no reason.
    // Raising MAX_MAX_INLINE_STEPS therefore has to raise the chunk cap with
    // it (and re-check the server's per-batch transaction budget).
    expect(2 * MAX_MAX_INLINE_STEPS).toBeLessThanOrEqual(
      MAX_BATCH_FANOUT_EVENTS
    );
  });
});
