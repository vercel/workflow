import {
  cleanup,
  fireEvent,
  render as renderRaw,
  screen,
  within,
} from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import {
  buildRunUsage,
  formatLocalDataWrittenNote,
  type RunUsage,
  type RunUsageAggregates,
  USAGE_DOCS_URL,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dataWrittenLabel,
  RunUsageHeaderStats,
  RunUsagePage,
  RunUsagePageSkeleton,
  runUsagePath,
  STORAGE_DOCS_URL,
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
const step = (name: string, file = 'order') =>
  `step//./src/workflows/${file}//${name}`;

const stepGroup = (
  stepName: string,
  steps: number,
  { retries = 0, restarts }: { retries?: number; restarts?: number } = {}
) => {
  const r = restarts ?? retries;
  return {
    stepName,
    steps,
    events: steps * 3 + retries + r,
    created: steps,
    started: steps + r,
    completed: steps,
    failed: 0,
    retries,
    restarts: r,
    bytes: steps * 100,
  };
};

const runOf = (
  input: Partial<RunUsageAggregates> &
    Pick<RunUsageAggregates, 'eventGroups' | 'stepGroups'>
) =>
  buildRunUsage({
    runId: 'wrun_1',
    status: 'completed',
    workflowName: WORKFLOW,
    streamBytes: 0,
    ...input,
  });

/**
 * 1,145 events: nine step functions (one retried once), two hooks, an
 * attribute write, a sleep, and the run's own events.
 */
function bigRun(overrides: Partial<RunUsage> = {}): RunUsage {
  return {
    ...runOf({
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 400 },
        { eventType: 'run_started', events: 1, bytes: 100 },
        { eventType: 'run_completed', events: 1, bytes: 300 },
        { eventType: 'attr_set', events: 1, bytes: 50 },
        { eventType: 'wait_created', events: 1, bytes: 20 },
        { eventType: 'wait_completed', events: 1, bytes: 20 },
        { eventType: 'hook_created', events: 2, bytes: 120 },
        { eventType: 'hook_received', events: 1, bytes: 80 },
      ],
      hookGroups: [
        { hookId: 'hook_a', token: 'approval:order-1', events: 2 },
        { hookId: 'hook_b', token: 'refund:order-1', events: 1 },
      ],
      stepGroups: [
        stepGroup(step('chargeCard'), 300, { retries: 1 }),
        stepGroup(step('sendEmail'), 50),
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) =>
          stepGroup(step(n), 7 - i)
        ),
      ],
      streamBytes: 2500,
    }),
    ...overrides,
  };
}

const groups = () => screen.getAllByTestId('run-usage-group');
const typeLabels = () =>
  screen.getAllByTestId('run-usage-type-label').map((el) => el.textContent);
const childrenOf = (type: string) =>
  within(
    document.querySelector(
      `[data-testid="run-usage-children"][data-type="${type}"]`
    ) as HTMLElement
  );
const childLabels = (type: string) =>
  childrenOf(type)
    .queryAllByTestId('run-usage-child-label')
    .map((el) => el.textContent);

describe('RunUsageHeaderStats', () => {
  it("shows the whole run's events, without the retry count", () => {
    const usage = bigRun();
    expect(usage.retries.count).toBe(1);
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
    // Retries are on the step rows, not in the header.
    expect(document.body.textContent).not.toMatch(/retr/i);
    expect(document.body.textContent).not.toMatch(/billable/i);
  });

  it('links both figures to the run’s Usage page', () => {
    const usage = bigRun();
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={usage}
        error={null}
        isLocalBackend
      />
    );
    const events = screen.getByRole('link', {
      name: `${usage.events.toLocaleString('en-US')} events, open usage`,
    });
    const storage = screen.getByRole('link', {
      name: '41.4 KB storage (local), open usage',
    });
    expect(events.getAttribute('href')).toBe('/run/wrun_1/usage');
    expect(storage.getAttribute('href')).toBe('/run/wrun_1/usage');
    expect(storage.textContent).toBe('41.4 KB');
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
    // The figures aren't links to the page they're on; only the storage
    // help link (to the docs) is.
    expect(
      screen.queryAllByRole('link').map((a) => a.getAttribute('href'))
    ).toEqual([STORAGE_DOCS_URL]);
    expect(screen.getByTestId('run-usage-data-written').textContent).toBe(
      '41.4 KB'
    );
  });
  it('labels a local run’s figure “Storage (local)”', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isLocalBackend
      />
    );
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Storage (local)'
    );
    expect(document.body.textContent).not.toMatch(/data written/i);
  });

  it('labels a billed run’s figure plain “Storage”, with no local note', () => {
    render(
      <RunUsageHeaderStats
        runId="wrun_1"
        usage={bigRun({ billed: true })}
        error={null}
        isLocalBackend={false}
      />
    );
    expect(screen.getByTestId('run-usage-data-label').textContent).toBe(
      'Storage'
    );
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
      'Storage (local)'
    );
    expect(screen.queryByTestId('run-usage-events')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(dataWrittenLabel(undefined, false)).toBe('Storage');
  });

  it('says what storage counts in a tooltip, and links the docs section', async () => {
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
    const help = screen.getByRole('link', {
      name: 'How Storage (local) is counted (opens in a new tab)',
    });
    // The Usage page's storage section, in a new tab.
    expect(help.getAttribute('href')).toBe(STORAGE_DOCS_URL);
    expect(STORAGE_DOCS_URL).toBe(
      'https://workflow-sdk.dev/docs/observability/usage#storage'
    );
    expect(help.getAttribute('target')).toBe('_blank');
    fireEvent.focus(help);
    const tooltip = (await screen.findByRole('tooltip')).textContent ?? '';
    // The shared note, the same sentence the other surfaces read.
    expect(tooltip).toBe(formatLocalDataWrittenNote(bigRun()));
    expect(tooltip).toContain('QuickJS VM snapshots');
    expect(tooltip).toContain("dynamic workflow's code");
  });
});

describe('the usage table', () => {
  it('heads its first column “Type”, never “Span”', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const headers = within(screen.getByTestId('run-usage-types'))
      .getAllByRole('columnheader')
      .map((th) => th.textContent);
    expect(headers[0]).toBe('Type');
    expect(document.body.textContent).not.toMatch(/\bSpan\b/);
  });

  it('lists the types in the CLI’s order, flat, with no root row', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(typeLabels()).toEqual([
      'Steps',
      'Hooks',
      'Attributes',
      'Sleeps',
      'Run',
    ]);
    // No workflow row above them, and no "Built-in" group.
    const table = screen.getByTestId('run-usage-types');
    expect(table.textContent).not.toContain('processOrder');
    expect(table.textContent).not.toContain('Built-in');
    expect(screen.queryByTestId('run-usage-span')).toBeNull();
  });

  it('says what each type counts after its name', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const detail = (type: string) =>
      groups()
        .find((row) => row.getAttribute('data-type') === type)
        ?.querySelector('[data-testid="run-usage-group-detail"]')?.textContent;
    expect(detail('steps')).toBe('378 calls');
    expect(detail('hooks')).toBe('2 hooks');
    expect(detail('attributes')).toBe('1 write');
    expect(detail('sleeps')).toBe('1 sleep');
    // Run: the run's own events, by type.
    expect(detail('run')).toBe('1 created, 1 started, 1 completed');
    expect(document.body.textContent).not.toContain('×');
  });

  it('makes Steps and Hooks toggles, expanded by default', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const toggles = screen.getAllByTestId('run-usage-toggle');
    expect(toggles.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Steps'),
      expect.stringContaining('Hooks'),
    ]);
    for (const toggle of toggles) {
      // A native button: Enter and Space work without extra handlers.
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.getAttribute('type')).toBe('button');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const controlled = document.getElementById(
        toggle.getAttribute('aria-controls') ?? ''
      );
      expect(controlled?.getAttribute('data-testid')).toBe(
        'run-usage-children'
      );
      expect(controlled?.hidden).toBe(false);
    }
    // Attributes, Sleeps and Run don't expand.
    for (const row of groups().slice(2)) {
      expect(row.querySelector('button')).toBeNull();
    }
  });

  it('collapses and expands a group', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const steps = screen.getByRole('button', { name: /^Steps/ });
    const children = document.getElementById(
      steps.getAttribute('aria-controls') ?? ''
    ) as HTMLElement;
    fireEvent.click(steps);
    expect(steps.getAttribute('aria-expanded')).toBe('false');
    expect(children.hidden).toBe(true);
    // The other toggle keeps its own state.
    expect(
      screen
        .getByRole('button', { name: /^Hooks/ })
        .getAttribute('aria-expanded')
    ).toBe('true');
    fireEvent.click(steps);
    expect(steps.getAttribute('aria-expanded')).toBe('true');
    expect(children.hidden).toBe(false);
  });

  it('lists each step function with its calls and retries, biggest first', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(childLabels('steps')).toEqual([
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
    ]);
    const charge = childrenOf('steps').getAllByTestId('run-usage-child')[0];
    expect(within(charge).getByTestId('run-usage-calls').textContent).toBe(
      '300 calls'
    );
    expect(within(charge).getByTestId('run-usage-retries').textContent).toBe(
      '1 retry'
    );
    // Past the limit, the rest fold into one row that opens them.
    fireEvent.click(screen.getByRole('button', { name: '+ 4 other steps' }));
    expect(childLabels('steps')).toEqual([
      'chargeCard',
      'sendEmail',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(screen.queryByRole('button', { name: /other steps/ })).toBeNull();
  });

  it('lists each hook by its token, without calls', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(childLabels('hooks')).toEqual([
      'approval:order-1',
      'refund:order-1',
    ]);
    expect(childrenOf('hooks').queryByTestId('run-usage-calls')).toBeNull();
  });

  it('marks each type with the trace’s icon', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    for (const row of groups()) {
      expect(row.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keys step rows on the full name, and names the module when labels match', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A live run with two `send` steps in different files that swap places
    // between two reads.
    const read = (a: number, b: number) =>
      runOf({
        status: 'running',
        eventGroups: [{ eventType: 'run_created', events: 1, bytes: 1 }],
        stepGroups: [
          stepGroup(step('send', 'email'), a),
          stepGroup(step('send', 'sms'), b),
        ],
      });
    const first = read(3, 1);
    const { rerender } = render(
      <RunUsagePage runId="wrun_1" usage={first} error={null} />
    );
    const labels = childLabels('steps');
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('send');
    expect(labels[0]).toContain('email');
    expect(labels[1]).toContain('sms');
    const rowFor = (file: string) =>
      childrenOf('steps')
        .getAllByTestId('run-usage-child')
        .find((row) => row.textContent?.includes(file));
    const smsRow = rowFor('sms');
    // Keyed on usageRows()' key: the step's full name.
    expect(smsRow?.getAttribute('data-key')).toBe(step('send', 'sms'));

    // The sms step overtakes: the rows re-sort, each keeping its element.
    rerender(<RunUsagePage runId="wrun_1" usage={read(3, 5)} error={null} />);
    expect(childLabels('steps')[0]).toContain('sms');
    expect(rowFor('sms')).toBe(smsRow);
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes('same key'))
    ).toBe(false);
    errors.mockRestore();
  });

  it('keys hook rows on the hook id, so a reused token stays two rows', () => {
    const usage = runOf({
      eventGroups: [{ eventType: 'hook_created', events: 2, bytes: 1 }],
      hookGroups: [
        { hookId: 'hook_1', token: 'approval', events: 1 },
        { hookId: 'hook_2', token: 'approval', events: 1 },
      ],
      stepGroups: [],
    });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    expect(childLabels('hooks')).toHaveLength(2);
    expect(
      childrenOf('hooks')
        .getAllByTestId('run-usage-child')
        .map((row) => row.getAttribute('data-key'))
    ).toEqual(['hook_1', 'hook_2']);
  });

  it('shows a long hook token in full on hover, and lets it wrap at its separators', () => {
    const token = 'approval:order-1042/region.us-east_1';
    const usage = runOf({
      eventGroups: [{ eventType: 'hook_created', events: 1, bytes: 1 }],
      hookGroups: [{ hookId: 'hook_1', token, events: 1 }],
      stepGroups: [],
    });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    const label = childrenOf('hooks').getByTestId('run-usage-child-label');
    expect(label.getAttribute('title')).toBe(token);
    // Nothing is cut: the whole token is the text, split only by <wbr>.
    expect(label.textContent).toBe(token);
    // After each of : - / . - _
    expect(label.querySelectorAll('wbr')).toHaveLength(6);
  });

  it('keeps the removed content off the page', () => {
    const usage = bigRun({ status: 'running', inProgress: true });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    const text = document.body.textContent ?? '';
    expect(screen.queryByTestId('run-usage-summary')).toBeNull();
    expect(text).not.toMatch(/events · \d+ retr/);
    expect(text).not.toContain('can still grow');
    expect(text).not.toContain('On Vercel');
    expect(text).not.toContain('Where the events come from');
    expect(text).not.toContain('drives');
    expect(document.querySelector('details')).toBeNull();
    expect(text).not.toContain('steps wrote');
  });

  it('puts the two tables side by side from lg, stacked below it', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    const tables = screen.getByTestId('run-usage-tables');
    // jsdom has no layout: check the grid the breakpoints come from.
    const classes = tables.className.split(/\s+/);
    expect(classes).toContain('grid-cols-1');
    expect(
      classes.filter((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))
    ).toEqual(['lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]']);
    const columns = [...tables.children];
    expect(columns).toHaveLength(2);
    expect(
      columns[0].querySelector('[data-testid="run-usage-types"]')
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
});

describe('the storage table', () => {
  it('leaves out the entities that wrote nothing, like the CLI', () => {
    const usage = runOf({
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 400 }],
      stepGroups: [stepGroup(step('a'), 1)],
    });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    expect(
      screen.getAllByTestId('run-usage-entity').map((row) => row.textContent)
    ).toEqual(['Run400 B', 'Steps100 B']);
    expect(screen.getByTestId('run-usage-total').textContent).toBe('500 B');
  });

  it('heads it “Storage (local)” and lists it by entity with a total', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Storage (local)'
    );
    expect(
      screen.getAllByTestId('run-usage-entity').map((row) => row.textContent)
    ).toEqual(['Run890 B', 'Steps37.8 KB', 'Hooks200 B', 'Streams2.5 KB']);
    expect(screen.getByTestId('run-usage-total').textContent).toBe('41.4 KB');
    expect(screen.queryByTestId('run-usage-retained')).toBeNull();
  });

  it('heads it plain “Storage” on a billed run, with Data retained', () => {
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
    expect(screen.getByTestId('run-usage-data-heading').textContent).toBe(
      'Storage'
    );
    expect(screen.getByTestId('run-usage-retained').textContent).toContain(
      '41.4 KB-months'
    );
  });

  it('says when a run’s data was deleted and its sizes are what it wrote', () => {
    const usage = runOf({
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 40 }],
      stepGroups: [],
      dataPurged: true,
      savedDataWritten: { run: 300_000, step: 300_000, hook: 0, stream: 0 },
    });
    render(<RunUsagePage runId="wrun_1" usage={usage} error={null} />);
    expect(screen.getByTestId('run-usage-purged-note').textContent).toBe(
      "This run's data was deleted; sizes show what it wrote."
    );
    expect(screen.getByTestId('run-usage-total').textContent).toBe('600 KB');
  });

  it('has no purge note for a run that kept its data', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.queryByTestId('run-usage-purged-note')).toBeNull();
  });
});

describe('the footer', () => {
  it('says local runs are not billed, links how usage is counted, and no pricing', () => {
    render(<RunUsagePage runId="wrun_1" usage={bigRun()} error={null} />);
    expect(screen.getByTestId('run-usage-footer').textContent).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory."
    );
    const link = screen.getByRole('link', {
      name: 'How usage is counted (opens in a new tab)',
    });
    expect(link.getAttribute('href')).toBe(USAGE_DOCS_URL);
    expect(USAGE_DOCS_URL).toBe(
      'https://workflow-sdk.dev/docs/observability/usage'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    // The new tab is marked with the Docs button's icon, hidden from readers.
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // One docs link, and no pricing on a local run.
    const footer = screen.getByTestId('run-usage-footer-line');
    expect(footer.querySelectorAll('a')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /Workflow pricing/ })).toBeNull();
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
        .getByRole('link', { name: 'Workflow pricing (opens in a new tab)' })
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
      screen.getByRole('link', {
        name: 'Workflow pricing (opens in a new tab)',
      })
    ).toBeTruthy();
  });
  it('puts the link inline, right after its sentence, with no arrow', () => {
    render(
      <RunUsagePage
        runId="wrun_1"
        usage={bigRun()}
        error={null}
        isVercelBackend
      />
    );
    const line = screen.getByTestId('run-usage-footer-line');
    expect(line.tagName).toBe('P');
    expect(line.textContent).toBe(
      "Local runs aren't billed. Counted from this run's log in your local data directory. How usage is counted (opens in a new tab) Workflow pricing (opens in a new tab)"
    );
    expect(line.textContent).not.toContain('→');
    const footer = line.closest('footer');
    expect(footer?.className ?? '').not.toMatch(
      /justify-between|text-right|\bborder/
    );
    for (const a of line.querySelectorAll('a')) {
      expect(a.className).toContain('whitespace-nowrap');
    }
  });
});

describe('RunUsagePage states', () => {
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
    expect(screen.getByTestId('run-usage-types')).toBeTruthy();
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
    const busy = screen.getByRole('button', { name: 'Try again' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the skeleton until the first read answers', () => {
    render(<RunUsagePage runId="wrun_1" usage={undefined} error={null} />);
    expect(screen.getByTestId('run-usage-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('run-usage-types')).toBeNull();
  });

  it('explains a World without usage and links back to the run', () => {
    render(<RunUsagePage runId="wrun_1" usage={null} error={null} />);
    expect(screen.getByTestId('run-usage-unsupported').textContent).toContain(
      'This World doesn’t count run usage.'
    );
    expect(
      screen.getByRole('link', { name: 'Back to run' }).getAttribute('href')
    ).toBe('/run/wrun_1');
  });

  it('renders a run with no events', () => {
    const empty = runOf({ status: 'pending', eventGroups: [], stepGroups: [] });
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
