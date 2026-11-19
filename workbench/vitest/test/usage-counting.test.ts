// The table `workflow inspect run <id> --usage` prints, built from the
// `@workflow/world` formatters, checked against a real run's log.
import { formatRunUsageText } from '@workflow/cli/dist/lib/inspect/usage.js';
import { waitForHook } from '@workflow/vitest';
import {
  type Event,
  type RunUsage,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  USAGE_COUNTING_DOCS_URL,
  usageEntityOfEventType,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { resumeHook, start } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import {
  usageCountingWorkflow,
  usageEverythingWorkflow,
} from '../workflows/usage-counting.js';

/** Every event of the run, read page by page. */
async function listAllEvents(runId: string): Promise<Event[]> {
  const world = await getWorld();
  const all: Event[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      runId,
      pagination: { limit: 100, cursor },
      resolveData: 'none',
    });
    all.push(...page.data);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

/**
 * The run's payload bytes as the World gives them back: every `Uint8Array`
 * in its events' data (read with `resolveData: 'all'`), by the entity Data
 * Written reports it under, and every chunk of its streams.
 */
async function payloadBytesReadBack(runId: string) {
  const world = await getWorld();
  const byEntity = { run: 0, step: 0, hook: 0, stream: 0 };
  const walk = (value: unknown): number => {
    if (value instanceof Uint8Array) return value.byteLength;
    if (value === null || typeof value !== 'object') return 0;
    return Object.values(value).reduce<number>((n, v) => n + walk(v), 0);
  };
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      runId,
      pagination: { limit: 100, cursor },
      resolveData: 'all',
    });
    for (const event of page.data) {
      const entity = usageEntityOfEventType(event.eventType);
      if (entity) {
        byEntity[entity] += walk((event as { eventData?: unknown }).eventData);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  for (const name of await world.streams.list(runId)) {
    let chunks: string | undefined;
    do {
      const page = await world.streams.getChunks(runId, name, {
        cursor: chunks,
      });
      for (const chunk of page.data) byEntity.stream += chunk.data.byteLength;
      chunks = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (chunks);
  }
  return byEntity;
}

const countOf = (events: Event[], eventType: string) =>
  events.filter((event) => event.eventType === eventType).length;

const toNumber = (text: string) => Number(text.replaceAll(',', ''));

interface PrintedRow {
  /** The Type column: `Steps`, `Hooks`, ...; empty on a child row. */
  type: string;
  /** The Name column, without the tree characters of a child row. */
  name: string;
  events: number;
}

/**
 * The usage table as a user reads it: each row's Type, Name and Events,
 * cut at the columns the header line sets (Type and Name are padded to the
 * longest, Events is right-aligned under its header).
 */
function printedRows(text: string): PrintedRow[] {
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^TYPE +NAME +EVENTS/.test(line));
  expect(header, 'the table header').toBeGreaterThanOrEqual(0);
  const nameAt = lines[header].indexOf('NAME');
  const eventsEnd = lines[header].indexOf('EVENTS') + 'EVENTS'.length;
  const rows: PrintedRow[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith('TOTAL')) break;
    const [, name, events] =
      line.slice(nameAt, eventsEnd).match(/^(.*?)\s+([\d,]+)$/) ?? [];
    if (events === undefined) throw new Error(`Unreadable row: ${line}`);
    rows.push({
      type: line.slice(0, nameAt).trim(),
      name: name.replace(/^[├└]─ /, '').trim(),
      events: toNumber(events),
    });
  }
  return rows;
}

/** A group row and the child rows under it. */
function groupOf(rows: PrintedRow[], type: string) {
  const at = rows.findIndex((row) => row.type === type);
  if (at < 0) return undefined;
  const end = rows.findIndex((row, i) => i > at && row.type !== '');
  return {
    row: rows[at],
    children: rows.slice(at + 1, end < 0 ? undefined : end),
  };
}

/** What every run's printed usage must say, checked against its log. */
function checkPrinted(text: string, events: Event[]) {
  const rows = printedRows(text);
  const stepLog = events.filter((event) => event.eventType.startsWith('step_'));
  const ofPrefix = (prefix: string) =>
    events.filter((event) => event.eventType.startsWith(prefix)).length;

  // Each type's events are the log's, and they add up to the run's.
  const steps = groupOf(rows, 'Steps');
  expect(steps?.row.events).toBe(stepLog.length);
  expect(groupOf(rows, 'Run')?.row.events).toBe(ofPrefix('run_'));
  const groups = rows.filter((row) => row.type !== '');
  expect(groups.reduce((sum, row) => sum + row.events, 0)).toBe(events.length);
  expect(text).toMatch(
    new RegExp(`^TOTAL +${events.length.toLocaleString('en-US')} +100%`, 'm')
  );

  // Each step function's events are its steps' in the log.
  const stepNames = new Map<string, string>();
  for (const event of stepLog) {
    const name = (event as { eventData?: { stepName?: string } }).eventData
      ?.stepName;
    if (name && event.correlationId) stepNames.set(event.correlationId, name);
  }
  for (const child of steps?.children ?? []) {
    const fn = child.name.split('  ')[0];
    const ids = [...stepNames]
      .filter(([, name]) => name.endsWith(`//${fn}`))
      .map(([id]) => id);
    const logged = stepLog.filter((event) =>
      ids.includes(event.correlationId ?? '')
    ).length;
    expect(child.events, fn).toBe(logged);
    // "N calls", never "×N".
    expect(child.name).toMatch(
      new RegExp(`^${fn} {2}${ids.length} calls?( |$)`)
    );
  }

  // No counting explanation: a pointer to the docs instead.
  expect(text).toContain(`How events are counted: ${USAGE_COUNTING_DOCS_URL}`);
  expect(text).not.toMatch(/steps? wrote|retr(y|ies) added|×\d/);
  expect(text).not.toMatch(/On Vercel|would count as|See pricing/);
  // The summary's events have no retries; the retries are on step rows.
  expect(text).toMatch(
    new RegExp(`^Events +${events.length.toLocaleString('en-US')}$`, 'm')
  );
  return rows;
}

async function runAndCheck(options?: { specVersion: number }) {
  const run = await start(usageCountingWorkflow, ['ord_1'], options);
  await expect(run.returnValue).resolves.toEqual({
    charged: 'charged ord_1',
    sent: 6,
  });

  const world = await getWorld();
  const usage: RunUsage = await world.experimental_usage!.getRun(run.runId);
  const events = await listAllEvents(run.runId);
  const stepLog = events.filter((event) => event.eventType.startsWith('step_'));
  const steps = new Set(stepLog.map((event) => event.correlationId)).size;
  const retries = countOf(events, 'step_retrying');
  const { specVersion } = await world.runs.get(run.runId);
  if (options) expect(specVersion).toBe(options.specVersion);
  expect(steps).toBe(7);
  expect(retries).toBe(2);

  // What the user reads first: the table's numbers are the log's.
  const text = formatRunUsageText(usage);
  console.log(`spec ${specVersion}: ${events.length} events\n${text}`);
  const rows = checkPrinted(text, events);
  expect(groupOf(rows, 'Steps')?.row.name).toBe('7 calls  ↻ 2 retries');
  expect(groupOf(rows, 'Steps')?.children.map((row) => row.name)).toEqual([
    expect.stringMatching(/^sendEmail {2}6 calls$/),
    expect.stringMatching(/^flakyCharge {2}1 call {2}↻ 2 retries$/),
  ]);

  // Data Written is the payload bytes the World gives back.
  expect(usage.dataWritten.byEntity).toEqual(
    await payloadBytesReadBack(run.runId)
  );

  // Usage counts the log it pages through, event for event.
  expect(usage.events).toBe(events.length);
  expect(usage.billableEvents).toBe(events.length);
  // Both retries started their step again: a marker and a start each.
  expect(usage.retries).toEqual({ count: 2, events: 4 });
  expect(usage.stepEvents).toEqual({
    steps,
    events: stepLog.length,
    byType: {
      created: countOf(events, 'step_created'),
      started: countOf(events, 'step_started'),
      completed: countOf(events, 'step_completed'),
      failed: countOf(events, 'step_failed'),
      retrying: retries,
      other: 0,
    },
  });
  return {
    specVersion: specVersion ?? 0,
    created: countOf(events, 'step_created'),
    steps,
  };
}

describe('run usage from a real run', () => {
  // A step retried twice, and a fan-out wider than the inline limit, so
  // some calls run inline and the rest are queued.
  it('counts the step events a run at the default spec wrote', async () => {
    const { specVersion, created, steps } = await runAndCheck();
    if (specVersion < SPEC_VERSION_SINGLE_ORCHESTRATOR) {
      // Spec 8 writes a step_created for every step, inline ones included.
      expect(created).toBe(steps);
    }
  }, 60_000);

  // Forced in-process, so CI covers spec 9 without WORKFLOW_SPEC_VERSION.
  it('counts the step events a spec 9 run wrote', async () => {
    const { created, steps } = await runAndCheck({
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    // An inline step is created by its first step_started.
    expect(created).toBeLessThan(steps);
  }, 60_000);

  it('lists every type of row, each hook by its token', async () => {
    const orderId = `ord_${Math.random().toString(36).slice(2)}`;
    const token = `usage-approve:${orderId}`;
    const run = await start(usageEverythingWorkflow, [orderId]);
    await waitForHook(run, { token });
    await resumeHook(token, { ok: true });
    await expect(run.returnValue).resolves.toEqual({
      charged: `charged ${orderId}`,
      ok: true,
    });

    const world = await getWorld();
    const usage = await world.experimental_usage!.getRun(run.runId);
    const events = await listAllEvents(run.runId);
    const text = formatRunUsageText(usage);
    console.log(`${events.length} events\n${text}`);
    const rows = checkPrinted(text, events);

    expect(rows.filter((row) => row.type).map((row) => row.type)).toEqual([
      'Steps',
      'Hooks',
      'Attributes',
      'Sleeps',
      'Run',
    ]);
    const hookEvents = events.filter((e) => e.eventType.startsWith('hook_'));
    const hooks = groupOf(rows, 'Hooks');
    expect(hooks?.row).toMatchObject({
      name: '1 hook',
      events: hookEvents.length,
    });
    expect(hooks?.children).toEqual([
      { type: '', name: token, events: hookEvents.length },
    ]);
    expect(groupOf(rows, 'Attributes')?.row).toMatchObject({
      name: '1 write',
      events: countOf(events, 'attr_set'),
    });
    expect(groupOf(rows, 'Sleeps')?.row).toMatchObject({
      name: '1 sleep',
      events: events.filter((e) => e.eventType.startsWith('wait_')).length,
    });
    // Data Written is the payload bytes the World gives back, the stream's
    // chunks included.
    const readBack = await payloadBytesReadBack(run.runId);
    console.log(`payload bytes read back: ${JSON.stringify(readBack)}`);
    expect(usage.dataWritten.byEntity).toEqual(readBack);
    expect(readBack.stream).toBeGreaterThan(0);
    expect(readBack.hook).toBeGreaterThan(0);
  }, 60_000);
});
