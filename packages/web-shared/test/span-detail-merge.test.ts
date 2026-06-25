import { describe, expect, it } from 'vitest';
import {
  mergeSpanDetail,
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
