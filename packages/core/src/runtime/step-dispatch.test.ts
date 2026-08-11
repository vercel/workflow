import { afterEach, describe, expect, it } from 'vitest';
import type { StepInvocationQueueItem } from '../global.js';
import {
  getInlineOwnershipLeaseSeconds,
  getStepDispatchWatchdogSeconds,
} from './constants.js';
import {
  dispatchLostAtMs,
  getStepDispatchWake,
  isStepAwaitingFirstStart,
  nextStepDispatchBoundaryMs,
  stepDispatchEpoch,
  stepDispatchIdempotencyKey,
} from './step-dispatch.js';

const WATCHDOG_ENV = 'WORKFLOW_STEP_DISPATCH_WATCHDOG_SECONDS';

const CREATED_AT = 1_000_000;
const STARTED_AT = CREATED_AT + 1_000;

/** A step mid-body, its ownership lease still live at `atLeaseOffset(-1)`. */
function startedStep(
  overrides: Partial<StepInvocationQueueItem> = {}
): StepInvocationQueueItem {
  return makeStep({ lastStartedAt: STARTED_AT, ...overrides });
}

/** `nowMs` relative to the end of a started step's ownership lease. */
function atLeaseOffset(offsetMs: number): number {
  return STARTED_AT + getInlineOwnershipLeaseSeconds() * 1000 + offsetMs;
}

function makeStep(
  overrides: Partial<StepInvocationQueueItem> = {}
): StepInvocationQueueItem {
  return {
    type: 'step',
    correlationId: 'step_01ABC',
    stepName: 'someStep',
    args: [],
    hasCreatedEvent: true,
    createdEventAt: CREATED_AT,
    ...overrides,
  };
}

/** `nowMs` exactly `intervals` watchdog intervals after the step's creation. */
function atIntervals(intervals: number): number {
  return CREATED_AT + intervals * getStepDispatchWatchdogSeconds() * 1000;
}

/** One interval, in ms, at whatever the watchdog is currently configured to. */
function intervalMs(): number {
  return getStepDispatchWatchdogSeconds() * 1000;
}

afterEach(() => {
  delete process.env[WATCHDOG_ENV];
});

describe('isStepAwaitingFirstStart', () => {
  it('is true for a created step with no observed start', () => {
    expect(isStepAwaitingFirstStart(makeStep())).toBe(true);
  });

  it('is false when no durable creation timestamp is known', () => {
    expect(
      isStepAwaitingFirstStart(
        makeStep({ hasCreatedEvent: false, createdEventAt: undefined })
      )
    ).toBe(false);
  });

  it('is true for a step whose creation this invocation just wrote', () => {
    // The suspension that writes step_created stamps the timestamp onto the
    // queue item it is about to dispatch, so a dispatch lost on the very
    // first hand-off is still covered.
    expect(isStepAwaitingFirstStart(makeStep({ hasCreatedEvent: false }))).toBe(
      true
    );
  });

  it('is false once the step has started', () => {
    expect(
      isStepAwaitingFirstStart(makeStep({ lastStartedAt: CREATED_AT + 10 }))
    ).toBe(false);
  });

  it('is false after step_retrying, which implies a prior start', () => {
    expect(isStepAwaitingFirstStart(makeStep({ sawRetrying: true }))).toBe(
      false
    );
  });
});

describe('dispatchLostAtMs', () => {
  it('is one watchdog interval after creation for an unstarted step', () => {
    expect(dispatchLostAtMs(makeStep())).toBe(atIntervals(1));
  });

  it('is the end of the ownership lease for a started step', () => {
    expect(dispatchLostAtMs(startedStep())).toBe(atLeaseOffset(0));
  });

  it('is undefined for a step whose retry is already queued', () => {
    expect(
      dispatchLostAtMs(startedStep({ sawRetrying: true }))
    ).toBeUndefined();
  });

  it('is undefined when the world reports no creation timestamp', () => {
    expect(dispatchLostAtMs(makeStep({ createdEventAt: undefined }))).toBe(
      undefined
    );
  });
});

describe('stepDispatchIdempotencyKey', () => {
  it('uses the bare correlation ID within the first watchdog interval', () => {
    const step = makeStep();
    expect(stepDispatchIdempotencyKey(step, CREATED_AT)).toBe(
      step.correlationId
    );
    expect(stepDispatchIdempotencyKey(step, atIntervals(1))).toBe(
      step.correlationId
    );
  });

  it('moves to a fresh key once an interval has passed without a start', () => {
    const step = makeStep();
    expect(stepDispatchIdempotencyKey(step, atIntervals(1) + 1)).toBe(
      `${step.correlationId}:dispatch:1`
    );
    expect(stepDispatchIdempotencyKey(step, atIntervals(2.5))).toBe(
      `${step.correlationId}:dispatch:2`
    );
  });

  it('is stable across replays within one epoch', () => {
    const step = makeStep();
    const early = stepDispatchIdempotencyKey(step, atIntervals(1.01));
    const late = stepDispatchIdempotencyKey(step, atIntervals(1.99));
    expect(early).toBe(late);
  });

  it('keeps the bare key for a started step while its lease is live', () => {
    // A step mid-body may take far longer than the watchdog interval, so the
    // ownership lease is the only deadline that may act on it.
    const step = startedStep();
    expect(stepDispatchIdempotencyKey(step, atLeaseOffset(-1))).toBe(
      step.correlationId
    );
  });

  it('moves to a fresh key once a started step outlives its lease', () => {
    // The invocation that wrote step_started is gone: past the lease the
    // inline backstop wake brings a replay back, and this is the key that
    // makes its re-dispatch reach the queue rather than being deduped away.
    const step = startedStep();
    expect(stepDispatchIdempotencyKey(step, atLeaseOffset(1))).toBe(
      `${step.correlationId}:dispatch:1`
    );
    expect(stepDispatchIdempotencyKey(step, atLeaseOffset(intervalMs()))).toBe(
      `${step.correlationId}:dispatch:2`
    );
  });

  it('keeps the bare key for a step whose retry is already queued', () => {
    // step_retrying means the owner scheduled the next attempt under the bare
    // key, with a backoff that may legitimately exceed any deadline here.
    const step = startedStep({ sawRetrying: true });
    expect(stepDispatchIdempotencyKey(step, atLeaseOffset(intervalMs()))).toBe(
      step.correlationId
    );
  });

  it('keeps the bare key when the world reports no creation timestamp', () => {
    const step = makeStep({ createdEventAt: undefined });
    expect(stepDispatchIdempotencyKey(step, atIntervals(10))).toBe(
      step.correlationId
    );
  });

  it('keeps the bare key when the creation timestamp is in the future', () => {
    const step = makeStep();
    expect(stepDispatchIdempotencyKey(step, CREATED_AT - 60_000)).toBe(
      step.correlationId
    );
  });

  it('honours the watchdog override', () => {
    process.env[WATCHDOG_ENV] = '10';
    const step = makeStep();
    expect(stepDispatchEpoch(step, CREATED_AT + 10_001)).toBe(1);
    expect(stepDispatchEpoch(step, CREATED_AT + 10_000)).toBe(0);
  });

  it('clamps an override below the supported minimum', () => {
    process.env[WATCHDOG_ENV] = '1';
    // Clamped up, so one nominal second past creation is still epoch 0.
    expect(stepDispatchEpoch(makeStep(), CREATED_AT + 1_000)).toBe(0);
    expect(getStepDispatchWatchdogSeconds()).toBeGreaterThan(1);
  });
});

describe('nextStepDispatchBoundaryMs', () => {
  it('is one interval after creation while inside the first interval', () => {
    expect(nextStepDispatchBoundaryMs(makeStep(), CREATED_AT)).toBe(
      atIntervals(1)
    );
  });

  it('advances with the epoch', () => {
    expect(nextStepDispatchBoundaryMs(makeStep(), atIntervals(1.5))).toBe(
      atIntervals(2)
    );
  });

  it('is the lease boundary for a started step still inside its lease', () => {
    expect(nextStepDispatchBoundaryMs(startedStep(), STARTED_AT)).toBe(
      atLeaseOffset(0)
    );
  });

  it('is undefined for a step out of watchdog scope', () => {
    expect(
      nextStepDispatchBoundaryMs(
        startedStep({ sawRetrying: true }),
        atIntervals(3)
      )
    ).toBeUndefined();
  });
});

describe('getStepDispatchWake', () => {
  it('is undefined when no pending step has a lost-dispatch deadline', () => {
    expect(
      getStepDispatchWake([startedStep({ sawRetrying: true })], CREATED_AT)
    ).toBeUndefined();
    expect(getStepDispatchWake([], CREATED_AT)).toBeUndefined();
  });

  it('re-arms itself past the lease so a lost recovery is retried', () => {
    // The dispatch at the lease boundary computes epoch 0 and is deduped, so
    // the wake it arms is what carries the run to the first fresh key.
    const step = startedStep();
    const wake = getStepDispatchWake([step], atLeaseOffset(0));
    expect(wake?.idempotencyKey).toBe(
      `${step.correlationId}:dispatch-wake:${atLeaseOffset(0)}`
    );
    const next = getStepDispatchWake([step], atLeaseOffset(1));
    expect(next?.idempotencyKey).toBe(
      `${step.correlationId}:dispatch-wake:${atLeaseOffset(intervalMs())}`
    );
  });

  it('lands just past the boundary so the wake does not re-arm its own key', () => {
    const wake = getStepDispatchWake([makeStep()], CREATED_AT);
    expect(wake).toBeDefined();
    const boundary = atIntervals(1);
    expect(CREATED_AT + wake!.delaySeconds * 1000).toBeGreaterThan(boundary);
    expect(wake?.idempotencyKey).toBe(`step_01ABC:dispatch-wake:${boundary}`);
  });

  it('picks the earliest boundary among several pending steps', () => {
    const older = makeStep({
      correlationId: 'step_older',
      createdEventAt: CREATED_AT,
    });
    const newer = makeStep({
      correlationId: 'step_newer',
      createdEventAt: CREATED_AT + 5_000,
    });
    const wake = getStepDispatchWake([newer, older], CREATED_AT + 5_000);
    expect(wake?.idempotencyKey).toBe(
      `step_older:dispatch-wake:${atIntervals(1)}`
    );
  });

  it('breaks boundary ties on correlation ID so replays agree', () => {
    const a = makeStep({ correlationId: 'step_a' });
    const b = makeStep({ correlationId: 'step_b' });
    expect(getStepDispatchWake([a, b], CREATED_AT)?.idempotencyKey).toBe(
      getStepDispatchWake([b, a], CREATED_AT)?.idempotencyKey
    );
    expect(getStepDispatchWake([b, a], CREATED_AT)?.idempotencyKey).toContain(
      'step_a'
    );
  });

  it('keeps the delay inside the queue-supported range at the maximum watchdog', () => {
    process.env[WATCHDOG_ENV] = String(Number.MAX_SAFE_INTEGER);
    const clamped = getStepDispatchWatchdogSeconds();
    const wake = getStepDispatchWake([makeStep()], CREATED_AT);
    expect(wake?.delaySeconds).toBe(clamped);
  });

  it('still asks for a positive delay when the boundary is already past', () => {
    // Clock skew or a long-running replay can put "now" past the boundary the
    // epoch was computed from.
    const step = makeStep();
    const wake = getStepDispatchWake([step], atIntervals(1) - 1);
    expect(wake?.delaySeconds).toBeGreaterThanOrEqual(1);
  });
});
