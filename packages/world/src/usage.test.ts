import { describe, expect, it } from 'vitest';
import {
  buildRunUsage,
  formatCount,
  formatDataPurgedNote,
  formatDataWrittenHeading,
  formatEventCountingNote,
  formatEventsWithRetries,
  formatLocalDataWrittenNote,
  formatOtherSteps,
  formatRunEventsLine,
  formatStepEventsBreakdown,
  formatUsageBytes,
  formatUsageFooter,
  formatUsageShare,
  type RunUsageAggregates,
  type RunUsageStepGroup,
  usageEntityOfEventType,
  usageSpanLabel,
  usageSpanTree,
} from './usage.js';

const WORKFLOW = 'workflow//./src/w//wf';

/** A step group; `events` defaults to the sum of its per-type counts. */
const stepGroup = (
  stepName: string | null,
  fields: Partial<Omit<RunUsageStepGroup, 'stepName'>>
): RunUsageStepGroup => {
  const counts = {
    steps: 0,
    created: 0,
    started: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    // Each retry started its step again, unless a test says otherwise.
    restarts: fields.retries ?? 0,
    bytes: 0,
    ...fields,
  };
  return {
    stepName,
    events:
      counts.created +
      counts.started +
      counts.completed +
      counts.failed +
      counts.retries,
    ...counts,
  };
};

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
          // Two calls, one retried: 2 + 3 + 2 + 1.
          stepGroup('step//a', {
            steps: 2,
            created: 2,
            started: 3,
            completed: 2,
            retries: 1,
            bytes: 400,
          }),
          stepGroup('step//b', {
            steps: 1,
            created: 1,
            started: 1,
            completed: 1,
            bytes: 90,
          }),
        ],
        streamBytes: 1234,
      })
    );

    expect(usage.events).toBe(21);
    expect(usage.billableEvents).toBe(21);
    expect(usage.retries).toEqual({ count: 1, events: 2 });
    expect(usage.eventsBySpan.map((s) => [s.kind, s.name, s.events])).toEqual([
      ['step', 'step//a', 8],
      ['hook', 'hook', 3],
      ['step', 'step//b', 3],
      ['run', WORKFLOW, 3],
      // Attribute writes are not the run's lifecycle: their own span.
      ['attributes', 'attributes', 2],
      ['wait', 'sleep', 2],
    ]);
    expect(usage.runEvents).toEqual({
      events: 3,
      byType: { created: 1, started: 1, completed: 1, failed: 0, cancelled: 0 },
    });
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

  it('makes each hook a span named by its token', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'run_created', events: 1, bytes: 1 },
          { eventType: 'hook_created', events: 3, bytes: 30 },
          { eventType: 'hook_received', events: 4, bytes: 40 },
        ],
        hookGroups: [
          { hookId: 'hook_a', token: 'approve:1', events: 4 },
          { hookId: 'hook_b', token: null, events: 2 },
          // Not in a group: still counted, as "hook".
        ],
      })
    );
    expect(
      usage.eventsBySpan
        .filter((span) => span.kind === 'hook')
        .map((span) => [span.name, span.id, span.events, span.calls])
    ).toEqual([
      ['approve:1', 'hook_a', 4, 1],
      // No token found: its id.
      ['hook_b', 'hook_b', 2, 1],
      ['hook', undefined, 1, 0],
    ]);
    expect(usage.events).toBe(8);
    expect(usage.eventsBySpan.reduce((sum, s) => sum + s.events, 0)).toBe(8);
    expect(usage.dataWritten.byEntity.hook).toBe(70);
  });

  it('keeps hooks as one span for a World without hook groups', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'hook_created', events: 2, bytes: 1 },
          { eventType: 'hook_received', events: 1, bytes: 1 },
        ],
      })
    );
    expect(usage.eventsBySpan).toEqual([
      expect.objectContaining({
        kind: 'hook',
        name: 'hook',
        events: 3,
        calls: 2,
      }),
    ]);
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
        stepGroups: [
          stepGroup(null, { steps: 1, started: 1, completed: 1, bytes: 1 }),
        ],
      })
    );
    expect(usage.eventsBySpan[0]).toMatchObject({
      name: '(unknown step)',
      share: 1,
    });

    const empty = buildRunUsage(aggregates());
    expect(empty).toMatchObject({
      events: 0,
      retries: { count: 0, events: 0 },
      eventsBySpan: [],
    });
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
  it('summarizes a local run without calling its events billable', () => {
    const one = buildRunUsage(
      aggregates({
        stepGroups: [stepGroup('s', { steps: 1, retries: 1 })],
      })
    );
    expect(one.billed).toBe(false);
    expect(one.billableEvents).toBe(1);
    expect(formatEventsWithRetries(one)).toEqual({
      events: '1',
      retries: '1 retry',
    });
    const many = buildRunUsage(
      aggregates({
        stepGroups: [stepGroup('s', { steps: 1, events: 1234, retries: 3 })],
      })
    );
    expect(formatEventsWithRetries(many)).toEqual({
      events: '1,234',
      retries: '3 retries',
    });
    // No line says what the run would count as on Vercel.
    expect(
      [...formatEventCountingNote(many), formatUsageFooter(many)].join('\n')
    ).not.toMatch(/On Vercel|billable/);
  });

  it('calls a billed run’s events billable', () => {
    const usage = buildRunUsage(
      aggregates({
        billed: true,
        stepGroups: [stepGroup('s', { steps: 1, events: 12, retries: 2 })],
      })
    );
    expect(usage.billed).toBe(true);
    expect(formatUsageFooter(usage)).toBe('Not your final bill.');
    expect(formatDataWrittenHeading(usage)).toBe('Data written');
    expect(formatLocalDataWrittenNote(usage)).toBeNull();
  });

  it('words a local run’s footer, storage and counting lines as not billed', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('s', {
            steps: 2,
            created: 2,
            started: 3,
            completed: 2,
            retries: 1,
          }),
        ],
      })
    );
    expect(formatUsageFooter(usage)).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory."
    );
    expect(formatDataWrittenHeading(usage)).toBe('Data written (local)');
    expect(formatLocalDataWrittenNote(usage)).toBe(
      'Data this run wrote to your local data directory. Vercel measures Data Written in its own storage, so the number on Vercel will differ.'
    );
    expect(formatEventCountingNote(usage)).toEqual([
      '2 steps wrote 8 events: 2 created, 3 started, 2 completed, 1 retry marker.',
      '1 retry added 2 events: 1 retry marker, 1 step start.',
    ]);
  });

  it('says what the run writes in the CLI note when no step ran', () => {
    const usage = buildRunUsage(
      aggregates({
        status: 'pending',
        eventGroups: [{ eventType: 'run_created', events: 1, bytes: 1 }],
      })
    );
    expect(formatEventCountingNote(usage)).toEqual([
      'The run wrote 1 event so far: 1 created.',
      'A retry adds a retry marker, and the step starting again.',
    ]);
    expect(formatEventCountingNote(buildRunUsage(aggregates()))).toEqual([
      'The run wrote no events.',
      'A retry adds a retry marker, and the step starting again.',
    ]);
  });

  it.each([
    [
      'completed',
      { run_created: 1, run_started: 1, run_completed: 1 },
      'The run wrote 3 events: 1 created, 1 started, 1 completed.',
    ],
    [
      'failed',
      { run_created: 1, run_started: 1, run_failed: 1 },
      'The run wrote 3 events: 1 created, 1 started, 1 failed.',
    ],
    [
      'cancelled',
      { run_created: 1, run_started: 1, run_cancelled: 1 },
      'The run wrote 3 events: 1 created, 1 started, 1 cancelled.',
    ],
    [
      'cancelled',
      // Cancelled before it started.
      { run_created: 1, run_cancelled: 1 },
      'The run wrote 2 events: 1 created, 1 cancelled.',
    ],
    [
      'running',
      { run_created: 1, run_started: 1 },
      'The run wrote 2 events so far: 1 created, 1 started.',
    ],
    [
      'completed',
      // A run event type this build does not know.
      { run_created: 1, run_started: 1, run_completed: 1, run_paused: 1 },
      'The run wrote 4 events: 1 created, 1 started, 1 completed, 1 other.',
    ],
  ] as const)('builds the %s run line from the run’s own events: %j', (status, counts, line) => {
    const usage = buildRunUsage(
      aggregates({
        status,
        eventGroups: Object.entries(counts).map(([eventType, events]) => ({
          eventType,
          events,
          bytes: 1,
        })),
      })
    );
    expect(formatRunEventsLine(usage)).toBe(line);
    expect(formatEventCountingNote(usage)[0]).toBe(line);
    expect(usageSpanTree(usage).builtIns[0]).toMatchObject({
      label: 'Run start & finish',
      events: usage.runEvents.events,
      note: line,
    });
  });

  it('gives attribute writes and unknown events their own rows', () => {
    const usage = buildRunUsage(
      aggregates({
        eventGroups: [
          { eventType: 'run_created', events: 1, bytes: 1 },
          { eventType: 'run_started', events: 1, bytes: 1 },
          { eventType: 'run_completed', events: 1, bytes: 1 },
          { eventType: 'attr_set', events: 4, bytes: 1 },
          { eventType: 'wait_created', events: 1, bytes: 1 },
          { eventType: 'wait_completed', events: 1, bytes: 1 },
          { eventType: 'future_thing', events: 2, bytes: 1 },
        ],
      })
    );
    const t = usageSpanTree(usage);
    expect(t.builtIns.map((row) => [row.label, row.events, row.calls])).toEqual(
      [
        ['Run start & finish', 3, 1],
        ['Attributes', 4, 4],
        ['Sleeps', 2, 1],
        ['Other events', 2, 2],
      ]
    );
    // Only the run row says what the run wrote, from its own counts.
    expect(t.builtIns[0].note).toBe(
      'The run wrote 3 events: 1 created, 1 started, 1 completed.'
    );
    expect(t.builtIns.slice(1).every((row) => row.note === undefined)).toBe(
      true
    );
    expect(t.showBuiltInLabel).toBe(true);
  });

  it('counts the events retries added from the log, not a fixed rate', () => {
    const usage = (fields: Partial<RunUsageStepGroup>) =>
      buildRunUsage(
        aggregates({
          stepGroups: [
            stepGroup('s', {
              steps: 1,
              created: 1,
              started: 1,
              completed: 0,
              ...fields,
            }),
          ],
        })
      );
    // Retried, not started again yet: the marker alone.
    const pending = usage({ retries: 1, restarts: 0 });
    expect(pending.retries).toEqual({ count: 1, events: 1 });
    expect(formatEventCountingNote(pending)[1]).toBe(
      '1 retry added 1 event: 1 retry marker.'
    );
    // Retried twice and started again both times.
    const twice = usage({ started: 3, completed: 1, retries: 2, restarts: 2 });
    expect(twice.retries).toEqual({ count: 2, events: 4 });
    expect(formatEventCountingNote(twice)[1]).toBe(
      '2 retries added 4 events: 2 retry markers, 2 step starts.'
    );
    // Summed over step groups: one restarted, one not yet.
    const mixed = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('a', { steps: 1, started: 1, retries: 1, restarts: 0 }),
          stepGroup('b', { steps: 1, started: 2, retries: 1, restarts: 1 }),
        ],
      })
    );
    expect(mixed.retries).toEqual({ count: 2, events: 3 });
    expect(formatEventCountingNote(mixed)[1]).toBe(
      '2 retries added 3 events: 2 retry markers, 1 step start.'
    );
  });

  it.each([
    [1, '+ 1 other step'],
    [3, '+ 3 other steps'],
    [1234, '+ 1,234 other steps'],
  ])('folds %d steps into %s', (steps, text) => {
    expect(formatOtherSteps(steps)).toBe(text);
  });

  it.each([
    [0, '0 retries'],
    [1, '1 retry'],
    [2, '2 retries'],
    [1234, '1,234 retries'],
  ])('pluralizes %d as %s', (count, text) => {
    expect(formatCount(count, 'retry', 'retries')).toBe(text);
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

describe('step events by type', () => {
  it('adds up the step groups, and keeps unknown types in other', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('step//a', {
            steps: 2,
            created: 2,
            started: 3,
            completed: 1,
            failed: 1,
            retries: 1,
          }),
          // A step event type this build does not know.
          stepGroup('step//b', {
            steps: 1,
            events: 4,
            created: 1,
            started: 1,
            completed: 1,
          }),
        ],
      })
    );
    expect(usage.stepEvents).toEqual({
      steps: 3,
      events: 12,
      byType: {
        created: 3,
        started: 4,
        completed: 2,
        failed: 1,
        retrying: 1,
        other: 1,
      },
    });
    expect(
      Object.values(usage.stepEvents.byType).reduce((a, b) => a + b, 0)
    ).toBe(usage.stepEvents.events);
    expect(
      usage.eventsBySpan
        .filter((span) => span.kind === 'step')
        .reduce((sum, span) => sum + span.events, 0)
    ).toBe(usage.stepEvents.events);
  });

  it('explains a spec 8 run: every step has a created event', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('step//a', {
            steps: 5,
            created: 5,
            started: 7,
            completed: 5,
            retries: 2,
          }),
        ],
      })
    );
    expect(formatStepEventsBreakdown(usage)).toBe(
      '5 steps wrote 19 events: 5 created, 7 started, 5 completed, 2 retry markers'
    );
    expect(usage.stepEvents.byType.created).toBe(usage.stepEvents.steps);
  });

  it('explains a spec 9 run whose steps all ran inline (no created)', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('step//a', { steps: 5, started: 5, completed: 5 }),
        ],
      })
    );
    expect(usage.stepEvents.byType.created).toBe(0);
    expect(formatStepEventsBreakdown(usage)).toBe(
      '5 steps wrote 10 events: 5 started, 5 completed'
    );
  });

  it('explains a spec 9 run that mixes inline and queued steps', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          // 2 queued (created) and 3 inline; one retried twice.
          stepGroup('step//a', {
            steps: 5,
            created: 2,
            started: 7,
            completed: 4,
            failed: 1,
            retries: 2,
          }),
        ],
      })
    );
    expect(formatStepEventsBreakdown(usage)).toBe(
      '5 steps wrote 16 events: 2 created, 7 started, 4 completed, 1 failed, 2 retry markers'
    );
    // 3 ran inline: no created event.
    expect(usage.stepEvents.steps - usage.stepEvents.byType.created).toBe(3);
    expect(usage.retries).toEqual({ count: 2, events: 4 });
  });

  it('uses the singular for one step and one marker', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('step//a', {
            steps: 1,
            started: 2,
            completed: 1,
            retries: 1,
          }),
        ],
      })
    );
    expect(formatStepEventsBreakdown(usage)).toBe(
      '1 step wrote 4 events: 2 started, 1 completed, 1 retry marker'
    );
  });

  it('says nothing when no step ran', () => {
    const usage = buildRunUsage(aggregates());
    expect(usage.stepEvents).toEqual({
      steps: 0,
      events: 0,
      byType: {
        created: 0,
        started: 0,
        completed: 0,
        failed: 0,
        retrying: 0,
        other: 0,
      },
    });
    expect(formatStepEventsBreakdown(usage)).toBeNull();
  });
});

describe('a run whose data was deleted', () => {
  const purgedRun = (overrides: Partial<RunUsageAggregates>) =>
    buildRunUsage(
      aggregates({
        eventGroups: [{ eventType: 'run_created', events: 1, bytes: 40 }],
        stepGroups: [
          stepGroup('s', {
            steps: 1,
            created: 1,
            started: 1,
            completed: 1,
            bytes: 60,
          }),
        ],
        ...overrides,
      })
    );

  it('reports the saved sizes, not the rows left', () => {
    const usage = purgedRun({
      dataPurged: true,
      savedDataWritten: { run: 4000, step: 9000, hook: 0, stream: 2500 },
    });
    expect(usage.dataPurged).toBe(true);
    expect(usage.dataWritten).toEqual({
      bytes: 15_500,
      byEntity: { run: 4000, step: 9000, hook: 0, stream: 2500 },
      source: 'saved-at-purge',
    });
    // Counts do not depend on the data.
    expect(usage.events).toBe(4);
    expect(formatDataPurgedNote(usage)).toBe(
      "This run's data was deleted; sizes show what it wrote."
    );
  });

  it('reports what is left when no sizes were saved, and says so', () => {
    const usage = purgedRun({ dataPurged: true });
    expect(usage.dataWritten).toEqual({
      bytes: 100,
      byEntity: { run: 40, step: 60, hook: 0, stream: 0 },
      source: 'left-after-purge',
    });
    expect(formatDataPurgedNote(usage)).toBe(
      "This run's data was deleted before its sizes were kept; sizes show what is left."
    );
  });

  it('ignores saved sizes on a run that kept its data', () => {
    const usage = purgedRun({
      savedDataWritten: { run: 1, step: 1, hook: 1, stream: 1 },
    });
    expect(usage.dataPurged).toBe(false);
    expect(usage.dataWritten).toEqual({
      bytes: 100,
      byEntity: { run: 40, step: 60, hook: 0, stream: 0 },
      source: 'log',
    });
    expect(formatDataPurgedNote(usage)).toBeNull();
  });

  it('maps event types to the entities the World saves them under', () => {
    expect(usageEntityOfEventType('run_completed')).toBe('run');
    expect(usageEntityOfEventType('attr_set')).toBe('run');
    expect(usageEntityOfEventType('wait_created')).toBe('run');
    expect(usageEntityOfEventType('step_completed')).toBe('step');
    expect(usageEntityOfEventType('hook_received')).toBe('hook');
    expect(usageEntityOfEventType('noop')).toBeNull();
  });
});

describe('the span tree', () => {
  const tree = (overrides: Partial<RunUsageAggregates> = {}) =>
    buildRunUsage(
      aggregates({
        workflowName: WORKFLOW,
        eventGroups: [
          { eventType: 'run_created', events: 1, bytes: 1 },
          { eventType: 'run_started', events: 1, bytes: 1 },
          { eventType: 'run_completed', events: 1, bytes: 1 },
          { eventType: 'wait_created', events: 2, bytes: 1 },
          { eventType: 'wait_completed', events: 2, bytes: 1 },
          { eventType: 'hook_created', events: 1, bytes: 1 },
          { eventType: 'hook_received', events: 3, bytes: 1 },
        ],
        stepGroups: [
          stepGroup('step//./src/w//small', {
            steps: 1,
            created: 1,
            started: 1,
            completed: 1,
          }),
          stepGroup('step//./src/w//big', {
            steps: 4,
            created: 4,
            started: 5,
            completed: 4,
            retries: 1,
          }),
          ...['a', 'b', 'c', 'd', 'e'].map((n) =>
            stepGroup(`step//./src/w//${n}`, {
              steps: 1,
              created: 1,
              started: 1,
              completed: 1,
            })
          ),
        ],
        ...overrides,
      })
    );

  it('puts the workflow first, steps biggest first, built-in rows last', () => {
    const usage = tree();
    const t = usageSpanTree(usage);
    expect(t.workflow).toEqual({ label: 'wf', events: usage.events });
    expect(t.steps.map((row) => row.label)).toEqual([
      'big',
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(t.steps[0]).toMatchObject({ calls: 4, retries: 1, events: 14 });
    // Steps only fold into "+ N other steps".
    expect(t.otherSteps).toMatchObject({ steps: 2, events: 6, calls: 2 });
    expect(t.builtIns.map((row) => [row.label, row.events, row.calls])).toEqual(
      [
        ['Run start & finish', 3, 1],
        ['Sleeps', 4, 2],
        ['Hooks', 4, 1],
      ]
    );
    expect(t.builtIns[0].note).toBe(formatRunEventsLine(usage));
    expect(t.showBuiltInLabel).toBe(true);
  });

  it('labels the built-in rows only when sleeps or hooks exist', () => {
    const usage = tree({
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 1 }],
    });
    const t = usageSpanTree(usage);
    expect(t.builtIns.map((row) => row.label)).toEqual(['Run start & finish']);
    expect(t.showBuiltInLabel).toBe(false);
  });

  it('counts calls: steps per name, distinct sleeps and hooks, one run', () => {
    const usage = tree({ calls: { wait: 5 } });
    const calls = Object.fromEntries(
      usage.eventsBySpan.map((span) => [
        `${span.kind}:${span.name}`,
        span.calls,
      ])
    );
    expect(calls['step:step//./src/w//big']).toBe(4);
    expect(calls['run:workflow//./src/w//wf']).toBe(1);
    // Without hook groups, hook_created events stand in for the hooks.
    expect(calls['hook:hook']).toBe(1);
    expect(calls['wait:sleep']).toBe(5);
    // Without distinct counts, the *_created events stand in.
    const fallback = tree();
    expect(fallback.eventsBySpan.find((s) => s.kind === 'wait')?.calls).toBe(2);
    expect(fallback.eventsBySpan.find((s) => s.kind === 'hook')?.calls).toBe(1);
  });
});

describe('step labels in the span tree', () => {
  it('adds the module to steps whose short names collide, and only to them', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          stepGroup('step//./src/a//send', { steps: 3, started: 3 }),
          stepGroup('step//./src/b//send', { steps: 2, started: 2 }),
          stepGroup('step//./src/a//charge', { steps: 1, started: 1 }),
        ],
      })
    );
    expect(usageSpanTree(usage).steps.map((row) => row.label)).toEqual([
      'send (./src/a)',
      'send (./src/b)',
      'charge',
    ]);
  });

  it('keeps short labels when the colliding step is folded away', () => {
    const usage = buildRunUsage(
      aggregates({
        stepGroups: [
          ...['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) =>
            stepGroup(`step//./src/a//${n}`, { steps: 1, started: 20 - i })
          ),
          stepGroup('step//./src/b//a', { steps: 1, started: 1 }),
        ],
      })
    );
    const t = usageSpanTree(usage);
    expect(t.steps.map((row) => row.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(t.otherSteps?.steps).toBe(2);
  });
});

describe('usageSpanLabel', () => {
  it.each([
    ['step', 'step//./src/workflows/order//chargeCard', 'chargeCard'],
    ['step', 'step//./src/jobs/order//default', 'order'],
    ['run', 'workflow//./src/workflows/order//processOrder', 'processOrder'],
    ['step', '(unknown step)', '(unknown step)'],
    ['hook', 'hook', 'hook'],
    ['wait', 'sleep', 'sleep'],
  ] as const)('labels a %s span %s as %s', (kind, name, label) => {
    expect(usageSpanLabel({ kind, name })).toBe(label);
  });
});

describe('folding steps in the span tree', () => {
  const steps = (n: number) =>
    buildRunUsage(
      aggregates({
        stepGroups: Array.from({ length: n }, (_, i) =>
          stepGroup(`step//./src/w//s${i}`, {
            steps: 1,
            started: 10 - i,
            retries: i === 7 ? 2 : 0,
          })
        ),
      })
    );

  it('folds the steps past five into one row', () => {
    const t = usageSpanTree(steps(8));
    expect(t.steps.map((row) => row.label)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's4',
    ]);
    expect(t.otherSteps).toMatchObject({
      steps: 3,
      events: 5 + 4 + 3 + 2,
      retries: 2,
      calls: 3,
    });
  });

  it('shows a single extra step rather than "+ 1 other step"', () => {
    const t = usageSpanTree(steps(6));
    expect(t.steps).toHaveLength(6);
    expect(t.otherSteps).toBeNull();
  });
});
