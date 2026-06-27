import { describe, expect, it } from 'vitest';
import {
  deriveSpanDetailView,
  mergeSpanDetail,
  resourceNeedsFetchedDetail,
  spanDetailMatchesSelection,
} from '../src/components/sidebar/span-detail-merge.js';

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

  it('returns span data when there is no fetched detail', () => {
    expect(mergeSpanDetail(spanStep, null)).toBe(spanStep);
    expect(mergeSpanDetail(spanStep, undefined)).toBe(spanStep);
  });

  it('returns fetched detail when there is no span data', () => {
    expect(mergeSpanDetail(null, fetchedStep)).toBe(fetchedStep);
    expect(mergeSpanDetail(undefined, fetchedStep)).toBe(fetchedStep);
  });
});

describe('spanDetailMatchesSelection', () => {
  const step = { stepId: 'step_a', runId: 'wrun_1' };
  const hook = { hookId: 'hook_a', runId: 'wrun_1', token: 'tok' };
  const run = { runId: 'wrun_1', workflowName: 'workflows/main' };
  const wait = { waitId: 'wait_a', runId: 'wrun_1' };

  it('matches a detail to its own resource and id', () => {
    expect(spanDetailMatchesSelection(step, 'step', 'step_a')).toBe(true);
    expect(spanDetailMatchesSelection(hook, 'hook', 'hook_a')).toBe(true);
    expect(spanDetailMatchesSelection(wait, 'sleep', 'wait_a')).toBe(true);
    expect(spanDetailMatchesSelection(run, 'run', 'wrun_1')).toBe(true);
  });

  it('rejects a stale step detail while a hook is selected', () => {
    // Navigating from a step onto a hook leaves the step detail set for a
    // frame; it must not match the hook (would union their fields).
    expect(spanDetailMatchesSelection(step, 'hook', 'hook_a')).toBe(false);
  });

  it('rejects a detail whose id differs from the current selection', () => {
    expect(spanDetailMatchesSelection(step, 'step', 'step_b')).toBe(false);
    expect(spanDetailMatchesSelection(hook, 'hook', 'hook_b')).toBe(false);
  });

  it('rejects child resources for a run selection despite their runId', () => {
    expect(spanDetailMatchesSelection(step, 'run', 'wrun_1')).toBe(false);
    expect(spanDetailMatchesSelection(hook, 'run', 'wrun_1')).toBe(false);
    expect(spanDetailMatchesSelection(wait, 'run', 'wrun_1')).toBe(false);
  });

  it('returns false for missing detail, resource, or id', () => {
    expect(spanDetailMatchesSelection(null, 'step', 'step_a')).toBe(false);
    expect(spanDetailMatchesSelection(step, undefined, 'step_a')).toBe(false);
    expect(spanDetailMatchesSelection(step, 'step', undefined)).toBe(false);
  });
});

describe('resourceNeedsFetchedDetail', () => {
  it('is true for resources whose input/output loads lazily', () => {
    expect(resourceNeedsFetchedDetail('run')).toBe(true);
    expect(resourceNeedsFetchedDetail('step')).toBe(true);
    expect(resourceNeedsFetchedDetail('sleep')).toBe(true);
  });

  it('is false for hooks (rendered from inline data) and unknowns', () => {
    expect(resourceNeedsFetchedDetail('hook')).toBe(false);
    expect(resourceNeedsFetchedDetail('event')).toBe(false);
    expect(resourceNeedsFetchedDetail(undefined)).toBe(false);
  });
});

describe('deriveSpanDetailView', () => {
  const inlineStep = { stepId: 'step_a', runId: 'wrun_1', status: 'completed' };
  const fetchedStep = {
    stepId: 'step_a',
    runId: 'wrun_1',
    output: { ok: true },
  };

  it('is idle when nothing is selected', () => {
    const view = deriveSpanDetailView({
      resource: undefined,
      resourceId: undefined,
      inlineData: undefined,
      fetchedDetail: null,
      fetchedError: null,
    });
    expect(view.status).toBe('idle');
  });

  it('is loading right after selection, before the detail arrives', () => {
    const view = deriveSpanDetailView({
      resource: 'step',
      resourceId: 'step_a',
      inlineData: inlineStep,
      fetchedDetail: null,
      fetchedError: null,
    });
    expect(view.status).toBe('loading');
    // Inline data shows immediately; the fetched output is not present yet.
    expect(view.displayData.status).toBe('completed');
    expect(view.displayData.output).toBeUndefined();
  });

  it('is ready once a matching detail arrives, merging input/output', () => {
    const view = deriveSpanDetailView({
      resource: 'step',
      resourceId: 'step_a',
      inlineData: inlineStep,
      fetchedDetail: fetchedStep,
      fetchedError: null,
    });
    expect(view.status).toBe('ready');
    expect(view.detail).toBe(fetchedStep);
    expect(view.displayData.output).toEqual({ ok: true });
    // Inline status stays authoritative over the merged result.
    expect(view.displayData.status).toBe('completed');
  });

  it('stays loading when the held detail belongs to a different span (stale)', () => {
    // The detail for a previously selected step lingers for a frame after
    // navigating to a new step — it must be rejected, not merged.
    const view = deriveSpanDetailView({
      resource: 'step',
      resourceId: 'step_b',
      inlineData: { stepId: 'step_b', runId: 'wrun_1' },
      fetchedDetail: fetchedStep,
      fetchedError: null,
    });
    expect(view.status).toBe('loading');
    expect(view.detail).toBeNull();
    expect(view.displayData.output).toBeUndefined();
  });

  it('is ready immediately for hooks (no fetch step)', () => {
    const inlineHook = { hookId: 'hook_a', runId: 'wrun_1', token: 'tok' };
    const view = deriveSpanDetailView({
      resource: 'hook',
      resourceId: 'hook_a',
      inlineData: inlineHook,
      fetchedDetail: null,
      fetchedError: null,
    });
    expect(view.status).toBe('ready');
    expect(view.displayData.token).toBe('tok');
  });

  it('surfaces an error for the current selection', () => {
    const error = new Error('not found');
    const view = deriveSpanDetailView({
      resource: 'step',
      resourceId: 'step_a',
      inlineData: inlineStep,
      fetchedDetail: null,
      fetchedError: error,
    });
    expect(view.status).toBe('error');
    expect(view.error).toBe(error);
  });
});
