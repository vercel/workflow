import {
  formatStepName,
  parseStepName,
  parseWorkflowName,
} from '@workflow/utils/parse-name';
import { isSealedNoopEvent } from './event-metadata.js';
import type { WorkflowRunStatus } from './runs.js';
import { isTerminalWorkflowRunStatus } from './runs.js';

/**
 * Per-run usage: the shape `workflow inspect run <id> --usage` reads, built
 * so that every surface that shows a run's usage reads the same numbers and
 * the same wording.
 *
 * Field names follow the billed resources on the pricing page
 * ({@link WORKFLOW_PRICING_DOCS_URL}): Workflow Events, Workflow Data Written
 * and Workflow Data Retained, so a future backend API can return this shape
 * unchanged.
 *
 * Only world-local computes it today (`world.experimental_usage`), from
 * aggregate queries over its database.
 *
 * Production data path (world-vercel): tracked in #5445. World-vercel needs
 * this shape from an analytics API or a precomputed per-run rollup, not from
 * reading the run's log.
 *
 * Pure (no Node.js imports), so a browser UI can bundle it.
 */

export const WORKFLOW_PRICING_DOCS_URL =
  'https://vercel.com/docs/workflows/pricing';

/** The docs section on what each event of a run is, and how it counts. */
export const USAGE_COUNTING_DOCS_URL =
  'https://workflow-sdk.dev/docs/observability#how-events-are-counted';

/** How many children a group of rows shows before folding the rest. */
const USAGE_SPANS_SHOWN = 5;

/**
 * What a span's events belong to: the run's own lifecycle (`run_*`), a step,
 * a hook, a sleep (`wait`), the run's attributes (`attr_set`), or event
 * types this build does not know (`other`).
 */
export type RunUsageSpanKind =
  | 'run'
  | 'step'
  | 'hook'
  | 'wait'
  | 'attributes'
  | 'other';

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
   * own events, a hook's token for that hook (each hook is a span of its
   * own), `sleep` for sleeps, `attributes` for attribute writes and `other`
   * for event types this build does not know.
   */
  name: string;
  /** A hook span's hook id (its token can be reused by a later hook). */
  id?: string;
  events: number;
  /** `events / RunUsage.events`, from 0 to 1. */
  share: number;
  /** `step_retrying` events in this span. */
  retries: number;
  /**
   * How many times the span ran: a step span's steps (calls of the step
   * function), a sleep span's sleeps, 1 for a hook or the run, and the
   * events themselves for attributes and other events.
   */
  calls: number;
}

export interface RunUsage {
  runId: string;
  status: WorkflowRunStatus;
  workflowName: string;
  /**
   * Whether the backend bills this run. `false` on the Local World, whose
   * runs are not billed: its events are not called billable.
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
    /**
     * Events the retries added, counted from the log: the `step_retrying`
     * markers, plus the `step_started` events they caused (each step's
     * starts after its first, up to its markers). A retry whose step has not
     * started again yet adds one.
     */
    events: number;
  };
  /** The run's own lifecycle events (`run_*`), by type. */
  runEvents: RunUsageRunEvents;
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
  /**
   * Workflow Data Written, in bytes, which the CLI labels `Storage (local)`
   * for a local run: the run's payloads as the SDK sent them (compressed or
   * encrypted when those apply), not event metadata, plus its stream bytes.
   * QuickJS VM snapshots are not counted yet.
   */
  dataWritten: {
    bytes: number;
    byEntity: Record<RunUsageEntity, number>;
    /**
     * Where the sizes come from: the run's rows as they are (`log`); for a
     * run whose data was deleted, the sizes saved before the deletion plus
     * anything written after (`saved-at-purge`), or, when none were saved
     * (a run deleted before the sizes were kept), what is left of it
     * (`left-after-purge`).
     */
    source: RunUsageDataWrittenSource;
  };
  /**
   * The run's data was deleted: when it finished (`experimental_retention:
   * 0`), or on demand. Its event counts are unaffected; see
   * `dataWritten.source` for whether its sizes are what it wrote.
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

/** The run event types {@link RunUsageRunEvents} counts. */
export type RunUsageRunEventType =
  | 'created'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const RUN_USAGE_RUN_EVENT_TYPES: readonly RunUsageRunEventType[] = [
  'created',
  'started',
  'completed',
  'failed',
  'cancelled',
];

export interface RunUsageRunEvents {
  events: number;
  byType: Record<RunUsageRunEventType, number>;
}

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
 * payload bytes. Step events go in {@link RunUsageStepGroup} instead.
 */
export interface RunUsageEventGroup {
  eventType: string;
  events: number;
  bytes: number;
}

/** The events of every step with one name, with their payload bytes. */
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
  /**
   * The `step_started` events a retry caused: per step, its starts after the
   * first, up to its `step_retrying` markers (a start past those is a
   * redelivery), summed over the steps.
   */
  restarts: number;
  bytes: number;
}

/** The events of one hook, by its id. */
export interface RunUsageHookGroup {
  hookId: string;
  /** The hook's token; `null` when the World could not find it. */
  token: string | null;
  events: number;
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
   * The run's data was deleted (when it finished, or on demand). With
   * `savedDataWritten`,
   * those are its sizes (what it wrote); without, the rows' sizes are
   * reported as what is left.
   */
  dataPurged?: boolean;
  /** Data written by entity, saved before the run's data was deleted. */
  savedDataWritten?: Record<RunUsageEntity, number>;
  /**
   * The hook events by hook. Each is a span of its own, named by its token;
   * without them, the hook events are one span named `hook`.
   */
  hookGroups?: RunUsageHookGroup[];
  /**
   * Distinct sleeps in the log. When absent, their `wait_created` events are
   * counted instead.
   */
  calls?: { wait: number };
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
  if (eventType.startsWith('run_')) return { kind: 'run', name: workflowName };
  if (eventType === 'attr_set') {
    return { kind: 'attributes', name: 'attributes' };
  }
  // An event type this build does not know yet.
  return { kind: 'other', name: 'other' };
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
  // With hook groups, each hook is a span of its own: the hook events count
  // towards the run here, and go to their hook's span below.
  const hookGroups = input.hookGroups;
  let hookEvents = 0;
  const runEvents: RunUsageRunEvents = {
    events: 0,
    byType: { created: 0, started: 0, completed: 0, failed: 0, cancelled: 0 },
  };
  for (const group of input.eventGroups) {
    // Sealed-log placeholders are rows of the log, not events.
    const entity = usageEntityOfEventType(group.eventType);
    if (!entity) continue;
    const runType = group.eventType.slice('run_'.length);
    if (
      group.eventType.startsWith('run_') &&
      (RUN_USAGE_RUN_EVENT_TYPES as readonly string[]).includes(runType)
    ) {
      runEvents.byType[runType as RunUsageRunEventType] += toCount(
        group.events
      );
    }
    if (group.eventType.startsWith('run_')) {
      runEvents.events += toCount(group.events);
    }
    if (group.eventType === 'hook_created')
      created.hook += toCount(group.events);
    if (group.eventType === 'wait_created')
      created.wait += toCount(group.events);
    const { kind, name } = spanOf(group.eventType, input.workflowName);
    if (kind === 'hook' && hookGroups) {
      hookEvents += toCount(group.events);
      events += toCount(group.events);
      byEntity[entity] += toCount(group.bytes);
      continue;
    }
    add(kind, name, entity, toCount(group.events), 0, toCount(group.bytes));
  }
  if (hookGroups) {
    let grouped = 0;
    for (const group of hookGroups) {
      const count = toCount(group.events);
      if (count <= 0 || !group.hookId) continue;
      grouped += count;
      spans.set(`hook\u0000${group.hookId}`, {
        kind: 'hook',
        name: group.token || group.hookId,
        id: group.hookId,
        events: count,
        share: 0,
        retries: 0,
        calls: 1,
      });
    }
    // Hook events no group holds (none from world-local), so the spans
    // still add up to the run's events.
    if (hookEvents > grouped) {
      spans.set('hook\u0000', {
        kind: 'hook',
        name: 'hook',
        events: hookEvents - grouped,
        share: 0,
        retries: 0,
        calls: 0,
      });
    }
  }
  const calls = {
    hook: toCount(created.hook),
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
  let restarts = 0;
  for (const group of input.stepGroups) {
    restarts += toCount(group.restarts);
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
    if (span.kind === 'hook' && !hookGroups) span.calls = calls.hook;
    if (span.kind === 'wait') span.calls = calls.wait;
    if (span.kind === 'attributes' || span.kind === 'other') {
      span.calls = span.events;
    }
  }

  const eventsBySpan = [...spans.values()]
    .map((span) => ({ ...span, share: events > 0 ? span.events / events : 0 }))
    .sort(
      (a, b) =>
        b.events - a.events ||
        compareCodeUnits(a.name, b.name) ||
        compareCodeUnits(a.kind, b.kind) ||
        compareCodeUnits(a.id ?? '', b.id ?? '')
    );

  return {
    runId: input.runId,
    status: input.status,
    workflowName: input.workflowName,
    billed: input.billed === true,
    inProgress: !isTerminalWorkflowRunStatus(input.status),
    events,
    billableEvents: events,
    retries: { count: retries, events: retries + restarts },
    runEvents,
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

/**
 * `1 retry`, `2 retries`, `1,234 events`: a count and the word for it,
 * shared so every surface pluralizes alike.
 */
export function formatCount(count: number, one: string, many: string): string {
  return plural(count, one, many);
}

/** The row the steps past the shown ones fold into: `+ 3 other steps`. */
export function formatOtherSteps(steps: number): string {
  return `+ ${steps.toLocaleString('en-US')} other ${steps === 1 ? 'step' : 'steps'}`;
}

/**
 * The label for {@link RunUsage.dataWritten}: `Storage (local)` on a run
 * that is not billed, `Storage` on one that is.
 */
export function formatDataWrittenHeading(usage: RunUsage): string {
  return usage.billed ? 'Storage' : 'Storage (local)';
}

/**
 * What a local run's storage counts; `null` on a billed run.
 */
export function formatLocalDataWrittenNote(usage: RunUsage): string | null {
  if (usage.billed) return null;
  return "The bytes of the run's payloads as the SDK sent them, plus the bytes it wrote to streams, counted the way Vercel counts Data Written. It doesn't include QuickJS VM snapshots or a dynamic workflow's code.";
}

/** The footer under the usage: not a bill, and how to read it. */
export function formatUsageFooter(usage: RunUsage): string {
  return usage.billed
    ? 'Not your final bill.'
    : "Local runs aren't billed. Counted from this run's log in your local data directory.";
}

const RUN_EVENT_LABELS: Record<RunUsageRunEventType, string> = {
  created: 'created',
  started: 'started',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * What the run's own events were, from its counts: `The run wrote 3 events:
 * 1 created, 1 started, 1 completed.` A run cancelled before it started, or
 * one still running, says what it wrote so far. `null` with no run events.
 */
export function formatRunEventsLine(usage: RunUsage): string | null {
  const { events, byType } = usage.runEvents;
  if (events <= 0) return null;
  const parts = RUN_USAGE_RUN_EVENT_TYPES.flatMap((type) =>
    byType[type] > 0
      ? [`${byType[type].toLocaleString('en-US')} ${RUN_EVENT_LABELS[type]}`]
      : []
  );
  const known = RUN_USAGE_RUN_EVENT_TYPES.reduce((n, t) => n + byType[t], 0);
  if (events > known) {
    parts.push(`${(events - known).toLocaleString('en-US')} other`);
  }
  const sofar = usage.inProgress ? ' so far' : '';
  return `The run wrote ${formatUsageEvents(events)}${sofar}: ${parts.join(', ')}.`;
}

/**
 * For a run whose data was deleted (when it finished, or on demand): what
 * its sizes show.
 * `null` for a run whose data is kept.
 */
export function formatDataPurgedNote(usage: RunUsage): string | null {
  if (!usage.dataPurged) return null;
  return usage.dataWritten.source === 'saved-at-purge'
    ? "This run's data was deleted; sizes show what it wrote."
    : "This run's data was deleted before its sizes were kept; sizes show what is left.";
}

/** What a group of rows holds, in the order the table lists them. */
export type UsageRowType =
  | 'steps'
  | 'hooks'
  | 'attributes'
  | 'sleeps'
  | 'run'
  | 'other';

const USAGE_ROW_TYPES: readonly UsageRowType[] = [
  'steps',
  'hooks',
  'attributes',
  'sleeps',
  'run',
  'other',
];

/** The Type column. */
export const USAGE_ROW_TYPE_LABELS: Record<UsageRowType, string> = {
  steps: 'Steps',
  hooks: 'Hooks',
  attributes: 'Attributes',
  sleeps: 'Sleeps',
  run: 'Run',
  other: 'Other events',
};

const SPAN_KIND_OF_ROW_TYPE: Record<UsageRowType, RunUsageSpanKind> = {
  steps: 'step',
  hooks: 'hook',
  attributes: 'attributes',
  sleeps: 'wait',
  run: 'run',
  other: 'other',
};

export interface UsageRow {
  /**
   * Stable across reads, for a UI to key the row on: a step function's full
   * name, a hook's id (a token can be reused by a later hook), and the row
   * type for a group. Labels are not unique enough: two step functions in
   * different files can share a short name.
   */
  key: string;
  /** A step function's short name, or a hook's token. */
  label: string;
  events: number;
  /** Of the run's events, from 0 to 1. */
  share: number;
  retries: number;
  /**
   * Steps: calls of the step function. Hooks: 1. A group: its steps' calls,
   * its hooks, attribute writes, sleeps, or 1 for the run.
   */
  calls: number;
  /** A tooltip: what the row's events are. */
  note?: string;
}

export interface UsageRowGroup extends Omit<UsageRow, 'label'> {
  type: UsageRowType;
  /** Steps: each step function. Hooks: each hook. Biggest first. */
  children: UsageRow[];
  /** The children past the limit, folded into one row; `null` if none. */
  otherChildren: (Omit<UsageRow, 'note'> & { count: number }) | null;
}

/**
 * The usage table, one flat list: Steps (each step function under it),
 * Hooks (each hook, by token), then Attributes, Sleeps and Run, and Other
 * events for types this build does not know. Only the types the run has.
 */
export function usageRows(
  usage: RunUsage,
  limit: number = USAGE_SPANS_SHOWN
): UsageRowGroup[] {
  const runNote = formatRunEventsLine(usage) ?? undefined;
  return USAGE_ROW_TYPES.flatMap((type): UsageRowGroup[] => {
    const spans = usage.eventsBySpan.filter(
      (span) => span.kind === SPAN_KIND_OF_ROW_TYPE[type]
    );
    if (spans.length === 0) return [];
    const total = sumRows(spans);
    const group: UsageRowGroup = {
      type,
      key: type,
      events: total.events,
      share: total.share,
      retries: total.retries,
      calls: type === 'hooks' ? spans.length : total.calls,
      children: [],
      otherChildren: null,
      ...(type === 'run' && runNote ? { note: runNote } : {}),
    };
    if (type !== 'steps' && type !== 'hooks') return [group];
    const { shown, other } = collapseUsageSpans(spans, limit);
    group.children = childRowsOf(shown);
    group.otherChildren = other && {
      key: `${type}:other`,
      count: other.spans,
      label:
        type === 'steps'
          ? formatOtherSteps(other.spans)
          : `+ ${other.spans.toLocaleString('en-US')} other ${other.spans === 1 ? 'hook' : 'hooks'}`,
      events: other.events,
      share: other.share,
      retries: other.retries,
      calls: other.calls,
    };
    return [group];
  });
}

function sumRows(spans: RunUsageSpan[]) {
  return spans.reduce(
    (sum, span) => ({
      events: sum.events + span.events,
      share: sum.share + span.share,
      retries: sum.retries + span.retries,
      calls: sum.calls + span.calls,
    }),
    { events: 0, share: 0, retries: 0, calls: 0 }
  );
}

/**
 * Child rows, labelled by short name (a step) or token (a hook). Rows whose
 * labels would read the same carry more: a step its module (`send
 * (./src/a)` and `send (./src/b)`), a hook its id.
 */
function childRowsOf(spans: RunUsageSpan[]): UsageRow[] {
  const labels = spans.map((span) => usageSpanLabel(span));
  const seen = new Map<string, number>();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  return spans.map((span, i) => ({
    key: span.kind === 'hook' ? (span.id ?? span.name) : span.name,
    label:
      (seen.get(labels[i]) ?? 0) > 1
        ? span.kind === 'step'
          ? formatStepName(span.name)
          : `${labels[i]} (${span.id ?? span.name})`
        : labels[i],
    events: span.events,
    share: span.share,
    retries: span.retries,
    calls: span.calls,
  }));
}

interface CollapsedUsageSpans {
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
function collapseUsageSpans(
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
