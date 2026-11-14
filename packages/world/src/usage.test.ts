import { describe, expect, it } from 'vitest';
import {
  buildRunUsage,
  collapseUsageSpans,
  EVENTS_PER_RETRY,
  formatRunUsageSummary,
  formatUsageBytes,
  formatUsageShare,
  type RunUsageAggregates,
  type RunUsageSpan,
} from './usage.js';

const WORKFLOW = 'workflow//./src/w//wf';

const aggregates = (
  overrides: Partial<RunUsageAggregates> = {}
): RunUsageAggregates => ({
  runId: 'wrun_1',
  status: 'completed',
  workflowName: WORKFLOW,
  eventGroups: [],
  stepGroups: [],
  streamBytes: 0,
  ...overrides,
});

describe('buildRunUsage', () => {
  it('groups events by span and entity', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'run_created', events: 1, bytes: 100 },
          { eventType: 'run_started', events: 1, bytes: 10 },
          { eventType: 'run_completed', events: 1, bytes: 50 },
          { eventType: 'attr_set', events: 2, bytes: 20 },
          { eventType: 'wait_created', events: 1, bytes: 5 },
          { eventType: 'wait_completed', events: 1, bytes: 5 },
          { eventType: 'hook_created', events: 1, bytes: 30 },
          { eventType: 'hook_received', events: 2, bytes: 70 },
        ],
        stepGroups: [
          { stepName: 'step//a', events: 8, retries: 1, bytes: 400 },
          { stepName: 'step//b', events: 3, retries: 0, bytes: 90 },
        ],
        streamBytes: 1234,
      })
    );

    expect(usage.events).toBe(21);
    expect(usage.billableEvents).toBe(21);
    expect(usage.retries).toEqual({ count: 1, events: EVENTS_PER_RETRY });
    expect(usage.eventsBySpan.map((s) => [s.kind, s.name, s.events])).toEqual([
      ['step', 'step//a', 8],
      ['run', WORKFLOW, 5],
      ['hook', 'hook', 3],
      ['step', 'step//b', 3],
      ['wait', 'sleep', 2],
    ]);
    expect(usage.eventsBySpan.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(
      1
    );
    // Sleeps are the run's bytes.
    expect(usage.dataWritten.byEntity).toEqual({
      run: 190,
      step: 490,
      hook: 100,
      stream: 1234,
    });
    expect(usage.dataWritten.bytes).toBe(190 + 490 + 100 + 1234);
    expect(usage.inProgress).toBe(false);
    expect(usage.dataRetained).toBeNull();
  });

  it('does not count placeholders as events', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'run_created', events: 1, bytes: 10 },
          { eventType: 'noop', events: 4, bytes: 8 },
        ],
      })
    );
    expect(usage.events).toBe(1);
    expect(usage.billableEvents).toBe(1);
    expect(usage.dataWritten.bytes).toBe(10);
  });

  it('marks a run that has not finished as in progress', () => {
    for (const status of ['pending', 'running'] as const) {
      expect(buildRunUsage(aggregates({ status })).inProgress).toBe(true);
    }
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(buildRunUsage(aggregates({ status })).inProgress).toBe(false);
    }
  });

  it('names a step without a row, and keeps an empty run at zero', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [{ stepName: null, events: 2, retries: 0, bytes: 1 }],
      })
    );
    expect(usage.eventsBySpan[0]).toMatchObject({
      name: '(unknown step)',
      share: 1,
    });

    const empty = buildRunUsage(aggregates());
    expect(empty).toMatchObject({ events: 0, eventsBySpan: [] });
    expect(formatRunUsageSummary(empty)).toBe('0 billable events · 0 retries');
  });

  it('ignores malformed counts rather than producing NaN', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'run_created', events: Number.NaN, bytes: -5 },
          { eventType: 'run_started', events: 1, bytes: Number.NaN },
        ],
        streamBytes: Number.NaN,
      })
    );
    expect(usage.events).toBe(1);
    expect(usage.dataWritten.bytes).toBe(0);
  });

  it('passes a backend retention through', () => {
    const usage = buildRunUsage(
      aggregates({ dataRetained: { byteMonths: 10, retentionMonths: 1 } })
    );
    expect(usage.dataRetained).toEqual({ byteMonths: 10, retentionMonths: 1 });
  });
});

describe('usage formatting', () => {
  it('summarizes billable events and retries', () => {
    const one = buildRunUsage(
      aggregates({
        stepGroups: [{ stepName: 's', events: 1, retries: 1, bytes: 0 }],
      })
    );
    expect(formatRunUsageSummary(one)).toBe(
      '1 billable event · 1 retry (+2 events)'
    );
    const many = buildRunUsage(
      aggregates({
        stepGroups: [{ stepName: 's', events: 1234, retries: 3, bytes: 0 }],
      })
    );
    expect(formatRunUsageSummary(many)).toBe(
      '1,234 billable events · 3 retries (+6 events)'
    );
  });

  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1 KB'],
    [1536, '1.54 KB'],
    [12_345, '12.3 KB'],
    [123_456, '123 KB'],
    [5_000_000, '5 MB'],
    [2_500_000_000, '2.5 GB'],
  ])('formats %d bytes as %s', (bytes, text) => {
    expect(formatUsageBytes(bytes)).toBe(text);
  });

  it.each([
    [0, '0%'],
    [0.004, '<1%'],
    [0.5, '50%'],
    [1, '100%'],
  ])('formats a share of %d as %s', (share, text) => {
    expect(formatUsageShare(share)).toBe(text);
  });
});

describe('collapseUsageSpans', () => {
  const spans = (n: number): RunUsageSpan[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'step',
      name: `s${i}`,
      events: 10 - i,
      share: 0.1,
      retries: i === 7 ? 2 : 0,
    }));

  it('folds spans past the limit into one row', () => {
    const { shown, other } = collapseUsageSpans(spans(8), 5);
    expect(shown.map((s) => s.name)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(other).toEqual({
      spans: 3,
      events: 5 + 4 + 3,
      share: expect.closeTo(0.3),
      retries: 2,
    });
  });

  it('shows a single extra span rather than "1 other span"', () => {
    expect(collapseUsageSpans(spans(6), 5)).toMatchObject({
      other: null,
    });
    expect(collapseUsageSpans(spans(6), 5).shown).toHaveLength(6);
  });
});
