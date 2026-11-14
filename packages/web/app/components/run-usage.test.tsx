import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  buildRunUsage,
  type RunUsage,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunUsageHeaderStats, RunUsagePanel } from './run-usage';

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
    render(<RunUsageHeaderStats usage={usage} onOpenUsage={() => {}} />);
    expect(screen.getByTestId('run-usage-events').textContent).toBe(
      usage.events.toLocaleString('en-US')
    );
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/billable/i);
  });

  it('opens the Usage tab from Storage', () => {
    const onOpenUsage = vi.fn();
    render(<RunUsageHeaderStats usage={bigRun()} onOpenUsage={onOpenUsage} />);
    fireEvent.click(screen.getByRole('button', { name: '16.2 KB' }));
    expect(onOpenUsage).toHaveBeenCalledTimes(1);
  });

  it('shows placeholders until the count arrives', () => {
    render(<RunUsageHeaderStats usage={undefined} onOpenUsage={() => {}} />);
    expect(screen.queryByTestId('run-usage-events')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('RunUsagePanel', () => {
  it('summarizes billable events and retries', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-summary').textContent).toBe(
      '1,183 billable events · 1 retry (+2 events)'
    );
  });

  it('calls out the biggest driver and collapses the long tail', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-driver').textContent).toBe(
      "chargeCard drives 76% of this run's events (902 events, 1 retry)."
    );
    const rows = screen.getAllByTestId('run-usage-span');
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
    ]);
    expect(rows[0].textContent).toContain('1 retry');
    expect(rows[1].textContent).not.toContain('retry');

    // d, e, f, g, processOrder, hook.
    fireEvent.click(screen.getByRole('button', { name: '6 other spans' }));
    expect(screen.getAllByTestId('run-usage-span')).toHaveLength(11);
    expect(screen.queryByRole('button', { name: /other spans/ })).toBeNull();
  });

  it('explains how events are counted', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    const details = screen
      .getByText('How events are counted')
      .closest('details');
    // From the run's own counts, not a fixed number per step.
    expect(screen.getByTestId('run-usage-step-breakdown').textContent).toBe(
      '394 steps wrote 1,178 events: 388 created, 395 started, 394 completed, 1 retry marker.'
    );
    expect(details?.textContent).toContain(
      '6 steps have no created event: they ran inline, and their first started event created them.'
    );
    expect(details?.textContent).not.toContain('Each step writes 3 events');
    expect(details?.textContent).toContain('Each retry adds 2');
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

  it('says it is not the final bill and links to pricing', () => {
    render(<RunUsagePanel usage={bigRun()} error={null} />);
    expect(screen.getByText('Not your final bill.')).toBeTruthy();
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
    expect(screen.getByTestId('run-usage-step-breakdown').textContent).toBe(
      '2 steps wrote 6 events: 2 created, 2 started, 2 completed.'
    );
    expect(document.body.textContent).not.toContain('no created event');
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
      '0 billable events · 0 retries'
    );
    expect(screen.queryByTestId('run-usage-driver')).toBeNull();
    expect(screen.queryByTestId('run-usage-step-breakdown')).toBeNull();
  });
});
