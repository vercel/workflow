import {
  buildRunUsage,
  formatEventCountingLines,
  formatEventCountingNote,
  formatUsageFooter,
  type RunUsage,
  type RunUsageAggregates,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { formatRunUsageText, usageTextColor } from './usage.js';

const step = (name: string, steps: number, retries = 0) => ({
  stepName: `step//./src/workflows/order//${name}`,
  steps,
  events: steps * 3 + retries * 2,
  created: steps,
  started: steps + retries,
  completed: steps,
  failed: 0,
  retries,
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
    calls: { hook: 0, wait: 1 },
    ...overrides,
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\u001b\[/;

describe('formatRunUsageText', () => {
  it('draws the summary, the span tree, the counting note and data written', () => {
    expect(formatRunUsageText(usageOf())).toMatchInlineSnapshot(`
      "processOrder  wrun_01K5WAJZ8W367CV2RFKDSDNWB8  ● completed

      Events        25  (1 retry)
      Data written  1.11 KB (local)
      On Vercel     25 billable events

      NAME                          EVENTS  SHARE
      processOrder  workflow            25
      ├─ sendEmail  ×4                  12    48%  █████░░░░░
      ├─ chargeCard  ×2  ↻ 1 retry       8    32%  ███░░░░░░░
      ├─ Run start & finish              3    12%
      └─ Sleeps  ×1                      2     8%
      TOTAL                             25   100%

      6 steps wrote 20 events: 6 created, 7 started, 6 completed, 1 retry marker.
      Each retry adds 2: a retry marker, and the step starting again.

      DATA WRITTEN (LOCAL)     SIZE
      Run                     510 B
      Steps                   600 B
      TOTAL                 1.11 KB

      Local runs aren't billed. Counted from this run's log in your local data directory.
      See pricing: https://vercel.com/docs/workflows/pricing
      Open the Usage tab: npx workflow web · Machine-readable: --json"
    `);
  });

  it('says the same as the web UI: its footer and counting lines', () => {
    const usage = usageOf();
    const text = formatRunUsageText(usage);
    expect(text).toContain(formatUsageFooter(usage));
    for (const line of formatEventCountingNote(usage)) {
      expect(text).toContain(line);
      // Each one is a line of the web UI's "How events are counted".
      expect(formatEventCountingLines(usage)).toContain(line);
    }
  });

  it('calls a billed run’s events billable, with no "On Vercel" line', () => {
    const text = formatRunUsageText(usageOf({ billed: true }));
    expect(text).not.toContain('On Vercel');
    expect(text).not.toContain('(local)');
    expect(text).toContain('Not your final bill.');
    expect(text).toContain('DATA WRITTEN  ');
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
      .filter((line) => /^(├─|└─)/.test(line));
    expect(tree.map((line) => line.split('  ')[0])).toEqual([
      '├─ a',
      '├─ b',
      '├─ c',
      '├─ d',
      '├─ e',
      '├─ + 2 more steps',
      '└─ Run start & finish',
    ]);
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
