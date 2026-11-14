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

/** A step that succeeds first time writes created, started and completed. */
export const EVENTS_PER_STEP = 3;

/** Each retry writes `step_retrying` and runs the step again (`step_started`). */
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
}

export interface RunUsage {
  runId: string;
  status: WorkflowRunStatus;
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
  /** Sorted by events, most first. */
  eventsBySpan: RunUsageSpan[];
  /** Workflow Data Written, in bytes. */
  dataWritten: {
    bytes: number;
    byEntity: Record<RunUsageEntity, number>;
  };
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
  events: number;
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

function entityOf(kind: RunUsageSpanKind): RunUsageEntity {
  // A sleep has no payload of its own; its few bytes are the run's.
  return kind === 'wait' ? 'run' : kind;
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
    count: number,
    retryCount: number,
    bytes: number
  ) => {
    if (count <= 0) return;
    const key = `${kind}\u0000${name}`;
    let span = spans.get(key);
    if (!span) {
      span = { kind, name, events: 0, share: 0, retries: 0 };
      spans.set(key, span);
    }
    span.events += count;
    span.retries += retryCount;
    events += count;
    retries += retryCount;
    byEntity[entityOf(kind)] += bytes;
  };

  for (const group of input.eventGroups) {
    // Sealed-log placeholders are rows of the log, not events.
    if (isSealedNoopEvent(group)) continue;
    const { kind, name } = spanOf(group.eventType, input.workflowName);
    add(kind, name, toCount(group.events), 0, toCount(group.bytes));
  }
  for (const group of input.stepGroups) {
    add(
      'step',
      group.stepName || UNKNOWN_STEP_NAME,
      toCount(group.events),
      toCount(group.retries),
      toCount(group.bytes)
    );
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
    inProgress: !isTerminalWorkflowRunStatus(input.status),
    events,
    billableEvents: events,
    retries: { count: retries, events: retries * EVENTS_PER_RETRY },
    eventsBySpan,
    dataWritten: {
      bytes: byEntity.run + byEntity.step + byEntity.hook + byEntity.stream,
      byEntity,
    },
    dataRetained: input.dataRetained ?? null,
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

/** `12 billable events · 1 retry (+2 events)`. */
export function formatRunUsageSummary(usage: RunUsage): string {
  const billable = plural(
    usage.billableEvents,
    'billable event',
    'billable events'
  );
  const retries = plural(usage.retries.count, 'retry', 'retries');
  if (usage.retries.count === 0) return `${billable} · ${retries}`;
  return `${billable} · ${retries} (+${formatUsageEvents(usage.retries.events)})`;
}

export interface CollapsedUsageSpans {
  shown: RunUsageSpan[];
  /** The spans past `limit`, folded into one row; `null` when none are. */
  other: {
    spans: number;
    events: number;
    share: number;
    retries: number;
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
    },
  };
}
