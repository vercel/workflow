import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import {
  _resetReplayTimeoutWarnCacheForTests,
  EAGER_BRANCH_REPLAY_DELAY_MS,
  EAGER_BRANCH_REPLAY_MAX_PENDING,
  getEagerBranchReplayDelayMs,
  getEagerBranchReplayMaxPending,
  getInlineOwnershipLeaseSeconds,
  getMaxInlineSteps,
  getMaxQueueDeliveries,
  getReplayTimeoutMs,
  INLINE_OWNERSHIP_LEASE_SECONDS,
  isEagerBranchReplayEnabled,
  isInlineOwnershipEnabled,
  isOptimisticInlineStartEnabled,
  isOptimisticInlineStartExplicitlyDisabled,
  isTurboEnabled,
  MAX_BATCH_FANOUT_EVENTS,
  MAX_INLINE_OWNERSHIP_LEASE_SECONDS,
  MAX_INLINE_STEPS,
  MAX_MAX_INLINE_STEPS,
  MAX_QUEUE_DELIVERIES,
  MAX_REPLAY_TIMEOUT_MS,
  MIN_MAX_INLINE_STEPS,
  MIN_REPLAY_TIMEOUT_MS,
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

describe('isEagerBranchReplayEnabled', () => {
  const originalEnv = process.env.WORKFLOW_EAGER_BRANCH_REPLAY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKFLOW_EAGER_BRANCH_REPLAY;
    } else {
      process.env.WORKFLOW_EAGER_BRANCH_REPLAY = originalEnv;
    }
  });

  it('defaults to enabled when unset or empty', () => {
    delete process.env.WORKFLOW_EAGER_BRANCH_REPLAY;
    expect(isEagerBranchReplayEnabled()).toBe(true);
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = '';
    expect(isEagerBranchReplayEnabled()).toBe(true);
  });

  it('is disabled by "0" or "false" (kill switch)', () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = '0';
    expect(isEagerBranchReplayEnabled()).toBe(false);
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = 'False';
    expect(isEagerBranchReplayEnabled()).toBe(false);
  });

  it('stays enabled for other values', () => {
    process.env.WORKFLOW_EAGER_BRANCH_REPLAY = '1';
    expect(isEagerBranchReplayEnabled()).toBe(true);
  });
});

describe('getEagerBranchReplayMaxPending', () => {
  const ENV = 'WORKFLOW_EAGER_BRANCH_REPLAY_MAX_PENDING';
  const originalEnv = process.env[ENV];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = originalEnv;
    warnSpy.mockRestore();
  });

  it('defaults when unset or empty', () => {
    delete process.env[ENV];
    expect(getEagerBranchReplayMaxPending()).toBe(
      EAGER_BRANCH_REPLAY_MAX_PENDING
    );
    process.env[ENV] = '';
    expect(getEagerBranchReplayMaxPending()).toBe(
      EAGER_BRANCH_REPLAY_MAX_PENDING
    );
  });

  it('takes a non-negative integer, zero included', () => {
    process.env[ENV] = '64';
    expect(getEagerBranchReplayMaxPending()).toBe(64);
    process.env[ENV] = '0';
    expect(getEagerBranchReplayMaxPending()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default and warns once on anything else', () => {
    process.env[ENV] = '-7';
    expect(getEagerBranchReplayMaxPending()).toBe(
      EAGER_BRANCH_REPLAY_MAX_PENDING
    );
    expect(getEagerBranchReplayMaxPending()).toBe(
      EAGER_BRANCH_REPLAY_MAX_PENDING
    );
    process.env[ENV] = 'many-branches';
    expect(getEagerBranchReplayMaxPending()).toBe(
      EAGER_BRANCH_REPLAY_MAX_PENDING
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('getEagerBranchReplayDelayMs', () => {
  const ENV = 'WORKFLOW_EAGER_BRANCH_REPLAY_DELAY_MS';
  const originalEnv = process.env[ENV];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(runtimeLogger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = originalEnv;
    warnSpy.mockRestore();
  });

  it('defaults when unset or empty', () => {
    delete process.env[ENV];
    expect(getEagerBranchReplayDelayMs()).toBe(EAGER_BRANCH_REPLAY_DELAY_MS);
    process.env[ENV] = '';
    expect(getEagerBranchReplayDelayMs()).toBe(EAGER_BRANCH_REPLAY_DELAY_MS);
  });

  it('takes a non-negative integer, zero included', () => {
    process.env[ENV] = '1000';
    expect(getEagerBranchReplayDelayMs()).toBe(1000);
    process.env[ENV] = '0';
    expect(getEagerBranchReplayDelayMs()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default and warns once on anything else', () => {
    process.env[ENV] = '2.5';
    expect(getEagerBranchReplayDelayMs()).toBe(EAGER_BRANCH_REPLAY_DELAY_MS);
    expect(getEagerBranchReplayDelayMs()).toBe(EAGER_BRANCH_REPLAY_DELAY_MS);
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
  it('keeps two rows per default inline step inside MAX_BATCH_FANOUT_EVENTS', () => {
    // The suspension fold folds each lazy-inline step into an adjacent
    // [step_created, step_started] pair and commits the pairs in chunk(s)
    // of their own, ahead of the plain creates — so every pair lands in ONE
    // leading chunk exactly while two rows per inline step fit inside one
    // chunk, and the inline bodies gate on a single small commit.
    //
    // Past that, pairs spill into a second pair chunk. `handleSuspension`
    // gates its return on every pair-carrying chunk (committed concurrently)
    // so that degrades latency, not correctness. The default inline cap must
    // fit one chunk; a WORKFLOW_MAX_INLINE_STEPS override up to
    // MAX_MAX_INLINE_STEPS may spill.
    expect(2 * MAX_INLINE_STEPS).toBeLessThanOrEqual(MAX_BATCH_FANOUT_EVENTS);
  });

  it('stays inside the server batch transaction budget', () => {
    // 100 DynamoDB transaction items per batch; a plain create costs 2
    // (entity + event row) and a pair 3, so a full chunk of plain creates is
    // the most expensive one.
    expect(2 * MAX_BATCH_FANOUT_EVENTS).toBeLessThanOrEqual(100);
  });
});
