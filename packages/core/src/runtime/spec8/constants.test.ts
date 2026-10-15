import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INLINE_STEPS } from '../constants.js';
import {
  getInlineOwnershipLeaseSeconds,
  getMaxInlineSteps,
  INLINE_OWNERSHIP_LEASE_SECONDS,
  isInlineOwnershipEnabled,
  isOptimisticInlineStartEnabled,
  MAX_BATCH_FANOUT_EVENTS,
  MAX_INLINE_OWNERSHIP_LEASE_SECONDS,
} from './constants.js';

describe('getMaxInlineSteps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads 0 as unset and uses the default', () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
    expect(getMaxInlineSteps()).toBe(MAX_INLINE_STEPS);
  });

  it('passes every other value through the shared setting', () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '5');
    expect(getMaxInlineSteps()).toBe(5);
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
