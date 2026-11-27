import {
  buildRunUsage,
  formatUsageFooter,
  type RunUsage,
  type RunUsageAggregates,
  USAGE_DOCS_URL,
  WORKFLOW_PRICING_DOCS_URL,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import {
  escapeControlChars,
  formatRunUsageText,
  usageTextColor,
} from './usage.js';

const step = (name: string, steps: number, retries = 0) => ({
  stepName: `step//./src/workflows/order//${name}`,
  steps,
  events: steps * 3 + retries * 2,
  created: steps,
  started: steps + retries,
  completed: steps,
  failed: 0,
  retries,
  restarts: retries,
  bytes: steps * 100,
});

const usageOf = (overrides: Partial<RunUsageAggregates> = {}): RunUsage =>
  buildRunUsage({
    runId: 'wrun_01K5WAJZ8W367CV2RFKDSDNWB8',
    status: 'completed',
    workflowName: 'workflow//./src/workflows/order//processOrder',
    eventGroups: [
      { eventType: 'run_created', events: 1, bytes: 300 },
      { eventType: 'run_started', events: 1, bytes: 50 },
      { eventType: 'run_completed', events: 1, bytes: 80 },
      { eventType: 'wait_created', events: 1, bytes: 40 },
      { eventType: 'wait_completed', events: 1, bytes: 40 },
    ],
    stepGroups: [step('chargeCard', 2, 1), step('sendEmail', 4)],
    streamBytes: 0,
    calls: { wait: 1 },
    ...overrides,
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\u001b\[/;

describe('formatRunUsageText', () => {
  it('draws the summary, the usage table, the docs link and storage', () => {
    expect(formatRunUsageText(usageOf())).toMatchInlineSnapshot(`
      "processOrder  wrun_01K5WAJZ8W367CV2RFKDSDNWB8  ● completed

      Events           25
      Storage (local)  1.11 KB

      TYPE    NAME                               EVENTS  SHARE
      Steps   6 calls  ↻ 1 retry                     20    80%  ████████░░
              ├─ sendEmail  4 calls                  12    48%  █████░░░░░
              └─ chargeCard  2 calls  ↻ 1 retry       8    32%  ███░░░░░░░
      Sleeps  1 sleep                                 2     8%  █░░░░░░░░░
      Run                                             3    12%  █░░░░░░░░░
      TOTAL                                          25   100%

      How usage is counted: https://workflow-sdk.dev/docs/observability/usage

      STORAGE (LOCAL)     SIZE
      Run                510 B
      Steps              600 B
      TOTAL            1.11 KB

      Local runs aren't billed. Counted from this run's log in your local data directory.
      Machine-readable: --json"
    `);
  });

  it('prints the shared footer and points to how events are counted', () => {
    const usage = usageOf();
    const text = formatRunUsageText(usage);
    expect(text).toContain(formatUsageFooter(usage));
    expect(text).toContain(`How usage is counted: ${USAGE_DOCS_URL}`);
    // The counting explanation is in the docs, not printed.
    expect(text).not.toMatch(/steps? wrote|retr(y|ies) added|A retry adds/);
  });

  it('prints the events without retries, and the retries on step rows', () => {
    const text = formatRunUsageText(usageOf());
    expect(text).toMatch(/^Events +25$/m);
    expect(text).toMatch(/^Steps .*↻ 1 retry/m);
    expect(text).toMatch(/└─ chargeCard {2}2 calls {2}↻ 1 retry/);
  });

  it('lists the types in order, with no workflow row or built-in group', () => {
    const usage = usageOf({
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 1 },
        { eventType: 'run_started', events: 1, bytes: 1 },
        { eventType: 'run_completed', events: 1, bytes: 1 },
        { eventType: 'wait_created', events: 1, bytes: 1 },
        { eventType: 'wait_completed', events: 1, bytes: 1 },
        { eventType: 'attr_set', events: 2, bytes: 1 },
        { eventType: 'hook_created', events: 2, bytes: 1 },
        { eventType: 'hook_received', events: 3, bytes: 1 },
      ],
      hookGroups: [
        { hookId: 'hook_1', token: 'approve:ord_1', events: 3 },
        { hookId: 'hook_2', token: 'cancel:ord_1', events: 2 },
      ],
    });
    const text = formatRunUsageText(usage);
    // The usage table: from its header to its total.
    const table = text.slice(text.indexOf('TYPE'), text.indexOf('TOTAL'));
    const types = table
      .split('\n')
      .map((line) => line.match(/^(Steps|Hooks|Attributes|Sleeps|Run) /)?.[1])
      .filter(Boolean);
    expect(types).toEqual(['Steps', 'Hooks', 'Attributes', 'Sleeps', 'Run']);
    expect(text).toMatch(/^TYPE +NAME +EVENTS +SHARE$/m);
    expect(text).toMatch(/^Hooks +2 hooks +5 /m);
    expect(text).toMatch(/├─ approve:ord_1 +3 /);
    expect(text).toMatch(/└─ cancel:ord_1 +2 /);
    expect(text).toMatch(/^Attributes +2 writes +2 /m);
    expect(text).toMatch(/^Sleeps +1 sleep +2 /m);
    expect(text).not.toMatch(/processOrder {2}workflow|Built-in|Span|×\d/);
  });

  it('calls a billed run’s events billable', () => {
    const text = formatRunUsageText(usageOf({ billed: true }));
    expect(text).not.toContain('On Vercel');
    expect(text).not.toContain('(local)');
    expect(text).toContain('Not your final bill.');
    expect(text).toContain('STORAGE  ');
    expect(text).toMatch(/^Storage {2}/m);
  });

  it('folds the steps past five into one row and ends the tree there', () => {
    const many = usageOf({
      eventGroups: [{ eventType: 'run_created', events: 1, bytes: 1 }],
      stepGroups: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) =>
        step(n, 7 - i)
      ),
    });
    const tree = formatRunUsageText(many)
      .split('\n')
      .filter((line) => /(├─|└─)/.test(line));
    expect(tree.map((line) => line.trim().split('  ')[0])).toEqual([
      '├─ a',
      '├─ b',
      '├─ c',
      '├─ d',
      '├─ e',
      '└─ + 2 other steps',
    ]);
  });

  it('tells apart steps of the same name in different files', () => {
    const usage = usageOf({
      stepGroups: [
        { ...step('send', 3), stepName: 'step//./src/a//send' },
        { ...step('send', 2), stepName: 'step//./src/b//send' },
      ],
    });
    const rows = formatRunUsageText(usage)
      .split('\n')
      .filter((line) => /(├─|└─)/.test(line))
      .map((line) => line.trim().split('  ')[0]);
    expect(rows).toEqual(['├─ send (./src/a)', '└─ send (./src/b)']);
  });

  it('labels a local run’s storage "Storage (local)", not "Data written"', () => {
    const text = formatRunUsageText(usageOf());
    expect(text).toMatch(/^Storage \(local\) {2}1\.11 KB$/m);
    expect(text).toMatch(/^STORAGE \(LOCAL\) +SIZE$/m);
    expect(text).not.toMatch(/data written/i);
  });

  it('says nothing of what a run would count as on Vercel', () => {
    for (const billed of [false, true]) {
      const text = formatRunUsageText(usageOf({ billed }));
      expect(text).not.toContain('On Vercel');
      expect(text).not.toMatch(/would count as/);
    }
    expect(formatRunUsageText(usageOf())).not.toMatch(/billable/);
  });

  it('links pricing only when asked to (a run on Vercel)', () => {
    const pricing = `See pricing: ${WORKFLOW_PRICING_DOCS_URL}`;
    expect(formatRunUsageText(usageOf())).not.toContain(pricing);
    expect(formatRunUsageText(usageOf(), { pricing: true })).toContain(pricing);
  });

  it('prints a billed run from analytics with pricing and when it was counted', () => {
    const asOf = '2026-11-20T17:10:00.000Z';
    const text = formatRunUsageText(usageOf({ billed: true, asOf }), {
      pricing: true,
    });
    expect(text).toContain(`See pricing: ${WORKFLOW_PRICING_DOCS_URL}`);
    expect(text).toContain(
      `Counted as of ${asOf}. Analytics can lag, so the newest events may be missing.`
    );
    // What the backend's storage includes is the backend's to say: no
    // note about it is printed for a billed run.
    expect(text).not.toContain('QuickJS');
    // The as-of line sits with the run, above the numbers it qualifies.
    const lines = text.split('\n');
    expect(
      lines.findIndex((line) => line.startsWith('Counted as of'))
    ).toBeLessThan(lines.findIndex((line) => line.startsWith('Events')));
  });

  it('prints a local run exactly as before: no as-of line and no storage note', () => {
    const text = formatRunUsageText(usageOf());
    expect(text).not.toContain('Counted as of');
    expect(text).not.toContain('QuickJS');
  });

  it('says a running billed run can still grow and may be missing its newest events', () => {
    const text = formatRunUsageText(
      usageOf({
        billed: true,
        status: 'running',
        asOf: '2026-11-20T17:10:00.000Z',
      })
    );
    const lines = text.split('\n');
    expect(lines[1]).toBe(
      'This run has not finished; its usage can still grow.'
    );
    expect(lines[2]).toMatch(/^Counted as of 2026-11-20T17:10:00\.000Z\./);
  });

  it('escapes control characters in an as-of time from the backend', () => {
    const text = formatRunUsageText(
      usageOf({ billed: true, asOf: 'now\u001b[2J' })
    );
    expect(text).not.toMatch(ANSI);
    expect(text).toContain('now\\x1b[2J');
  });

  it('escapes control characters in names from the run, and keeps the table lined up', () => {
    // A token that would clear the screen and break the table, a workflow
    // name that would retitle the terminal, and a step name with a tab and
    // the one-character escape (CSI, U+009B).
    const token = 'evil\u001b[2J\ntoken';
    const usage = usageOf({
      workflowName:
        'workflow//./src/workflows/order//order\u001b]0;pwned\u0007',
      eventGroups: [
        { eventType: 'run_created', events: 1, bytes: 1 },
        { eventType: 'hook_created', events: 2, bytes: 1 },
      ],
      hookGroups: [{ hookId: 'hook_1', token, events: 2 }],
      stepGroups: [
        step('chargeCard', 2, 1),
        { ...step('x', 1), stepName: 'step//./src/a//send\tnow\u009b31m' },
      ],
    });
    const text = formatRunUsageText(usage);
    // Shown, not dropped, in a form you can read.
    expect(text).toContain('evil\\x1b[2J\\ntoken');
    expect(text).toContain('order\\x1b]0;pwned\\x07');
    expect(text).toContain('send\\tnow\\x9b31m');
    // No control character reaches the terminal: only the line breaks.
    for (const line of text.split('\n')) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: what must not be printed
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    // Every row's Events column ends where the header's does.
    const lines = text.split('\n');
    const header = lines.findIndex((line) => line.startsWith('TYPE'));
    const eventsEnd = lines[header].indexOf('EVENTS') + 'EVENTS'.length;
    const rows = lines.slice(
      header + 1,
      lines.findIndex((l) => l.startsWith('TOTAL')) + 1
    );
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(row.slice(0, eventsEnd), row).toMatch(/\d$/);
      expect(row.charAt(eventsEnd), row).toBe(' ');
    }
    expect(rows.some((row) => row.includes('evil\\x1b[2J\\ntoken'))).toBe(true);
  });

  it('writes each control character as an escape, and leaves other text alone', () => {
    expect(escapeControlChars('a\u0000b\u001bc\u007fd\u009fe')).toBe(
      'a\\x00b\\x1bc\\x7fd\\x9fe'
    );
    expect(escapeControlChars('line\r\nnext\ttab')).toBe(
      'line\\r\\nnext\\ttab'
    );
    // Printable text, Unicode and backslashes are as they were.
    expect(escapeControlChars('approval:order-1042 ✓ é \\x1b')).toBe(
      'approval:order-1042 ✓ é \\x1b'
    );
  });

  it('escapes names in colored output too, and keeps only its own colors', () => {
    const usage = usageOf({
      hookGroups: [{ hookId: 'hook_1', token: 'a\u001b[2Jb', events: 1 }],
      eventGroups: [{ eventType: 'hook_created', events: 1, bytes: 1 }],
    });
    const text = formatRunUsageText(usage, { color: true });
    expect(text).toContain('a\\x1b[2Jb');
    expect(text).not.toContain('\u001b[2J');
  });

  it('is plain text unless asked for color', () => {
    expect(formatRunUsageText(usageOf())).not.toMatch(ANSI);
    expect(formatRunUsageText(usageOf(), { color: true })).toMatch(ANSI);
  });
});

describe('usageTextColor', () => {
  it('colors a terminal only', () => {
    expect(usageTextColor({ isTTY: true }, {})).toBe(true);
    expect(usageTextColor({ isTTY: false }, {})).toBe(false);
    expect(usageTextColor({}, {})).toBe(false);
  });

  it('honors NO_COLOR and TERM=dumb', () => {
    expect(usageTextColor({ isTTY: true }, { NO_COLOR: '' })).toBe(false);
    expect(usageTextColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(usageTextColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(usageTextColor({ isTTY: true }, { TERM: 'xterm-256color' })).toBe(
      true
    );
  });
});
