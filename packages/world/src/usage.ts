import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import { isSealedNoopEvent } from './event-metadata.js';
import type { WorkflowRunStatus } from './runs.js';
import { isTerminalWorkflowRunStatus } from './runs.js';

/**
 * Per-run usage: the shape the observability UI's Usage tab and
 * `workflow inspect run <id> --usage` both read, so the two always show the
 * same numbers.
 *
 * Field names follow the billed resources on the pricing page
 * ({@link WORKFLOW_PRICING_DOCS_URL}): Workflow Events, Workflow Data Written
 * and Workflow Data Retained, so a future backend API can return this shape
 * unchanged.
 *
 * Only world-local computes it today (`world.experimental_usage`), from
 * aggregate queries over its database.
 *
 * TODO(https://github.com/vercel/workflow/issues/5445): the production data
 * path. World-vercel needs this shape from an analytics API or a
 * precomputed per-run rollup, not from reading the run's log.
 *
 * Pure (no Node.js imports): the web UI bundles it for the browser.
 */

export const WORKFLOW_PRICING_DOCS_URL =
  'https://vercel.com/docs/workflows/pricing';

/**
 * Each retry writes `step_retrying` and runs the step again (`step_started`).
 * True on every spec: what differs between specs is a step's *creation*,
 * which {@link RunUsage.stepEvents} reports as the run wrote it.
 */
export const EVENTS_PER_RETRY = 2;

/** How many spans the summaries list before collapsing the rest. */
export const USAGE_SPANS_SHOWN = 5;

/** What a span's events belong to. Sleeps are `wait`. */
export type RunUsageSpanKind = 'run' | 'step' | 'hook' | 'wait';

/** The entities `dataWritten` is broken down by. */
export type RunUsageEntity = 'run' | 'step' | 'hook' | 'stream';

export const RUN_USAGE_ENTITIES: readonly RunUsageEntity[] = [
  'run',
  'step',
  'hook',
  'stream',
];

export interface RunUsageSpan {
  kind: RunUsageSpanKind;
  /**
   * What the events are grouped by: the full step name for a step (every
   * call of one step function is one span), the workflow name for the run's
   * own events, `hook` for hooks and `sleep` for sleeps.
   */
  name: string;
  events: number;
  /** `events / RunUsage.events`, from 0 to 1. */
  share: number;
  /** `step_retrying` events in this span. */
  retries: number;
  /**
   * How many times the span ran: a step span's steps (calls of the step
   * function), a sleep or hook span's sleeps or hooks, 1 for the run.
   */
  calls: number;
}

export interface RunUsage {
  runId: string;
  status: WorkflowRunStatus;
  workflowName: string;
  /**
   * Whether the backend bills this run. `false` on the Local World: its
   * events and data are counted the way they would be billed, and the UI and
   * CLI say what the run would count as on Vercel rather than call them
   * billable.
   */
  billed: boolean;
  /** The run has not finished, so these numbers can still grow. */
  inProgress: boolean;
  /**
   * Workflow Events: every event in the run's whole log. Placeholders
   * (sealed-log `noop` rows) are not events and are not counted.
   */
  events: number;
  /** The events that are billed. Today every event is. */
  billableEvents: number;
  retries: {
    /** `step_retrying` events. */
    count: number;
    /** Events the retries added: {@link EVENTS_PER_RETRY} each. */
    events: number;
  };
  /**
   * The run's step events by type, as its log holds them. How many events a
   * step writes depends on how it ran: a step dispatched to the queue writes
   * `step_created`, `step_started` and `step_completed`; on spec 9 a step
   * the orchestrator runs inline has no `step_created` (its first
   * `step_started` creates it), so it writes two. One run can mix both.
   */
  stepEvents: RunUsageStepEvents;
  /** Sorted by events, most first. */
  eventsBySpan: RunUsageSpan[];
  /** Workflow Data Written, in bytes. */
  dataWritten: {
    bytes: number;
    byEntity: Record<RunUsageEntity, number>;
    /**
     * Where the sizes come from: the run's rows as they are (`log`); for a
     * run whose data was deleted when it finished, the sizes saved before
     * the deletion plus anything written after (`saved-at-purge`), or, when
     * none were saved (a run purged before the sizes were kept), what is
     * left of it (`left-after-purge`).
     */
    source: RunUsageDataWrittenSource;
  };
  /**
   * The run's data was deleted when it finished (`experimental_retention:
   * 0`). Its event counts are unaffected; see `dataWritten.source` for
   * whether its sizes are what it wrote.
   */
  dataPurged: boolean;
  /**
   * Workflow Data Retained: data written times the retention period.
   * `null` where there is no plan retention to multiply by (world-local).
   */
  dataRetained: {
    /** Byte-months, `dataWritten.bytes × retentionMonths`. */
    byteMonths: number;
    retentionMonths: number;
  } | null;
}

export type RunUsageDataWrittenSource =
  | 'log'
  | 'saved-at-purge'
  | 'left-after-purge';

/** The step event types {@link RunUsageStepEvents} counts. */
export type RunUsageStepEventType =
  | 'created'
  | 'started'
  | 'completed'
  | 'failed'
  | 'retrying';

export const RUN_USAGE_STEP_EVENT_TYPES: readonly RunUsageStepEventType[] = [
  'created',
  'started',
  'completed',
  'failed',
  'retrying',
];

export interface RunUsageStepEvents {
  /** Steps in the log (one per step id; one call of a step function). */
  steps: number;
  /** All their events; the step spans' events add up to it. */
  events: number;
  /**
   * `step_created`, `step_started`, ... counts. `other` holds step event
   * types this build does not know, so the counts always add up to `events`.
   */
  byType: Record<RunUsageStepEventType | 'other', number>;
}

/**
 * One aggregate row: the events of one type in a run's log, with their
 * stored size. Step events go in {@link RunUsageStepGroup} instead.
 */
export interface RunUsageEventGroup {
  eventType: string;
  events: number;
  bytes: number;
}

/** The events of every step with one name, with their stored size. */
export interface RunUsageStepGroup {
  /** `null` when the step's row is missing. */
  stepName: string | null;
  /** Steps (step ids) with this name. */
  steps: number;
  events: number;
  /** `step_created` events among them. */
  created: number;
  /** `step_started` events among them. */
  started: number;
  /** `step_completed` events among them. */
  completed: number;
  /** `step_failed` events among them. */
  failed: number;
  /** `step_retrying` events among them. */
  retries: number;
  bytes: number;
}

export interface RunUsageAggregates {
  runId: string;
  status: WorkflowRunStatus;
  workflowName: string;
  /** Events other than steps', by type. */
  eventGroups: RunUsageEventGroup[];
  stepGroups: RunUsageStepGroup[];
  streamBytes: number;
  dataRetained?: RunUsage['dataRetained'];
  /**
   * The run's data was deleted when it finished. With `savedDataWritten`,
   * those are its sizes (what it wrote); without, the rows' sizes are
   * reported as what is left.
   */
  dataPurged?: boolean;
  /** Data written by entity, saved before the run's data was deleted. */
  savedDataWritten?: Record<RunUsageEntity, number>;
  /**
   * Distinct hooks and sleeps in the log. When absent, their `*_created`
   * events are counted instead.
   */
  calls?: { hook: number; wait: number };
  /** Whether the backend bills this run (default `false`). */
  billed?: boolean;
}

const UNKNOWN_STEP_NAME = '(unknown step)';

function spanOf(
  eventType: string,
  workflowName: string
): { kind: RunUsageSpanKind; name: string } {
  if (eventType.startsWith('hook_')) return { kind: 'hook', name: 'hook' };
  if (eventType.startsWith('wait_')) return { kind: 'wait', name: 'sleep' };
  // run_*, attr_set, and any event type this build does not know yet.
  return { kind: 'run', name: workflowName };
}

/** Locale-independent, so the browser and the CLI order spans alike. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The entity Data Written reports an event's bytes under, or `null` for a
 * placeholder (not an event). Shared with the World, which adds up the same
 * entities when it saves a purged run's sizes.
 */
export function usageEntityOfEventType(
  eventType: string
): RunUsageEntity | null {
  if (isSealedNoopEvent({ eventType })) return null;
  if (eventType.startsWith('step_')) return 'step';
  if (eventType.startsWith('hook_')) return 'hook';
  // run_*, attr_set, sleeps (no payload of their own) and any event type
  // this build does not know yet.
  return 'run';
}

/** Builds the usage shape from a World's aggregate rows. */
export function buildRunUsage(input: RunUsageAggregates): RunUsage {
  const spans = new Map<string, RunUsageSpan>();
  const byEntity: Record<RunUsageEntity, number> = {
    run: 0,
    step: 0,
    hook: 0,
    stream: toCount(input.streamBytes),
  };
  let events = 0;
  let retries = 0;

  const add = (
    kind: RunUsageSpanKind,
    name: string,
    entity: RunUsageEntity,
    count: number,
    retryCount: number,
    bytes: number
  ) => {
    if (count <= 0) return;
    const key = `${kind}\u0000${name}`;
    let span = spans.get(key);
    if (!span) {
      span = { kind, name, events: 0, share: 0, retries: 0, calls: 0 };
      spans.set(key, span);
    }
    span.events += count;
    span.retries += retryCount;
    events += count;
    retries += retryCount;
    byEntity[entity] += bytes;
  };

  const created = { hook: 0, wait: 0 };
  for (const group of input.eventGroups) {
    // Sealed-log placeholders are rows of the log, not events.
    const entity = usageEntityOfEventType(group.eventType);
    if (!entity) continue;
    if (group.eventType === 'hook_created')
      created.hook += toCount(group.events);
    if (group.eventType === 'wait_created')
      created.wait += toCount(group.events);
    const { kind, name } = spanOf(group.eventType, input.workflowName);
    add(kind, name, entity, toCount(group.events), 0, toCount(group.bytes));
  }
  const calls = {
    hook: toCount(input.calls?.hook ?? created.hook),
    wait: toCount(input.calls?.wait ?? created.wait),
  };
  const stepEvents: RunUsageStepEvents = {
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
  };
  for (const group of input.stepGroups) {
    const counts = {
      created: toCount(group.created),
      started: toCount(group.started),
      completed: toCount(group.completed),
      failed: toCount(group.failed),
      retrying: toCount(group.retries),
    };
    const total = toCount(group.events);
    if (total <= 0) continue;
    stepEvents.steps += toCount(group.steps);
    stepEvents.events += total;
    let known = 0;
    for (const type of RUN_USAGE_STEP_EVENT_TYPES) {
      stepEvents.byType[type] += counts[type];
      known += counts[type];
    }
    stepEvents.byType.other += Math.max(0, total - known);
    const name = group.stepName || UNKNOWN_STEP_NAME;
    add(
      'step',
      name,
      'step',
      toCount(group.events),
      toCount(group.retries),
      toCount(group.bytes)
    );
    const span = spans.get(`step\u0000${name}`);
    if (span) span.calls += toCount(group.steps);
  }
  for (const span of spans.values()) {
    if (span.kind === 'run') span.calls = 1;
    if (span.kind === 'hook') span.calls = calls.hook;
    if (span.kind === 'wait') span.calls = calls.wait;
  }

  const eventsBySpan = [...spans.values()]
    .map((span) => ({ ...span, share: events > 0 ? span.events / events : 0 }))
    .sort(
      (a, b) =>
        b.events - a.events ||
        compareCodeUnits(a.name, b.name) ||
        compareCodeUnits(a.kind, b.kind)
    );

  return {
    runId: input.runId,
    status: input.status,
    workflowName: input.workflowName,
    billed: input.billed === true,
    inProgress: !isTerminalWorkflowRunStatus(input.status),
    events,
    billableEvents: events,
    retries: { count: retries, events: retries * EVENTS_PER_RETRY },
    stepEvents,
    eventsBySpan,
    dataWritten: dataWrittenOf(input, byEntity),
    dataPurged: input.dataPurged === true,
    dataRetained: input.dataRetained ?? null,
  };
}

function dataWrittenOf(
  input: RunUsageAggregates,
  measured: Record<RunUsageEntity, number>
): RunUsage['dataWritten'] {
  const saved = input.dataPurged ? input.savedDataWritten : undefined;
  const byEntity = saved
    ? {
        run: toCount(saved.run),
        step: toCount(saved.step),
        hook: toCount(saved.hook),
        stream: toCount(saved.stream),
      }
    : measured;
  return {
    bytes: byEntity.run + byEntity.step + byEntity.hook + byEntity.stream,
    byEntity,
    source: !input.dataPurged
      ? 'log'
      : saved
        ? 'saved-at-purge'
        : 'left-after-purge',
  };
}

// ------------------------------------------------------------ formatting
// Shared by the UI and the CLI so both print the same strings.

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/**
 * A span's name as the trace shows it: the step or workflow function's short
 * name (`chargeCard` for `step//./src/order//chargeCard`). Hooks and sleeps
 * are already named `hook` and `sleep`.
 */
export function usageSpanLabel(
  span: Pick<RunUsageSpan, 'kind' | 'name'>
): string {
  if (span.kind === 'step') {
    return parseStepName(span.name)?.shortName || span.name;
  }
  if (span.kind === 'run') {
    return parseWorkflowName(span.name)?.shortName || span.name;
  }
  return span.name;
}

/** `1,234 events`. */
export function formatUsageEvents(count: number): string {
  return plural(count, 'event', 'events');
}

/** Decimal units, the ones the pricing page bills in (GB). */
export function formatUsageBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

/** A span's share as a whole percentage; `<1%` for a small non-zero one. */
export function formatUsageShare(share: number): string {
  if (share > 0 && share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}

const formatRetries = (count: number) => plural(count, 'retry', 'retries');

/**
 * `12 billable events · 1 retry` on a billed run, `12 events · 1 retry`
 * on one that is not (a Local World run): see {@link formatBillableNote}.
 */
export function formatRunUsageSummary(usage: RunUsage): string {
  const events = usage.billed
    ? plural(usage.billableEvents, 'billable event', 'billable events')
    : formatUsageEvents(usage.events);
  return `${events} · ${formatRetries(usage.retries.count)}`;
}

/**
 * What a run that is not billed would count as on Vercel; `null` on a
 * billed run, whose summary already says it.
 */
export function formatBillableNote(usage: RunUsage): string | null {
  if (usage.billed) return null;
  return `On Vercel, this run would count as ${plural(usage.billableEvents, 'billable event', 'billable events')}.`;
}

/** The run's events and retries, for the CLI's summary block. */
export function formatEventsWithRetries(usage: RunUsage): {
  events: string;
  retries: string;
} {
  return {
    events: usage.events.toLocaleString('en-US'),
    retries: formatRetries(usage.retries.count),
  };
}

/** The storage table's heading: what the sizes measure. */
export function formatDataWrittenHeading(usage: RunUsage): string {
  return usage.billed ? 'Data written' : 'Data written (local)';
}

/**
 * Why a run that is not billed has a size that differs from Vercel's;
 * `null` on a billed run.
 */
export function formatLocalDataWrittenNote(usage: RunUsage): string | null {
  if (usage.billed) return null;
  return 'Data this run wrote to your local data directory. Vercel measures Data Written in its own storage, so the number on Vercel will differ.';
}

/** The footer under the usage: not a bill, and how to read it. */
export function formatUsageFooter(usage: RunUsage): string {
  return usage.billed
    ? 'Not your final bill.'
    : "Local runs aren't billed. Counted from this run's log in your local data directory.";
}

/** What the run's own events are. */
export const RUN_EVENTS_NOTE =
  'Every run writes 3 events: created, started, and completed or failed.';

const RETRY_LINE = `Each retry adds ${EVENTS_PER_RETRY}: a retry marker, and the step starting again.`;
const BUILT_IN_LINE =
  'The run writes its own: created, started, and completed or failed. A sleep writes 2, a hook at least 2.';
const COUNT_COVERS =
  'The count covers the whole run, not only the events loaded on this page.';

/**
 * Every line of "How events are counted", from the run's own numbers. The
 * web UI shows all of them; the CLI prints {@link formatEventCountingNote}.
 */
export function formatEventCountingLines(usage: RunUsage): string[] {
  const breakdown = formatStepEventsBreakdown(usage);
  const creation = formatStepCreationNote(usage);
  return [
    ...(breakdown ? [`${breakdown}.`] : []),
    ...(creation ? [creation] : []),
    RETRY_LINE,
    BUILT_IN_LINE,
    usage.billed
      ? `Every event in the log is billable today. ${COUNT_COVERS}`
      : `On Vercel, every event in the log is billable. ${COUNT_COVERS}`,
  ];
}

/**
 * The two lines of "How events are counted" the CLI prints under its table:
 * how the run's step events add up (or, with no steps, what the run's own
 * events are), and what a retry adds. Both are lines of
 * {@link formatEventCountingLines}.
 */
export function formatEventCountingNote(usage: RunUsage): [string, string] {
  const breakdown = formatStepEventsBreakdown(usage);
  return [breakdown ? `${breakdown}.` : BUILT_IN_LINE, RETRY_LINE];
}

/**
 * For a run whose data was deleted when it finished: what its sizes show.
 * `null` for a run whose data is kept.
 */
export function formatDataPurgedNote(usage: RunUsage): string | null {
  if (!usage.dataPurged) return null;
  return usage.dataWritten.source === 'saved-at-purge'
    ? "This run's data was deleted when it finished; sizes show what it wrote."
    : "This run's data was deleted when it finished, before its sizes were kept; sizes show what is left.";
}

const STEP_EVENT_LABELS: Record<
  RunUsageStepEventType | 'other',
  [one: string, many: string]
> = {
  created: ['created', 'created'],
  started: ['started', 'started'],
  completed: ['completed', 'completed'],
  failed: ['failed', 'failed'],
  retrying: ['retry marker', 'retry markers'],
  other: ['other', 'other'],
};

/**
 * How the run's step events add up, from its own counts:
 * `5 steps wrote 14 events: 2 created, 7 started, 5 completed, 2 retry markers`.
 * `null` when no step ran.
 */
export function formatStepEventsBreakdown(usage: RunUsage): string | null {
  const { steps, events, byType } = usage.stepEvents;
  if (events <= 0) return null;
  const parts = ([...RUN_USAGE_STEP_EVENT_TYPES, 'other'] as const).flatMap(
    (type) => {
      const count = byType[type];
      if (count <= 0) return [];
      const [one, many] = STEP_EVENT_LABELS[type];
      return [`${count.toLocaleString('en-US')} ${count === 1 ? one : many}`];
    }
  );
  return `${plural(steps, 'step', 'steps')} wrote ${formatUsageEvents(events)}: ${parts.join(', ')}`;
}

/**
 * Why some steps have no `created` event, when that is so: they ran inline
 * on a spec 9 run, where a step's first `step_started` creates it. `null`
 * when every step has one.
 */
export function formatStepCreationNote(usage: RunUsage): string | null {
  const { steps, byType } = usage.stepEvents;
  const missing = steps - byType.created;
  if (missing <= 0) return null;
  return missing === steps
    ? 'No step has a created event: each ran inline, and its first started event created it.'
    : `${plural(missing, 'step has', 'steps have')} no created event: they ran inline, and their first started event created them.`;
}

export interface UsageSpanTreeRow {
  kind: RunUsageSpanKind;
  label: string;
  events: number;
  share: number;
  retries: number;
  calls: number;
  /** A tooltip: what the row's events are. */
  note?: string;
}

/**
 * The span table both the web UI and the CLI draw: the workflow, its steps
 * (biggest first, the rest folded), then the built-in rows (the run's own
 * events, sleeps, hooks).
 */
export interface UsageSpanTree {
  workflow: { label: string; events: number };
  steps: UsageSpanTreeRow[];
  /** Steps past the limit, folded into "+ N other steps"; `null` if none. */
  otherSteps: {
    steps: number;
    events: number;
    share: number;
    retries: number;
    calls: number;
  } | null;
  builtIns: UsageSpanTreeRow[];
  /** Label the built-in rows: only when sleeps or hooks are among them. */
  showBuiltInLabel: boolean;
}

const BUILT_IN_LABELS: Record<Exclude<RunUsageSpanKind, 'step'>, string> = {
  run: 'Run start & finish',
  wait: 'Sleeps',
  hook: 'Hooks',
};

const rowOf = (span: RunUsageSpan, label: string): UsageSpanTreeRow => ({
  kind: span.kind,
  label,
  events: span.events,
  share: span.share,
  retries: span.retries,
  calls: span.calls,
});

export function usageSpanTree(
  usage: RunUsage,
  limit: number = USAGE_SPANS_SHOWN
): UsageSpanTree {
  const steps = usage.eventsBySpan.filter((span) => span.kind === 'step');
  const { shown, other } = collapseUsageSpans(steps, limit);
  const builtIns = (['run', 'wait', 'hook'] as const).flatMap((kind) => {
    const span = usage.eventsBySpan.find((s) => s.kind === kind);
    if (!span) return [];
    const row = rowOf(span, BUILT_IN_LABELS[kind]);
    return [kind === 'run' ? { ...row, note: RUN_EVENTS_NOTE } : row];
  });
  return {
    workflow: {
      label:
        parseWorkflowName(usage.workflowName)?.shortName || usage.workflowName,
      events: usage.events,
    },
    steps: shown.map((span) => rowOf(span, usageSpanLabel(span))),
    otherSteps: other && {
      steps: other.spans,
      events: other.events,
      share: other.share,
      retries: other.retries,
      calls: other.calls,
    },
    builtIns,
    showBuiltInLabel: builtIns.some((row) => row.kind !== 'run'),
  };
}

/**
 * The step the biggest-driver callout names: the one with the most events.
 * Never a built-in row; `null` when the run has no steps.
 */
export function usageBiggestDriver(usage: RunUsage): RunUsageSpan | null {
  return usage.eventsBySpan.find((span) => span.kind === 'step') ?? null;
}

export interface CollapsedUsageSpans {
  shown: RunUsageSpan[];
  /** The spans past `limit`, folded into one row; `null` when none are. */
  other: {
    spans: number;
    events: number;
    share: number;
    retries: number;
    calls: number;
  } | null;
}

/** The first `limit` spans, and the rest as "N other spans". */
export function collapseUsageSpans(
  spans: RunUsageSpan[],
  limit: number = USAGE_SPANS_SHOWN
): CollapsedUsageSpans {
  // Folding a single span into "1 other span" hides it for nothing.
  if (spans.length <= limit + 1) return { shown: spans, other: null };
  const rest = spans.slice(limit);
  return {
    shown: spans.slice(0, limit),
    other: {
      spans: rest.length,
      events: rest.reduce((sum, span) => sum + span.events, 0),
      share: rest.reduce((sum, span) => sum + span.share, 0),
      retries: rest.reduce((sum, span) => sum + span.retries, 0),
      calls: rest.reduce((sum, span) => sum + span.calls, 0),
    },
  };
}
