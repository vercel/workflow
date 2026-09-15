import type { HookResumeTiming } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  computeResumeTtrAttributes,
  type ResumeTtrTracking,
  resumeTimingForMessage,
  resumeTrackingFromMessage,
} from './resume-latency.js';

/**
 * A complete, well-ordered boundary set. Phase durations are all distinct so a
 * mis-wired boundary shows up as a wrong number rather than a coincidence:
 *
 *   T0 1_000  producer_prep   =  10
 *   T1 1_010  queue_delivery  =  40
 *   T2 1_050  resume_setup    =  20
 *   T3 1_070  replay          =  30
 *   T4 1_100  step_dispatch   =   5
 *   T5 1_105  step_claim      =  15
 *   T6 1_120  step_prepare    =   7
 *   T7 1_127  total           = 127
 */
const TRACKING: ResumeTtrTracking = {
  trigger: 'hook',
  strategy: 'parallel',
  resumeRequestedAtMs: 1_000,
  queuePublishRequestedAtMs: 1_010,
  consumerStartedAtMs: 1_050,
  replayStartedAtMs: 1_070,
  nextStepEncounteredAtMs: 1_100,
  setupSource: 'hook_preload',
  stepExecution: 'inline',
};

const CLAIM = {
  attempt: 1,
  stepClaimStartedAtMs: 1_105,
  stepClaimCompletedAtMs: 1_120 as number | undefined,
  stepCodeStartedAtMs: 1_127,
};

const PHASE_KEYS = [
  'workflow.resume.phase.producer_prep_ms',
  'workflow.resume.phase.queue_delivery_ms',
  'workflow.resume.phase.resume_setup_ms',
  'workflow.resume.phase.replay_ms',
  'workflow.resume.phase.step_dispatch_ms',
  'workflow.resume.phase.step_claim_ms',
  'workflow.resume.phase.step_prepare_ms',
] as const;

/** Sum of whichever phases were emitted. */
function sumPhases(attrs: Record<string, string | number>): number {
  return PHASE_KEYS.reduce(
    (total, key) => total + ((attrs[key] as number | undefined) ?? 0),
    0
  );
}

/** The emitted attributes, failing the test if the sample was suppressed. */
function emitted(
  params: Parameters<typeof computeResumeTtrAttributes>[0]
): Record<string, string | number> {
  const attrs = computeResumeTtrAttributes(params);
  if (!attrs) throw new Error('expected TTR attributes to be emitted');
  return attrs;
}

describe('computeResumeTtrAttributes', () => {
  it('emits total TTR and every phase for a lazy inline execution', () => {
    const attrs = computeResumeTtrAttributes({ tracking: TRACKING, ...CLAIM });
    expect(attrs).toEqual({
      'workflow.resume.total_ms': 127,
      'workflow.resume.phase.producer_prep_ms': 10,
      'workflow.resume.phase.queue_delivery_ms': 40,
      'workflow.resume.phase.resume_setup_ms': 20,
      'workflow.resume.phase.replay_ms': 30,
      'workflow.resume.phase.step_dispatch_ms': 5,
      'workflow.resume.phase.step_claim_ms': 15,
      'workflow.resume.phase.step_prepare_ms': 7,
      'workflow.resume.trigger': 'hook',
      'workflow.resume.strategy': 'parallel',
      'workflow.resume.setup_source': 'hook_preload',
      'workflow.resume.step_execution': 'inline',
    });
  });

  it('reports phases that sum exactly to the total', () => {
    const attrs = emitted({ tracking: TRACKING, ...CLAIM });
    // Every phase is derived from the same boundary set, so the identity is
    // exact — the tolerance is only here to document that a dashboard should
    // not assume better than millisecond rounding.
    expect(sumPhases(attrs)).toBeCloseTo(
      attrs['workflow.resume.total_ms'] as number,
      5
    );
  });

  it('omits only step_claim when the claim was not awaited (optimistic start)', () => {
    const attrs = emitted({
      tracking: TRACKING,
      ...CLAIM,
      stepClaimCompletedAtMs: undefined,
    });
    expect(attrs).not.toHaveProperty('workflow.resume.phase.step_claim_ms');
    // step_prepare absorbs the claim window (T5 → T7), so the sum still holds.
    expect(attrs['workflow.resume.phase.step_prepare_ms']).toBe(22);
    expect(sumPhases(attrs)).toBe(attrs['workflow.resume.total_ms']);
  });

  it('reports a dispatched next step with its own step_execution dimension', () => {
    const attrs = computeResumeTtrAttributes({
      tracking: { ...TRACKING, stepExecution: 'dispatched' },
      ...CLAIM,
    });
    expect(attrs?.['workflow.resume.step_execution']).toBe('dispatched');
    expect(attrs?.['workflow.resume.total_ms']).toBe(127);
  });

  it('emits nothing without tracking (an old queue message)', () => {
    expect(
      computeResumeTtrAttributes({ tracking: undefined, ...CLAIM })
    ).toBeUndefined();
  });

  it('emits nothing on a retry attempt', () => {
    expect(
      computeResumeTtrAttributes({ tracking: TRACKING, ...CLAIM, attempt: 2 })
    ).toBeUndefined();
  });

  it.each([
    ['replayStartedAtMs', { replayStartedAtMs: undefined }],
    ['nextStepEncounteredAtMs', { nextStepEncounteredAtMs: undefined }],
  ] as const)('emits nothing when %s is missing', (_label, override) => {
    expect(
      computeResumeTtrAttributes({
        tracking: { ...TRACKING, ...override },
        ...CLAIM,
      })
    ).toBeUndefined();
  });

  it('emits nothing when the claim start is missing', () => {
    expect(
      computeResumeTtrAttributes({
        tracking: TRACKING,
        ...CLAIM,
        stepClaimStartedAtMs: undefined,
      })
    ).toBeUndefined();
  });

  it.each([
    // Producer/consumer clock skew: T2 lands before T1.
    ['queue_delivery inverted', { consumerStartedAtMs: 1_005 }],
    ['resume_setup inverted', { replayStartedAtMs: 1_040 }],
    ['replay inverted', { nextStepEncounteredAtMs: 1_060 }],
    ['producer_prep inverted', { queuePublishRequestedAtMs: 990 }],
  ] as const)('omits the whole sample rather than a negative phase (%s)', (_label, override) => {
    expect(
      computeResumeTtrAttributes({
        tracking: { ...TRACKING, ...override },
        ...CLAIM,
      })
    ).toBeUndefined();
  });

  it('omits the sample when the claim boundaries invert', () => {
    expect(
      computeResumeTtrAttributes({
        tracking: TRACKING,
        ...CLAIM,
        stepClaimCompletedAtMs: 1_100,
      })
    ).toBeUndefined();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ] as const)('omits the sample for a non-finite boundary (%s)', (value) => {
    expect(
      computeResumeTtrAttributes({
        tracking: { ...TRACKING, consumerStartedAtMs: value },
        ...CLAIM,
      })
    ).toBeUndefined();
  });

  it('accepts a zero-length phase (boundaries within the same millisecond)', () => {
    const attrs = computeResumeTtrAttributes({
      tracking: { ...TRACKING, replayStartedAtMs: 1_050 },
      ...CLAIM,
    });
    expect(attrs?.['workflow.resume.phase.resume_setup_ms']).toBe(0);
    expect(attrs?.['workflow.resume.phase.replay_ms']).toBe(50);
  });

  it('omits the strategy and setup_source dimensions when unknown', () => {
    const attrs = emitted({
      tracking: {
        ...TRACKING,
        strategy: undefined,
        setupSource: undefined,
      },
      ...CLAIM,
    });
    expect(attrs).not.toHaveProperty('workflow.resume.strategy');
    expect(attrs).not.toHaveProperty('workflow.resume.setup_source');
    expect(attrs['workflow.resume.trigger']).toBe('hook');
  });
});

describe('resumeTrackingFromMessage', () => {
  const timing: HookResumeTiming = {
    resumeRequestedAtMs: 1_000,
    queuePublishRequestedAtMs: 1_010,
    strategy: 'sequential',
    consumerStartedAtMs: 1_050,
    replayStartedAtMs: 1_070,
    nextStepEncounteredAtMs: 1_100,
    setupSource: 'run_started',
  };

  it('rebuilds a dispatched step message verbatim', () => {
    expect(resumeTrackingFromMessage(timing, 'dispatched')).toEqual({
      trigger: 'hook',
      strategy: 'sequential',
      resumeRequestedAtMs: 1_000,
      queuePublishRequestedAtMs: 1_010,
      consumerStartedAtMs: 1_050,
      replayStartedAtMs: 1_070,
      nextStepEncounteredAtMs: 1_100,
      setupSource: 'run_started',
      stepExecution: 'dispatched',
    });
  });

  it('returns undefined for a message with no timing (an old producer)', () => {
    expect(resumeTrackingFromMessage(undefined, 'inline')).toBeUndefined();
  });

  it('returns undefined when the producer boundaries are not finite', () => {
    expect(
      resumeTrackingFromMessage(
        { resumeRequestedAtMs: Number.NaN, queuePublishRequestedAtMs: 1_010 },
        'inline'
      )
    ).toBeUndefined();
  });

  it('leaves the consumer start unusable on a producer-only message', () => {
    // The runtime overwrites this with its own handler-entry time for an
    // inline resume, and drops the tracking entirely if it does not.
    const tracking = resumeTrackingFromMessage(
      {
        resumeRequestedAtMs: 1_000,
        queuePublishRequestedAtMs: 1_010,
        strategy: 'parallel',
      },
      'inline'
    );
    expect(Number.isFinite(tracking?.consumerStartedAtMs)).toBe(false);
    expect(tracking?.replayStartedAtMs).toBeUndefined();
  });

  it.each([
    'bogus',
    '',
  ] as const)('ignores an unrecognized strategy (%s) rather than failing', (strategy) => {
    const tracking = resumeTrackingFromMessage(
      { ...timing, strategy },
      'inline'
    );
    expect(tracking).toBeDefined();
    expect(tracking?.strategy).toBeUndefined();
  });

  it('ignores an unrecognized setup source', () => {
    const tracking = resumeTrackingFromMessage(
      { ...timing, setupSource: 'from_the_future' },
      'inline'
    );
    expect(tracking).toBeDefined();
    expect(tracking?.setupSource).toBeUndefined();
  });
});

describe('resumeTimingForMessage', () => {
  it('round-trips through a dispatched step message', () => {
    const forwarded = resumeTimingForMessage(TRACKING);
    expect(forwarded).toEqual({
      resumeRequestedAtMs: 1_000,
      queuePublishRequestedAtMs: 1_010,
      strategy: 'parallel',
      consumerStartedAtMs: 1_050,
      replayStartedAtMs: 1_070,
      nextStepEncounteredAtMs: 1_100,
      setupSource: 'hook_preload',
    });
    // The receiving invocation reconstructs the same measurement, differing
    // only in how the step got there.
    const rebuilt = resumeTrackingFromMessage(forwarded, 'dispatched');
    expect(rebuilt).toEqual({ ...TRACKING, stepExecution: 'dispatched' });
    expect(computeResumeTtrAttributes({ tracking: rebuilt, ...CLAIM })).toEqual(
      computeResumeTtrAttributes({
        tracking: { ...TRACKING, stepExecution: 'dispatched' },
        ...CLAIM,
      })
    );
  });

  it('returns undefined without tracking', () => {
    expect(resumeTimingForMessage(undefined)).toBeUndefined();
  });

  it('refuses to forward tracking with no usable consumer start', () => {
    expect(
      resumeTimingForMessage({
        ...TRACKING,
        consumerStartedAtMs: Number.NaN,
      })
    ).toBeUndefined();
  });
});
