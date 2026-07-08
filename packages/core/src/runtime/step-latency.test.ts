import type { Event } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  computeStepLatencyEventData,
  computeStepLatencyTracking,
} from './step-latency.js';

const RUN_ID = 'wrun_test';

function makeEvent(
  eventType: Event['eventType'],
  overrides: { createdAt?: Date; occurredAt?: Date } = {}
): Event {
  return {
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    runId: RUN_ID,
    eventType,
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    ...(overrides.occurredAt ? { occurredAt: overrides.occurredAt } : {}),
  } as Event;
}

const BASE = {
  invocationStartedClean: true,
  runCreatedAtMs: 1_000,
  preStepBlockingMs: 0,
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
    'attr_set',
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
    expect(tracking).toEqual({ prevStepEndMs: 4_500, turbo: false });
  });

  it('falls back to createdAt for STSO when occurredAt is absent', () => {
    const tracking = computeStepLatencyTracking({
      ...BASE,
      events: [makeEvent('step_failed', { createdAt: new Date(5_000) })],
    });
    expect(tracking).toEqual({ prevStepEndMs: 5_000, turbo: false });
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

  it('computes stso against the previous step terminal timestamp', () => {
    const data = computeStepLatencyEventData({
      tracking: { prevStepEndMs: 1_500, turbo: false },
      stepCodeStartedAtMs: 2_000,
      attempt: 1,
      lazyStepStart: true,
      optimisticStart: false,
    });
    expect(data).toEqual({ stso: 500, optimizations: ['lazyStepStart'] });
  });

  it('clamps negative durations (cross-machine clock skew) to zero', () => {
    const data = computeStepLatencyEventData({
      tracking: {
        ttfsAnchorMs: 5_000,
        preStepBlockingMs: 0,
        prevStepEndMs: 5_000,
        turbo: false,
      },
      stepCodeStartedAtMs: 4_000,
      attempt: 1,
      lazyStepStart: false,
      optimisticStart: false,
    });
    expect(data).toEqual({ ttfs: 0, stso: 0, optimizations: [] });
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
