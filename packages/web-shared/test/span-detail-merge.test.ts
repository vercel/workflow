import { describe, expect, it } from 'vitest';
import { mergeSpanDetail } from '../src/components/sidebar/span-detail-merge.js';

describe('mergeSpanDetail', () => {
  const spanStep = {
    stepId: 'step_a',
    runId: 'wrun_1',
    createdAt: new Date('2026-06-05T16:55:18.569Z'),
    startedAt: new Date('2026-06-05T16:55:18.812Z'),
    completedAt: new Date('2026-06-05T16:55:18.913Z'),
  };

  const fetchedStep = {
    stepId: 'step_a',
    runId: 'wrun_1',
    createdAt: new Date('2026-06-05T16:55:18.571Z'),
    startedAt: new Date('2026-06-05T16:55:18.820Z'),
    completedAt: new Date('2026-06-05T16:55:18.911Z'),
    output: { ok: true },
  };

  it('keeps span-derived timestamps when the fetched detail swaps in', () => {
    const merged = mergeSpanDetail(spanStep, fetchedStep) as Record<
      string,
      unknown
    >;
    expect(merged.createdAt).toBe(spanStep.createdAt);
    expect(merged.startedAt).toBe(spanStep.startedAt);
    expect(merged.completedAt).toBe(spanStep.completedAt);
  });

  it('takes non-timestamp fields from the fetched detail', () => {
    const merged = mergeSpanDetail(spanStep, fetchedStep) as Record<
      string,
      unknown
    >;
    expect(merged.output).toEqual({ ok: true });
  });

  it('fills timestamps missing from the span data with fetched values', () => {
    const { startedAt: _ignored, ...spanWithoutStartedAt } = spanStep;
    const merged = mergeSpanDetail(spanWithoutStartedAt, fetchedStep) as Record<
      string,
      unknown
    >;
    expect(merged.startedAt).toBe(fetchedStep.startedAt);
  });

  it('keeps the span identity even when the detail is for a stale selection', () => {
    // While navigating with J/K, the fetched detail can briefly hold the
    // previously selected span. Identity must come from the current span so
    // fields like Step ID never show the wrong value or vanish.
    const stalePrevStep = {
      stepId: 'step_PREVIOUS',
      runId: 'wrun_1',
      output: { stale: true },
    };
    const merged = mergeSpanDetail(spanStep, stalePrevStep) as Record<
      string,
      unknown
    >;
    expect(merged.stepId).toBe('step_a');
  });

  it('does not clobber a fetched field with an explicit undefined on the span', () => {
    const spanWithUndefined = { stepId: 'step_a', startedAt: undefined };
    const merged = mergeSpanDetail(spanWithUndefined, fetchedStep) as Record<
      string,
      unknown
    >;
    expect(merged.startedAt).toBe(fetchedStep.startedAt);
    expect(merged.output).toEqual({ ok: true });
  });

  it('returns span data when there is no fetched detail', () => {
    expect(mergeSpanDetail(spanStep, null)).toBe(spanStep);
    expect(mergeSpanDetail(spanStep, undefined)).toBe(spanStep);
  });

  it('returns fetched detail when there is no span data', () => {
    expect(mergeSpanDetail(null, fetchedStep)).toBe(fetchedStep);
    expect(mergeSpanDetail(undefined, fetchedStep)).toBe(fetchedStep);
  });
});
