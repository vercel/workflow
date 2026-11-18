import {
  cleanup,
  fireEvent,
  render as renderRaw,
  screen,
} from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import {
  buildRunUsage,
  type RunUsage,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dataWrittenLabel,
  RUN_USAGE_DOCS_URL,
  RunUsageHeaderStats,
  RunUsagePage,
  RunUsagePageSkeleton,
  runUsagePath,
  USAGE_TABLES_LAYOUT,
} from './run-usage';

/** The app's root provides tooltips and the router; so does each test. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <TooltipProvider>{children}</TooltipProvider>
    </MemoryRouter>
  );
}
const render = (ui: React.ReactElement) =>
  renderRaw(ui, { wrapper: Providers });

afterEach(cleanup);

const WORKFLOW = 'workflow//./src/workflows/order//processOrder';
const step = (name: string) => `step//./src/workflows/order//${name}`;

const stepGroup = (
  name: string,
  steps: number,
  { retries = 0, restarts }: { retries?: number; restarts?: number } = {}
) => stepGroupOf(name, steps, retries, restarts ?? retries);

const stepGroupOf = (
  name: string,
  steps: number,
  retries: number,
  restarts: number
) => ({
  stepName: step(name),
  steps,
  events: steps * 3 + retries + restarts,
  created: steps,
  started: steps + restarts,
  completed: steps,
  failed: 0,
  retries,
  restarts,
  bytes: steps * 100,
});

/**
 * 1,183 events: nine step names (one retried once), the run's own events,
 * an attribute write, a sleep and a hook.
 */
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
        { eventType: 'attr_set', events: 1, bytes: 50 },
        { eventType: 'wait_created', events: 1, bytes: 20 },
        { eventType: 'wait_completed', events: 1, bytes: 20 },
        { eventType: 'hook_created', events: 1, bytes: 120 },
        { eventType: 'hook_received', events: 1, bytes: 80 },
      ],
      stepGroups: [
        stepGroup('chargeCard', 300, { retries: 1 }),
        stepGroup('sendEmail', 50),
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) =>
          stepGroup(n, 7 - i)
        ),
      ],
      streamBytes: 2500,
    }),
    ...overrides,
  };
}

const rows = () => screen.getAllByTestId('run-usage-span');
const labels = () =>
  screen
    .getAllByTestId('run-usage-span-label')
    .map((label) => label.textContent);

describe('RunUsageHeaderStats', () => {
  it("shows the whole run's events and retries, not the loaded page", () => {
    const usage = bigRun();
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={usage}
        error={null}
        isLocalBackend
      />
    );
    expect(screen.getByTestId('run-usage-events').textContent).toBe(
      usage.events.toLocaleString('en-US')
    );
    expect(screen.getByTestId('run-usage-header-retries').textContent).toBe(
      '1 retry'
    );
    expect(document.body.textContent).not.toMatch(/billable/i);
  });

  it('leaves retries out of the header when there are none', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun({ retries: { count: 0, events: 0 } })}
        error={null}
        isLocalBackend
      />
    );
    expect(screen.queryByTestId('run-usage-header-retries')).toBeNull();
  });

  it('links both figures to the run’s Usage page', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isLocalBackend
      />
    );
    const events = screen.getByRole('link', {
      name: '1,144 events, open usage',
    });
    const data = screen.getByRole('link', {
      name: '41.4 KB data written (local), open usage',
    });
    expect(events.getAttribute('href')).toBe('/run/wrun_1/usage');
    expect(data.getAttribute('href')).toBe('/run/wrun_1/usage');
    expect(data.textContent).toBe('41.4 KB');
  });

  it('shows plain figures on the Usage page itself', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isLocalBackend
        onUsagePage
      />
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('run-usage-data-written').textContent).toBe(
      '41.4 KB'
    );
  });

  it('labels a local run’s figure “Data written (local)”, not “Storage”', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isLocalBackend
      />
    );
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Data written (local)'
    );
    expect(document.body.textContent).not.toContain('Storage');
  });

  it('labels a billed run’s figure “Data written”, without “(local)”', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun({ billed: true })}
        error={null}
        isLocalBackend={false}
      />
    );
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Data written'
    );
    // No local note to explain.
    expect(screen.queryByTestId('run-usage-data-help')).toBeNull();
  });

  it('keeps “(local)” while the first read is pending on the Local World', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={undefined}
        error={null}
        isLocalBackend
      />
    );
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Data written (local)'
    );
    expect(screen.queryByTestId('run-usage-events')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(dataWrittenLabel(undefined, false)).toBe('Data written');
  });

  it('explains “(local)” in a tooltip reachable by keyboard', async () => {
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
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isLocalBackend
      />
    );
    const help = screen.getByRole('button', {
      name: 'About Data written (local)',
    });
    fireEvent.focus(help);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Data this run wrote to your local data directory. Vercel measures Data Written in its own storage, so the number on Vercel will differ.'
    );
  });
});

describe('RunUsagePage', () => {
  it('lists the workflow, its steps biggest first, then the built-in rows', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(labels()).toEqual([
      'processOrder',
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
      'Run start & finish',
      'Attributes',
      'Sleeps',
      'Hooks',
    ]);
    expect(rows()[1].textContent).toContain('1 retry');
    expect(rows()[2].textContent).not.toContain('retry');
    expect(screen.getByTestId('run-usage-built-in-label').textContent).toBe(
      'Built-in'
    );

    // Only steps fold: d, e, f, g.
    fireEvent.click(screen.getByRole('button', { name: '+ 4 other steps' }));
    expect(labels()).toEqual([
      'processOrder',
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
      'Attributes',
      'Sleeps',
      'Hooks',
    ]);
    expect(screen.queryByRole('button', { name: /other steps/ })).toBeNull();
  });

  it('marks each row with the trace’s icon for its type', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const typeOf = (row: HTMLElement) =>
      row.querySelector('.sr-only')?.textContent;
    const byLabel: Record<string, { type?: string | null; icons: number }> =
      Object.fromEntries(
        rows().map((row) => [
          row.querySelector('[data-testid="run-usage-span-label"]')
            ?.textContent,
          { type: typeOf(row), icons: row.querySelectorAll('svg').length },
        ])
      );
    expect(byLabel.processOrder.type).toBe('Workflow:');
    expect(byLabel.chargeCard.type).toBe('Step:');
    expect(byLabel['Run start & finish'].type).toBe('Workflow:');
    expect(byLabel.Attributes.type).toBe('Workflow:');
    expect(byLabel.Sleeps.type).toBe('Sleep:');
    expect(byLabel.Hooks.type).toBe('Hook:');
    for (const { icons } of Object.values(byLabel)) {
      expect(icons).toBeGreaterThanOrEqual(1);
    }
  });

  it('says how many times a step, sleep or hook was called', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const calls = screen
      .getAllByTestId('run-usage-calls')
      .map((el) => el.textContent);
    // chargeCard, sendEmail, a, b, c, then the sleep and the hook.
    expect(calls).toEqual([
      '300 calls',
      '50 calls',
      '7 calls',
      '6 calls',
      '5 calls',
      '1 call',
      '1 call',
    ]);
    expect(document.body.textContent).not.toContain('×');
  });

  it('counts “Run start & finish” from the run’s own run_* events', () => {
    // A run cancelled before it started: two run events, not three.
    const cancelled = buildRunUsage({
      runId: 'wrun_1',
      status: 'cancelled',
      workflowName: WORKFLOW,
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 400 },
        { eventType: 'run_cancelled', events: 1, bytes: 50 },
      ],
      stepGroups: [],
      streamBytes: 0,
    });
    const { unmount } = render(
      <RunUsagePage runId="wrun_1" usage={cancelled} error={null} />
    );
    const runRow = () =>
      rows().find((row) => row.getAttribute('data-kind') === 'run');
    expect(runRow()?.textContent).toContain('2');
    expect(screen.getByTestId('run-usage-run-event-types').textContent).toBe(
      '1 created, 1 cancelled'
    );
    unmount();

    // A run still running: what it wrote so far.
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={buildRunUsage({
          runId: 'wrun_1',
          status: 'running',
          workflowName: WORKFLOW,
          eventGroups: [
            { eventType: 'run_created', events: 1, bytes: 400 },
            { eventType: 'run_started', events: 1, bytes: 50 },
          ],
          stepGroups: [stepGroup('a', 1)],
          streamBytes: 0,
        })}
        error={null}
      />
    );
    expect(screen.getByTestId('run-usage-run-event-types').textContent).toBe(
      '1 created, 1 started'
    );
  });

  it('keeps the removed content off the page', () => {
    const usage = bigRun({ status: 'running', inProgress: true });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    const text = document.body.textContent ?? '';
    // The summary and the line under it: the header shows them.
    expect(screen.queryByTestId('run-usage-summary')).toBeNull();
    expect(text).not.toMatch(/events · \d+ retr/);
    expect(text).not.toContain('can still grow');
    expect(text).not.toContain('On Vercel');
    // The section heading and the biggest-driver callout.
    expect(text).not.toContain('Where the events come from');
    expect(screen.queryByTestId('run-usage-driver')).toBeNull();
    expect(text).not.toContain('drives');
    // The "workflow" tag next to the workflow's name.
    expect(
      rows()[0].querySelector('[data-testid="run-usage-span-label"]')
        ?.textContent
    ).toBe('processOrder');
    expect(screen.queryByText('workflow', { exact: true })).toBeNull();
    // The "How events are counted" box: only a link to the docs is left.
    expect(document.querySelector('details')).toBeNull();
    expect(screen.queryByTestId('run-usage-counting')).toBeNull();
    expect(text).not.toContain('steps wrote');
    expect(
      screen
        .getByRole('link', { name: 'How events are counted' })
        .getAttribute('href')
    ).toBe(RUN_USAGE_DOCS_URL);
    // The Storage heading is the Data written table's own header now.
    expect(text).not.toContain('Storage');
  });

  it('puts the two tables side by side from lg, stacked below it', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const tables = screen.getByTestId('run-usage-tables');
    // jsdom has no layout: check the grid the breakpoints come from.
    const classes = tables.className.split(/\s+/);
    expect(classes).toContain('grid-cols-1');
    expect(classes.filter((c) => c.endsWith('grid-cols-1'))).toEqual([
      'grid-cols-1',
    ]);
    expect(
      classes.filter((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))
    ).toEqual(['lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]']);
    // Each column holds one table, the spans first.
    const columns = [...tables.children];
    expect(columns).toHaveLength(2);
    expect(
      columns[0].querySelector('[data-testid="run-usage-spans"]')
    ).not.toBeNull();
    expect(
      columns[1].querySelector('[data-testid="run-usage-data"]')
    ).not.toBeNull();
  });

  it('gives the skeleton the same two-column layout', () => {
    render(<RunUsagePageSkeleton />);
    const tables = screen.getByTestId('run-usage-tables');
    expect(tables.className).toBe(USAGE_TABLES_LAYOUT);
    expect(tables.children).toHaveLength(2);
  });

  it('has no divider above the footer', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const footer = screen.getByTestId('run-usage-footer').closest('footer');
    expect(footer).not.toBeNull();
    expect(footer?.className).not.toMatch(/\bborder/);
    expect(footer?.previousElementSibling?.className ?? '').not.toMatch(
      /\bborder-b\b/
    );
  });

  it('lists data written by entity with a total, and hides retention locally', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Data written (local)'
    );
    expect(
      screen.getAllByTestId('run-usage-entity').map((row) => row.textContent)
    ).toEqual(['Run890 B', 'Steps37.8 KB', 'Hooks200 B', 'Streams2.5 KB']);
    expect(screen.getByTestId('run-usage-total').textContent).toBe('41.4 KB');
    expect(screen.queryByTestId('run-usage-retained')).toBeNull();
  });

  it('shows Data retained when the backend has a retention period', () => {
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun({
          billed: true,
          dataRetained: { byteMonths: 41_400, retentionMonths: 1 },
        })}
        error={null}
      />
    );
    expect(screen.getByTestId('run-usage-retained').textContent).toContain(
      '41.4 KB-months'
    );
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Data written'
    );
    expect(screen.getByTestId('run-usage-footer').textContent).toBe(
      'Not your final bill.'
    );
  });

  it('says local runs are not billed, and leaves out pricing locally', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-footer').textContent).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory."
    );
    expect(screen.queryByRole('link', { name: 'Workflow pricing' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(WORKFLOW_PRICING_DOCS_URL);
    expect(
      screen.getByRole('link', { name: 'How events are counted' })
    ).toBeTruthy();
  });

  it('links pricing on the Vercel backend, and on a billed run', () => {
    const { unmount } = render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isVercelBackend
      />
    );
    expect(
      screen
        .getByRole('link', { name: 'Workflow pricing' })
        .getAttribute('href')
    ).toBe(WORKFLOW_PRICING_DOCS_URL);
    unmount();
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun({ billed: true })}
        error={null}
      />
    );
    expect(
      screen
        .getByRole('link', { name: 'Workflow pricing' })
        .getAttribute('href')
    ).toBe(WORKFLOW_PRICING_DOCS_URL);
  });

  it('puts the footer links inline, right after its sentence', () => {
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isVercelBackend
      />
    );
    const line = screen.getByTestId('run-usage-footer-line');
    // One paragraph: the sentence, then the links, in reading order.
    expect(line.tagName).toBe('P');
    expect(line.textContent).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory. How events are counted → Workflow pricing →"
    );
    const links = [...line.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual([
      'How events are counted →',
      'Workflow pricing →',
    ]);
    // Nothing pushes them to the far side.
    const footer = line.closest('footer');
    expect(footer?.className ?? '').not.toMatch(/justify-between|text-right/);
    expect(line.className).not.toMatch(/justify-between|text-right/);
    // Each link wraps as a whole; the arrow is not part of its name.
    for (const a of links) expect(a.className).toContain('whitespace-nowrap');
    expect(
      screen.getByRole('link', { name: 'How events are counted' })
    ).toBeTruthy();
  });

  it('keeps the last numbers with a note when a refresh fails', () => {
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun()}
        error={new Error('locked')}
      />
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Showing the last numbers read. Failed to refresh: locked'
    );
    expect(screen.getByTestId('run-usage-spans')).toBeTruthy();
  });

  it('shows a failed first read with “Try again”, busy while it reads', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <RunUsagePage
        runId="wrun_1"
        usage={undefined}
        error={new Error('locked')}
        onRetry={onRetry}
      />
    );
    expect(screen.getByTestId('run-usage-error').textContent).toContain(
      'Failed to read this run’s usage: locked'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <RunUsagePage
        runId="wrun_1"
        usage={undefined}
        error={new Error('locked')}
        onRetry={onRetry}
        retrying
      />
    );
    // The label stays; the button is busy and disabled.
    const busy = screen.getByRole('button', { name: 'Try again' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the skeleton until the first read answers', () => {
    render(<RunUsagePage runId="wrun_1" usage={undefined} error={null} />);
    expect(screen.getByTestId('run-usage-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('run-usage-spans')).toBeNull();
  });

  it('explains a World without usage and links back to the run', () => {
    render(<RunUsagePage runId="wrun_1" usage={null} error={null} />);
    expect(screen.getByTestId('run-usage-unsupported').textContent).toContain(
      'This World doesn’t count run usage.'
    );
    expect(
      screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')
    ).toBe('/run/wrun_1');
    expect(screen.queryByTestId('run-usage-skeleton')).toBeNull();
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
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    expect(screen.getByTestId('run-usage-purged-note').textContent).toBe(
      "This run's data was deleted when it finished; sizes show what it wrote."
    );
    expect(screen.getByTestId('run-usage-total').textContent).toBe('600 KB');
  });

  it('has no purge note for a run that kept its data', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.queryByTestId('run-usage-purged-note')).toBeNull();
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
    render(<RunUsagePage runId="wrun_1" usage={empty} error={null} />);
    expect(screen.getByText('This run has no events yet.')).toBeTruthy();
    expect(screen.getByTestId('run-usage-total').textContent).toBe('0 B');
  });
});

describe('runUsagePath', () => {
  it('escapes the run ID', () => {
    expect(runUsagePath('wrun_1')).toBe('/run/wrun_1/usage');
    expect(runUsagePath('a/b')).toBe('/run/a%2Fb/usage');
  });
});
