import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  computeStepLatencyEventData,
  computeStepLatencyTracking,
} from './step-latency.js';

const RUN_ID = 'wrun_test';

function makeEvent(
  eventType: Event['eventType'],
  overrides: {
    createdAt?: Date;
    occurredAt?: Date;
    correlationId?: string;
  } = {}
): Event {
  return {
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    runId: RUN_ID,
    eventType,
    correlationId:
      overrides.correlationId ?? `corr-${Math.random().toString(36).slice(2)}`,
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    ...(overrides.occurredAt ? { occurredAt: overrides.occurredAt } : {}),
  } as Event;
}

const BASE = {
  invocationStartedClean: true,
  runCreatedAtMs: 1_000,
  preStepBlockingMs: 0,
  preStepBlockingBeforeAttrMs: undefined,
  suspensionHasWaits: false,
  suspensionCreatedHooks: false,
  turbo: false,
};

describe('computeStepLatencyTracking', () => {
  it('marks TTFS-eligible on a clean first-step log (run events only)', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_created'), makeEvent('run_started')],
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 0,
      turbo: false,
    });
  });

  it('marks TTFS-eligible on an empty log (turbo skip-preload)', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [],
      turbo: true,
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 0,
      turbo: true,
    });
  });

  it.each([
    'hook_received',
    'wait_created',
    'wait_completed',
    'step_created',
    'step_started',
    'step_retrying',
  ] as const)('disqualifies TTFS when a %s event precedes the step', (type) => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_started'), makeEvent(type)],
    });
    expect(tracking?.ttfsAnchorMs).toBeUndefined();
  });

  it('keeps TTFS eligible when only a hook_created precedes the step (its write time is subtracted instead)', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_started'), makeEvent('hook_created')],
      preStepBlockingMs: 42,
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 42,
      turbo: false,
    });
  });

  it('keeps TTFS eligible across a pre-step attr_set, ending the measurement at the first attr write', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [
        makeEvent('run_started'),
        makeEvent('attr_set', {
          createdAt: new Date(3_100),
          occurredAt: new Date(3_000),
        }),
        makeEvent('attr_set', {
          createdAt: new Date(4_000),
          occurredAt: new Date(3_900),
        }),
      ],
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 0,
      // Earliest attr write wins; occurredAt preferred over createdAt.
      preStepAttrStartMs: 3_000,
      turbo: false,
    });
  });

  it('subtracts only pre-attr hook time when a hook and an attr both precede the step', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [
        makeEvent('run_started'),
        makeEvent('hook_created'),
        makeEvent('attr_set', { occurredAt: new Date(3_000) }),
      ],
      // Live accumulator includes a hook written AFTER the attr suspension —
      // outside the attr-anchored measurement window.
      preStepBlockingMs: 90,
      preStepBlockingBeforeAttrMs: 40,
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 40,
      preStepAttrStartMs: 3_000,
      turbo: false,
    });
  });

  it('subtracts no hook time when the attr_set came from a redelivery snapshot (no pre-attr snapshot)', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [
        makeEvent('run_started'),
        makeEvent('attr_set', { occurredAt: new Date(3_000) }),
      ],
      preStepBlockingMs: 90,
      preStepBlockingBeforeAttrMs: undefined,
    });
    expect(tracking).toEqual({
      ttfsAnchorMs: 1_000,
      preStepBlockingMs: 0,
      preStepAttrStartMs: 3_000,
      turbo: false,
    });
  });

  it('disqualifies TTFS when the invocation did not start clean (events written by an earlier invocation)', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_started')],
      invocationStartedClean: false,
    });
    expect(tracking).toBeUndefined();
  });

  it('disqualifies TTFS when run creation time is unrecoverable', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_started')],
      runCreatedAtMs: undefined,
    });
    expect(tracking).toBeUndefined();
  });

  it('disqualifies TTFS when this suspension also created a wait', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('run_started')],
      suspensionHasWaits: true,
    });
    expect(tracking).toBeUndefined();
  });

  it('marks STSO-eligible when the last event is a step terminal, preferring occurredAt', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [
        makeEvent('run_started'),
        makeEvent('step_started'),
        makeEvent('step_completed', {
          createdAt: new Date(5_000),
          occurredAt: new Date(4_500),
        }),
      ],
    });
    // step events disqualify TTFS but qualify STSO.
    expect(tracking).toEqual({
      prevStepEndMs: 4_500,
      stepCount: 1,
      eventCount: 3,
      turbo: false,
    });
  });

  it('falls back to createdAt for STSO when occurredAt is absent', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('step_failed', { createdAt: new Date(5_000) })],
    });
    expect(tracking).toEqual({
      prevStepEndMs: 5_000,
      stepCount: 1,
      eventCount: 1,
      turbo: false,
    });
  });

  it('counts unique terminal steps before the STSO gap', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [
        makeEvent('step_completed', { correlationId: 'step_1' }),
        makeEvent('step_failed', { correlationId: 'step_2' }),
        makeEvent('step_completed', { correlationId: 'step_2' }),
      ],
      invocationStartedClean: false,
    });
    expect(tracking).toEqual({
      prevStepEndMs: new Date('2024-01-01T00:00:00.000Z').getTime(),
      stepCount: 2,
      eventCount: 3,
      turbo: false,
    });
  });

  it('does not mark STSO when the last event is not a step terminal', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('step_completed'), makeEvent('hook_received')],
      invocationStartedClean: false,
    });
    expect(tracking).toBeUndefined();
  });

  it.each([
    ['waits', { suspensionHasWaits: true, suspensionCreatedHooks: false }],
    ['hooks', { suspensionHasWaits: false, suspensionCreatedHooks: true }],
  ])('does not mark STSO when this suspension also created %s', (_label, overrides) => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('step_completed')],
      invocationStartedClean: false,
      ...overrides,
    });
    expect(tracking).toBeUndefined();
  });
});

describe('computeStepLatencyEventData', () => {
  it('computes ttfs minus pre-step blocking time and reports optimizations', () => {
    const data = computeStepLatencyEventData({
      tracking: { ttfsAnchorMs: 1_000, preStepBlockingMs: 200, turbo: true },
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: true,
      optimisticStart: true,
    });
    expect(data).toEqual({
      ttfs: 800,
      optimizations: ['turbo', 'lazyStepStart', 'optimisticStart'],
    });
  });

  it('ends ttfs at the pre-step attr write instead of the step code start, still subtracting pre-attr hook time', () => {
    const data = computeStepLatencyEventData({
      tracking: {
        ttfsAnchorMs: 1_000,
        // Hook time from before the attr write (computeStepLatencyTracking
        // guarantees this excludes post-attr hook writes) — inside the
        // measured window, so it must still be subtracted.
        preStepBlockingMs: 40,
        preStepAttrStartMs: 3_000,
        turbo: false,
      },
      // Includes the setAttributes detour — must be excluded.
      stepCodeStartedAtMs: 60_000,
      attempt: 1,
      lazyStepStart: true,
      optimisticStart: false,
    });
    expect(data).toEqual({
      ttfs: 1_960,
      optimizations: ['lazyStepStart'],
    });
  });

  it('computes stso against the previous step terminal timestamp', () => {
    const data = computeStepLatencyEventData({
      tracking: {
        prevStepEndMs: 1_500,
        stepCount: 7,
        eventCount: 42,
        turbo: false,
      },
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: true,
      optimisticStart: false,
    });
    expect(data).toEqual({
      stso: 500,
      stepCount: 7,
      eventCount: 42,
      optimizations: ['lazyStepStart'],
    });
  });

  it('clamps negative durations (cross-machine clock skew) to zero', () => {
    const data = computeStepLatencyEventData({
      tracking: {
        ttfsAnchorMs: 5_000,
        preStepBlockingMs: 0,
        prevStepEndMs: 5_000,
        stepCount: 3,
        eventCount: 9,
        turbo: false,
      },
      stepCodeStartedAtMs: 4_000,
      attempt: 1,
      lazyStepStart: false,
      optimisticStart: false,
    });
    expect(data).toEqual({
      ttfs: 0,
      stso: 0,
      stepCount: 3,
      eventCount: 9,
      optimizations: [],
    });
  });

  it('drops a sample whose anchor is implausibly far in the future (corrupt anchor, not skew)', () => {
    // e.g. a run-ID timestamp decoded with a metadata tag bit still set
    // would put the anchor millennia ahead — reporting that as ttfs: 0 on
    // every run would silently zero the whole distribution.
    const data = computeStepLatencyEventData({
      tracking: {
        ttfsAnchorMs: 2_000 + 2 ** 47,
        preStepBlockingMs: 0,
        turbo: true,
      },
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: false,
      optimisticStart: false,
    });
    expect(data).toBeUndefined();
  });

  it('drops only the corrupt measurement when the other remains plausible', () => {
    const data = computeStepLatencyEventData({
      tracking: {
        // TTFS anchor beyond the skew tolerance → dropped.
        ttfsAnchorMs: 100_000,
        preStepBlockingMs: 0,
        // STSO anchor within tolerance → kept.
        prevStepEndMs: 1_500,
        stepCount: 2,
        eventCount: 5,
        turbo: false,
      },
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: false,
      optimisticStart: false,
    });
    expect(data).toEqual({
      stso: 500,
      stepCount: 2,
      eventCount: 5,
      optimizations: [],
    });
  });

  it('reports nothing on a retry attempt', () => {
    const data = computeStepLatencyEventData({
      tracking: { ttfsAnchorMs: 1_000, preStepBlockingMs: 0, turbo: false },
      stepCodeStartedAtMs: 2_000,
      attempt: 2,
      lazyStepStart: false,
      optimisticStart: false,
    });
    expect(data).toBeUndefined();
  });

  it('reports nothing without tracking', () => {
    const data = computeStepLatencyEventData({
      tracking: undefined,
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: true,
      optimisticStart: true,
    });
    expect(data).toBeUndefined();
  });
});
