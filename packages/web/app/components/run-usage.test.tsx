import {
  cleanup,
  fireEvent,
  render as renderRaw,
  screen,
} from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import {
  buildRunUsage,
  formatEventCountingLines,
  type RunUsage,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunUsageHeaderStats, RunUsagePanel } from './run-usage';

/** The app's root provides tooltips; so does each test. */
const render = (ui: React.ReactElement) =>
  renderRaw(ui, { wrapper: TooltipProvider });

afterEach(cleanup);

const WORKFLOW = 'workflow//./src/workflows/order//processOrder';
const step = (name: string) => `step//./src/workflows/order//${name}`;

/** 1,183 events over nine step names, one of them retried. */
function bigRun(overrides: Partial<RunUsage> = {}): RunUsage {
  return {
    ...buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 400 },
        { eventType: 'run_started', events: 1, bytes: 100 },
        { eventType: 'run_completed', events: 1, bytes: 300 },
        { eventType: 'hook_created', events: 1, bytes: 120 },
        { eventType: 'hook_received', events: 1, bytes: 80 },
      ],
      stepGroups: [
        // 300 queued calls, one retried: 300 + 301 + 300 + 1.
        {
          stepName: step('chargeCard'),
          steps: 300,
          events: 902,
          created: 300,
          started: 301,
          completed: 300,
          failed: 0,
          retries: 1,
          bytes: 9000,
        },
        {
          stepName: step('sendEmail'),
          steps: 50,
          events: 150,
          created: 50,
          started: 50,
          completed: 50,
          failed: 0,
          retries: 0,
          bytes: 3000,
        },
        // 21 down to 15 events each, as a spec 9 run writes them: queued
        // calls write 3, inline calls 2 (no created). 38 queued, 6 inline.
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => {
          const events = 21 - n.charCodeAt(0) + 97;
          const inline = [0, 2, 1][events % 3];
          const queued = (events - 2 * inline) / 3;
          return {
            stepName: step(n),
            steps: queued + inline,
            events,
            created: queued,
            started: queued + inline,
            completed: queued + inline,
            failed: 0,
            retries: 0,
            bytes: 100,
          };
        }),
      ],
      streamBytes: 2500,
    }),
    ...overrides,
  };
}

describe('RunUsageHeaderStats', () => {
  it("shows the whole run's event count, not the loaded page", () => {
    const usage = bigRun();
    expect(usage.events).toBeGreaterThan(200);
    render(
      <RunUsageHeaderStats usage={usage} error={null} onOpenUsage={() => {}} />
    );
    expect(screen.getByTestId('run-usage-events').textContent).toBe(
      usage.events.toLocaleString('en-US')
    );
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/billable/i);
  });

  it('opens the Usage tab from Storage', () => {
    const onOpenUsage = vi.fn();
    render(
      <RunUsageHeaderStats
        usage={bigRun()}
        error={null}
        onOpenUsage={onOpenUsage}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '16.2 KB' }));
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });

  it('explains a local run’s Storage in a tooltip', async () => {
    // Radix measures the tooltip; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    render(
      <RunUsageHeaderStats
        usage={bigRun()}
        error={null}
        onOpenUsage={() => {}}
      />
    );
    // The label stays "Storage".
    const label = screen.getByTestId('run-usage-storage-label');
    expect(label.textContent).toBe('Storage');
    fireEvent.focus(label);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Data this run wrote to your local data directory. Vercel measures Data Written in its own storage, so the number on Vercel will differ.'
    );
  });

  it('has no local tooltip on a billed run', () => {
    render(
      <RunUsageHeaderStats
        usage={bigRun({ billed: true })}
        error={null}
        onOpenUsage={() => {}}
      />
    );
    expect(screen.queryByTestId('run-usage-storage-label')).toBeNull();
    expect(screen.getByText('Storage')).toBeTruthy();
  });

  it('shows placeholders until the count arrives', () => {
    render(
      <RunUsageHeaderStats
        usage={undefined}
        error={null}
        onOpenUsage={() => {}}
      />
    );
    expect(screen.queryByTestId('run-usage-events')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('RunUsagePanel', () => {
  it('summarizes a local run without calling its events billable', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-summary').textContent).toBe(
      '1,183 events · 1 retry'
    );
    expect(screen.getByTestId('run-usage-billable-note').textContent).toBe(
      'On Vercel, this run would count as 1,183 billable events.'
    );
    expect(document.body.textContent).not.toMatch(/\d billable events ·/);
  });

  it('calls a billed run’s events billable', () => {
    render(<RunUsagePanel usage={bigRun({ billed: true })} error={null} />);
    expect(screen.getByTestId('run-usage-summary').textContent).toBe(
      '1,183 billable events · 1 retry'
    );
    expect(screen.queryByTestId('run-usage-billable-note')).toBeNull();
    expect(screen.getByTestId('run-usage-footer').textContent).toBe(
      'Not your final bill.'
    );
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Data written'
    );
  });

  it('lists the workflow, its steps biggest first, then the built-in rows', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-driver').textContent).toBe(
      "chargeCard drives 76% of this run's events (902 events, 1 retry)."
    );
    const spans = () =>
      screen
        .getAllByTestId('run-usage-span')
        .map((row) => row.getAttribute('data-span'));
    expect(spans()).toEqual([
      'workflow',
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
      'Run start & finish',
      'Hooks',
    ]);
    const rows = screen.getAllByTestId('run-usage-span');
    // The workflow row: its name, a tag and the run's events; no share.
    expect(rows[0].textContent).toBe('processOrderworkflow1,183');
    expect(rows[1].textContent).toContain('1 retry');
    expect(rows[1].textContent).toContain('×300');
    expect(rows[2].textContent).not.toContain('retry');
    expect(screen.getByTestId('run-usage-built-in-label').textContent).toBe(
      'Built-in'
    );

    // Only steps fold: d, e, f, g.
    fireEvent.click(screen.getByRole('button', { name: '+ 4 other steps' }));
    expect(spans()).toEqual([
      'workflow',
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'Run start & finish',
      'Hooks',
    ]);
    expect(screen.queryByRole('button', { name: /other steps/ })).toBeNull();
  });

  it('never names a built-in row in the callout, and has none without steps', () => {
    const hooksHeavy = buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 1 },
        { eventType: 'hook_received', events: 90, bytes: 1 },
      ],
      stepGroups: [
        {
          stepName: step('tiny'),
          steps: 1,
          events: 3,
          created: 1,
          started: 1,
          completed: 1,
          failed: 0,
          retries: 0,
          bytes: 1,
        },
      ],
      streamBytes: 0,
    });
    const { unmount } = render(
      <RunUsagePanel usage={hooksHeavy} error={null} />
    );
    expect(screen.getByTestId('run-usage-driver').textContent).toMatch(
      /^tiny drives/
    );
    unmount();
    const noSteps = buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 1 }],
      stepGroups: [],
      streamBytes: 0,
    });
    render(<RunUsagePanel usage={noSteps} error={null} />);
    expect(screen.queryByTestId('run-usage-driver')).toBeNull();
    // Only the run's own events: no "Built-in" label.
    expect(screen.queryByTestId('run-usage-built-in-label')).toBeNull();
  });

  it('explains how events are counted with the shared lines', () => {
    const usage = bigRun();
    render(<RunUsagePanel usage={usage} error={null} />);
    const items = screen
      .getByTestId('run-usage-counting')
      .querySelectorAll('li');
    // The same lines the CLI draws from: one formatter in @workflow/world.
    expect([...items].map((li) => li.textContent)).toEqual(
      formatEventCountingLines(usage)
    );
    expect(items[0].textContent).toBe(
      '394 steps wrote 1,178 events: 388 created, 395 started, 394 completed, 1 retry marker.'
    );
    expect(items[1].textContent).toBe(
      '6 steps have no created event: they ran inline, and their first started event created them.'
    );
    expect(items[items.length - 1].textContent).toBe(
      'On Vercel, every event in the log is billable. The count covers the whole run, not only the events loaded on this page.'
    );
  });

  it('lists data written by entity with a total, and hides retention locally', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(
      screen.getAllByTestId('run-usage-entity').map((row) => row.textContent)
    ).toEqual(['Run800 B', 'Steps12.7 KB', 'Hooks200 B', 'Streams2.5 KB']);
    expect(screen.getByTestId('run-usage-total').textContent).toBe('16.2 KB');
    expect(screen.queryByTestId('run-usage-retained')).toBeNull();
  });

  it('shows Data retained when the backend has a retention period', () => {
    render(
      <RunUsagePanel
        usage={bigRun({
          dataRetained: { byteMonths: 16_200, retentionMonths: 1 },
        })}
        error={null}
      />
    );
    expect(screen.getByTestId('run-usage-retained').textContent).toContain(
      '16.2 KB-months'
    );
  });

  it('says local runs are not billed, and links to pricing', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-footer').textContent).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory."
    );
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Data written (local)'
    );
    expect(
      screen.getByRole('link', { name: 'See pricing →' }).getAttribute('href')
    ).toBe(WORKFLOW_PRICING_DOCS_URL);
  });

  it('notes that a running run can still grow', () => {
    render(
      <RunUsagePanel
        usage={bigRun({ status: 'running', inProgress: true })}
        error={null}
      />
    );
    expect(screen.getByText(/can still grow/)).toBeTruthy();
  });

  it('shows a read error, and keeps stale numbers with a note', () => {
    const { rerender } = render(
      <RunUsagePanel usage={undefined} error={new Error('locked')} />
    );
    expect(document.body.textContent).toContain(
      "Could not read this run's usage: locked"
    );
    rerender(<RunUsagePanel usage={bigRun()} error={new Error('locked')} />);
    expect(document.body.textContent).toContain('refreshing failed: locked');
    expect(screen.getByTestId('run-usage-summary')).toBeTruthy();
  });

  it('leaves out the creation note when every step has a created event', () => {
    const usage = buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [],
      stepGroups: [
        {
          stepName: step('a'),
          steps: 2,
          events: 6,
          created: 2,
          started: 2,
          completed: 2,
          failed: 0,
          retries: 0,
          bytes: 0,
        },
      ],
      streamBytes: 0,
    });
    render(<RunUsagePanel usage={usage} error={null} />);
    expect(
      screen.getByTestId('run-usage-counting').querySelector('li')?.textContent
    ).toBe('2 steps wrote 6 events: 2 created, 2 started, 2 completed.');
    expect(document.body.textContent).not.toContain('no created event');
  });

  it('says when a run’s data was deleted and its sizes are what it wrote', () => {
    const usage = buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 40 }],
      stepGroups: [],
      streamBytes: 0,
      dataPurged: true,
      savedDataWritten: { run: 300_000, step: 300_000, hook: 0, stream: 0 },
    });
    render(<RunUsagePanel usage={usage} error={null} />);
    expect(screen.getByTestId('run-usage-purged-note').textContent).toBe(
      "This run's data was deleted when it finished; sizes show what it wrote."
    );
    expect(screen.getByTestId('run-usage-total').textContent).toBe('600 KB');
  });

  it('says when a purged run’s sizes are only what is left', () => {
    const usage = buildRunUsage({
      runId: 'wrun_1',
      status: 'completed',
      workflowName: WORKFLOW,
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 40 }],
      stepGroups: [],
      streamBytes: 0,
      dataPurged: true,
    });
    render(<RunUsagePanel usage={usage} error={null} />);
    expect(screen.getByTestId('run-usage-purged-note').textContent).toBe(
      "This run's data was deleted when it finished, before its sizes were kept; sizes show what is left."
    );
  });

  it('has no purge note for a run that kept its data', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.queryByTestId('run-usage-purged-note')).toBeNull();
    expect(document.body.textContent).not.toContain('was deleted');
  });

  it('renders a run with no events', () => {
    const empty = buildRunUsage({
      runId: 'wrun_1',
      status: 'pending',
      workflowName: WORKFLOW,
      eventGroups: [],
      stepGroups: [],
      streamBytes: 0,
    });
    render(<RunUsagePanel usage={empty} error={null} />);
    expect(screen.getByTestId('run-usage-summary').textContent).toBe(
      '0 events · 0 retries'
    );
    expect(screen.queryByTestId('run-usage-driver')).toBeNull();
    expect(screen.getByTestId('run-usage-counting').textContent).not.toContain(
      'steps wrote'
    );
  });
});
