'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  getEventDataRefFields,
  type WorkflowRun,
} from '@workflow/world';
import { ChartGantt, CircleX, Search, TriangleAlert } from 'lucide-react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { cn } from '../lib/cn';
import {
  DUPLICATE_EVENT_MESSAGE,
  findDuplicateEventIds,
} from '../lib/duplicate-events';
import {
  type ExactIdSearchResult,
  type ExactWorkflowSearchIdKind,
  parseExactWorkflowSearchId,
} from '../lib/exact-event-search-id';
import { isEncryptedMarker } from '../lib/hydration';
import { isSealedNoopEvent, SEALED_EVENT_MESSAGE } from '../lib/sealed-events';
import { formatDurationPrecise } from '../lib/utils';
import {
  AttrSetEventBlock,
  DetailMonoKeyValueRow,
} from './sidebar/attributes-block';
import { serializeForClipboard } from './sidebar/copyable-data-block';
import { CopyButton } from './trace-viewer/components/copy-button';
import { DetailPanelShell } from './trace-viewer/components/detail-panel-shell';
import { ResourceIcon } from './trace-viewer/components/event-list';
import { Collapsible } from './ui/collapsible';
import { ContextCardProvider } from './ui/context-card';
import { DataInspector, DecryptClickContext } from './ui/data-inspector';
import { DecryptButton } from './ui/decrypt-button';
import { EventNoticeTooltip } from './ui/duplicate-event-tooltip';
import {
  ErrorStackBlock,
  isStructuredError,
  type StructuredErrorRecord,
} from './ui/error-stack-block';
import { IconButton } from './ui/icon-button';
import { Kbd } from './ui/kbd';
import { LoadMoreButton } from './ui/load-more-button';
import { Skeleton } from './ui/skeleton';
import { TimestampTooltip } from './ui/timestamp-tooltip';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

/**
 * Event types whose eventData contains an error field with a StructuredError.
 */
const ERROR_EVENT_TYPES = new Set([
  'step_failed',
  'step_retrying',
  'run_failed',
  'workflow_failed',
]);

function parseEventDate(value: unknown): Date | null {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEffectiveEventDate(
  event: Pick<Event, 'createdAt' | 'occurredAt'>
): Date {
  return parseEventDate(event.occurredAt) ?? new Date(event.createdAt);
}

function getEffectiveEventTime(
  event: Pick<Event, 'createdAt' | 'occurredAt'>
): number {
  return getEffectiveEventDate(event).getTime();
}

// ──────────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────────

const pad = (n: number, width = 2) => n.toString().padStart(width, '0');

/** Timestamp parts: dimmed `NOV 06`, clock, dimmed `.123`. */
function formatTimestampParts(date: Date): {
  day: string;
  clock: string;
  ms: string;
} {
  const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return {
    day: `${month} ${pad(date.getDate())}`,
    clock: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ms: `.${pad(date.getMilliseconds(), 3)}`,
  };
}

function formatClock(value: unknown): string | null {
  const date = parseEventDate(value);
  return date ? formatTimestampParts(date).clock : null;
}

function formatSinceStart(ms: number): string {
  return ms <= 0 ? '0ms' : `+${formatDurationPrecise(ms)}`;
}

/**
 * Build a map from correlationId (stepId) → display name using step_created
 * events, and parse the workflow name from the run.
 */
export function buildNameMaps(
  events: Event[] | null,
  run: WorkflowRun | null
): {
  correlationNameMap: Map<string, string>;
  workflowName: string | null;
} {
  const correlationNameMap = new Map<string, string>();

  // Map step correlationId (= stepId) → parsed step name. Taken from
  // step_created, or from step_started for a step whose creation the World
  // recorded on its start alone (no step_created in the log).
  if (events) {
    for (const event of events) {
      if (
        (event.eventType === 'step_created' ||
          event.eventType === 'step_started') &&
        event.correlationId
      ) {
        const stepName = event.eventData?.stepName;
        if (typeof stepName !== 'string') continue;
        if (
          event.eventType === 'step_started' &&
          correlationNameMap.has(event.correlationId)
        ) {
          continue;
        }
        const parsed =
          parseStepName(String(stepName)) ??
          parseWorkflowName(String(stepName));
        correlationNameMap.set(
          event.correlationId,
          parsed?.shortName ?? stepName
        );
      }
    }
  }

  // Parse workflow name from run
  const workflowName = run?.workflowName
    ? (parseWorkflowName(run.workflowName)?.shortName ?? run.workflowName)
    : null;

  return { correlationNameMap, workflowName };
}

export interface DurationInfo {
  /** Time from created → started (ms) */
  queued?: number;
  /** Time from started → completed/failed/cancelled (ms) */
  ran?: number;
}

/**
 * Build a map from correlationId → duration info by diffing
 * created ↔ started (queued) and started ↔ completed/failed/cancelled (ran).
 * Also computes run-level durations under the key '__run__'.
 *
 * Events every replay reads past as repeats are excluded: a second
 * `step_completed` written by a concurrent replay would otherwise stretch the
 * step's measured runtime to whenever that replay happened to commit. The
 * caller supplies them, because whether an event is a repeat is a property of
 * the whole log and this function may be handed a page of it.
 */
export function buildDurationMap(
  events: Event[],
  duplicateEventIds: ReadonlySet<string> = new Set()
): Map<string, DurationInfo> {
  // Process events in chronological order so the result doesn't depend on
  // the caller's sort direction. Retried steps emit multiple `step_started`
  // events for the same correlationId; the queued duration must be measured
  // against the first one, not the last.
  const chronological = [...events]
    .filter((event) => !duplicateEventIds.has(event.eventId))
    .sort((a, b) => getEffectiveEventTime(a) - getEffectiveEventTime(b));

  const createdTimes = new Map<string, number>();
  const firstStartedTimes = new Map<string, number>();
  const startedTimes = new Map<string, number>();
  const durations = new Map<string, DurationInfo>();

  for (const event of chronological) {
    const ts = getEffectiveEventTime(event);
    const key = event.correlationId ?? '__run__';
    const type: string = event.eventType;

    // Track created times (first event for each correlation)
    if (type === 'step_created' || type === 'run_created') {
      if (!createdTimes.has(key)) {
        createdTimes.set(key, ts);
      }
    }

    // Track started times & compute queued duration
    if (
      type === 'step_started' ||
      type === 'run_started' ||
      type === 'workflow_started'
    ) {
      startedTimes.set(key, ts);
      // The queued duration is anchored on the first start event only, since
      // subsequent step_started events come from retries.
      if (!firstStartedTimes.has(key)) {
        firstStartedTimes.set(key, ts);
        // If no explicit created event was seen, use the started time as created
        if (!createdTimes.has(key)) {
          createdTimes.set(key, ts);
        }
        const createdAt = createdTimes.get(key);
        const info = durations.get(key) ?? {};
        if (createdAt !== undefined) {
          info.queued = ts - createdAt;
        }
        durations.set(key, info);
      }
    }

    // Compute ran duration on terminal events
    if (
      type === 'step_completed' ||
      type === 'step_failed' ||
      type === 'run_completed' ||
      type === 'run_failed' ||
      type === 'run_cancelled' ||
      type === 'workflow_completed' ||
      type === 'workflow_failed' ||
      type === 'wait_completed' ||
      type === 'hook_disposed'
    ) {
      const startedAt = startedTimes.get(key);
      const info = durations.get(key) ?? {};
      if (startedAt !== undefined) {
        info.ran = ts - startedAt;
      }
      durations.set(key, info);
    }
  }

  return durations;
}

/** Check if a loaded eventData object contains any encrypted marker values. */
function hasEncryptedValues(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  for (const val of Object.values(data as Record<string, unknown>)) {
    if (isEncryptedMarker(val)) return true;
  }
  return false;
}

function isRunLevel(eventType: string): boolean {
  return (
    eventType === 'run_created' ||
    eventType === 'run_started' ||
    eventType === 'run_completed' ||
    eventType === 'run_failed' ||
    eventType === 'run_cancelled' ||
    eventType === 'workflow_started' ||
    eventType === 'workflow_completed' ||
    eventType === 'workflow_failed' ||
    // attr_set and noop carry a dedup/positional correlationId rather than a
    // child entity ID, so they group and label with the run itself.
    eventType === 'attr_set' ||
    eventType === 'noop'
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Row model: level, display name, one-line message
// ──────────────────────────────────────────────────────────────────────────

type EventLevel = 'default' | 'warning' | 'error' | 'muted';

/**
 * Rows are tinted by level. Only events that need attention get color;
 * everything else stays neutral.
 */
function getEventLevel(event: Event, isDuplicate: boolean): EventLevel {
  if (isDuplicate || isSealedNoopEvent(event)) return 'muted';
  switch (event.eventType) {
    case 'step_failed':
    case 'run_failed':
      return 'error';
    case 'step_retrying':
    case 'hook_conflict':
      return 'warning';
    default:
      return 'default';
  }
}

const LEVEL_ROW_CLASS: Record<EventLevel, string> = {
  default: 'text-gray-1000 hover:bg-gray-alpha-200',
  muted: 'text-gray-700 hover:bg-gray-alpha-200',
  warning: 'bg-amber-100 text-amber-900 hover:bg-amber-200',
  error: 'bg-red-100 text-red-900 hover:bg-red-200',
};

/** Column separator before Message, tinted with the row. */
const LEVEL_SEPARATOR_CLASS: Record<EventLevel, string> = {
  default: 'border-gray-400',
  muted: 'border-gray-400',
  warning: 'border-amber-400',
  error: 'border-red-400',
};

const LEVEL_SELECTED_CLASS: Record<EventLevel, string> = {
  default: 'bg-gray-200 hover:bg-gray-200',
  muted: 'bg-gray-200 hover:bg-gray-200',
  warning: 'bg-amber-300 hover:bg-amber-300',
  error: 'bg-red-300 hover:bg-red-300',
};

/** Map hook correlationId → token, from hook_created (token is never stripped). */
function buildHookNameMap(events: Event[] | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events ?? []) {
    if (event.eventType !== 'hook_created' || !event.correlationId) continue;
    const token = (event.eventData as { token?: unknown } | undefined)?.token;
    if (typeof token === 'string') map.set(event.correlationId, token);
  }
  return map;
}

function getEventName(
  event: Event,
  names: {
    correlationNameMap: Map<string, string>;
    hookNameMap: Map<string, string>;
    workflowName: string | null;
  }
): string {
  if (isRunLevel(event.eventType)) return names.workflowName ?? '';
  const id = event.correlationId;
  if (!id) return '';
  if (event.eventType.startsWith('hook_')) {
    return names.hookNameMap.get(id) ?? 'hook';
  }
  if (event.eventType.startsWith('wait_')) return 'sleep';
  return names.correlationNameMap.get(id) ?? '';
}

/** The trace viewer's resource kind for an event, for its type icon. */
function getEventResource(eventType: string): string {
  if (eventType.startsWith('step_')) return 'step';
  if (eventType.startsWith('hook_')) return 'hook';
  if (eventType.startsWith('wait_')) return 'sleep';
  if (eventType.startsWith('run_') || eventType === 'attr_set') return 'run';
  return eventType;
}

/**
 * One-line summary from what a list response carries inline. Payload fields
 * (input, result, error, payload) are stripped by `resolveData: 'none'`, so
 * the summary only uses the scalar fields every event keeps.
 */
function getEventMessage(
  event: Event,
  ctx: { durationInfo?: DurationInfo; isDuplicate: boolean }
): string {
  if (ctx.isDuplicate) return 'duplicate, ignored on replay';
  if (isSealedNoopEvent(event)) return 'sealed slot, never observed by the run';
  const data = (event.eventData ?? {}) as Record<string, unknown>;
  const attempt = typeof data.attempt === 'number' ? data.attempt : undefined;

  switch (event.eventType) {
    case 'step_started': {
      const parts: string[] = [];
      if (attempt && attempt > 1) parts.push(`attempt ${attempt}`);
      else if (ctx.durationInfo?.queued) {
        parts.push(`queued ${formatDurationPrecise(ctx.durationInfo.queued)}`);
      }
      return parts.join(' · ');
    }
    case 'step_retrying': {
      const retryAt = formatClock(data.retryAfter);
      const head = attempt ? `attempt ${attempt} failed` : 'attempt failed';
      return retryAt ? `${head} · retry at ${retryAt}` : head;
    }
    case 'step_failed':
      return attempt ? `failed on attempt ${attempt}` : 'failed';
    case 'run_failed':
      return typeof data.errorCode === 'string' ? data.errorCode : '';
    case 'run_cancelled':
      return typeof data.cancelReason === 'string' ? data.cancelReason : '';
    case 'wait_created': {
      const resumeAt = formatClock(data.resumeAt);
      return resumeAt ? `resumes at ${resumeAt}` : '';
    }
    case 'hook_created':
      return data.isWebhook ? 'webhook' : '';
    case 'hook_conflict':
      return typeof data.conflictingRunId === 'string'
        ? `token held by ${data.conflictingRunId}`
        : 'token already in use';
    case 'attr_set': {
      const changes = Array.isArray(data.changes) ? data.changes : [];
      return changes
        .map((change: { key?: unknown; value?: unknown }) =>
          change.value === null
            ? `${String(change.key)} removed`
            : `${String(change.key)} = ${JSON.stringify(change.value)}`
        )
        .join(', ');
    }
    default:
      return '';
  }
}

/** Run time of terminal events, right-aligned in the Duration column. */
const TERMINAL_EVENT_TYPES = new Set([
  'step_completed',
  'step_failed',
  'step_retrying',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'wait_completed',
]);

// ──────────────────────────────────────────────────────────────────────────
// Idle gaps
// ──────────────────────────────────────────────────────────────────────────

/** A pause this long between consecutive events gets a divider row. */
const IDLE_GAP_MS = 30_000;

type ListItem =
  | { kind: 'event'; event: Event; index: number }
  | { kind: 'gap'; key: string; ms: number; reason: string };

function describeGap(later: Event, hookNameMap: Map<string, string>): string {
  if (later.eventType === 'wait_completed') return 'waiting on sleep';
  if (later.eventType === 'hook_received') {
    const token = later.correlationId
      ? hookNameMap.get(later.correlationId)
      : undefined;
    return token ? `waiting on hook ${token}` : 'waiting on hook';
  }
  return '';
}

function buildListItems(
  events: Event[],
  options: { showGaps: boolean; hookNameMap: Map<string, string> }
): ListItem[] {
  const items: ListItem[] = [];
  events.forEach((event, index) => {
    if (options.showGaps && index > 0) {
      const prev = events[index - 1];
      const a = getEffectiveEventTime(prev);
      const b = getEffectiveEventTime(event);
      const ms = Math.abs(b - a);
      if (ms >= IDLE_GAP_MS) {
        const later = b >= a ? event : prev;
        items.push({
          kind: 'gap',
          key: `gap-${prev.eventId}-${event.eventId}`,
          ms,
          reason: describeGap(later, options.hookNameMap),
        });
      }
    }
    items.push({ kind: 'event', event, index });
  });
  return items;
}

/**
 * Per-event duration for the Duration column: how long the attempt, wait or
 * run that this event closes took. A retrying step gets one value per failed
 * attempt, measured from the `step_started` that opened that attempt.
 */
export function buildEventDurationMap(
  events: Event[],
  duplicateEventIds: ReadonlySet<string> = new Set()
): Map<string, number> {
  const chronological = [...events]
    .filter((event) => !duplicateEventIds.has(event.eventId))
    .sort((a, b) => getEffectiveEventTime(a) - getEffectiveEventTime(b));
  const opened = new Map<string, number>();
  const durations = new Map<string, number>();
  for (const event of chronological) {
    const ts = getEffectiveEventTime(event);
    const key = isRunLevel(event.eventType)
      ? '__run__'
      : (event.correlationId ?? '');
    const type: string = event.eventType;
    if (
      type === 'step_started' ||
      type === 'run_started' ||
      type === 'wait_created'
    ) {
      opened.set(key, ts);
      continue;
    }
    if (TERMINAL_EVENT_TYPES.has(type)) {
      const start = opened.get(key);
      if (start !== undefined) durations.set(event.eventId, ts - start);
    }
  }
  return durations;
}

/** Recursively parse stringified JSON values so escaped slashes / quotes are cleaned up */
function deepParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
      try {
        return deepParseJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepParseJson);
  }
  if (value !== null && typeof value === 'object') {
    // Preserve objects with custom constructors (e.g., encrypted markers,
    // class instance refs); don't destructure them into plain objects
    if (value.constructor !== Object) {
      return value;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepParseJson(v);
    }
    return result;
  }
  return value;
}

/**
 * Extracts a structured error from event data, if present.
 * Returns the error object to render with ErrorStackBlock, or null if not applicable.
 */
function extractStructuredError(
  data: unknown,
  eventType?: string
): StructuredErrorRecord | null {
  if (!eventType || !ERROR_EVENT_TYPES.has(eventType)) return null;
  if (data == null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  // Check the nested `error` field first (the StructuredError)
  if (isStructuredError(record.error)) return record.error;
  // Some error formats put the message/stack at the top level of eventData.
  if (isStructuredError(record)) return record;
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────────────

const COL = {
  level: 'w-6 justify-center',
  time: 'w-[172px]',
  since: 'w-[100px]',
  event: 'w-[136px]',
  name: 'w-[200px]',
  duration: 'w-[96px] justify-end',
} as const;

const CELL = 'flex h-full shrink-0 items-center overflow-hidden px-1.5';

function TimestampCell({
  date,
  secondaryClass,
}: {
  date: Date;
  secondaryClass?: string;
}) {
  const parts = formatTimestampParts(date);
  return (
    <div className={cn(CELL, COL.time, 'tabular-nums')}>
      <TimestampTooltip date={date}>
        <span className="whitespace-nowrap">
          <span className={secondaryClass}>{`${parts.day} `}</span>
          {parts.clock}
          <span className={secondaryClass}>{parts.ms}</span>
        </span>
      </TimestampTooltip>
    </div>
  );
}

function LevelIcon({ level }: { level: EventLevel }) {
  if (level === 'warning') {
    return <TriangleAlert aria-label="Warning" className="h-3.5 w-3.5" />;
  }
  if (level === 'error') {
    return <CircleX aria-label="Error" className="h-3.5 w-3.5" />;
  }
  return null;
}

function ListHeader({ showOccurred }: { showOccurred: boolean }): ReactNode {
  return (
    <div
      role="row"
      className="mx-1 flex h-10 shrink-0 items-center border-b border-gray-alpha-200 font-sans text-label-14 text-gray-900"
    >
      <div className={cn(CELL, COL.level)} />
      {showOccurred && <div className={cn(CELL, COL.time)}>Occurred</div>}
      <div className={cn(CELL, COL.time)}>
        {showOccurred ? 'Created' : 'Time'}
      </div>
      <div className={cn(CELL, COL.since)} />
      <div className={cn(CELL, COL.event)}>Event</div>
      <div className={cn(CELL, COL.name)}>Name</div>
      <div
        className={cn(CELL, 'min-w-0 flex-1 h-3.5 border-l border-gray-400')}
      >
        Message
      </div>
      <div className={cn(CELL, COL.duration)}>Duration</div>
    </div>
  );
}

function IdleGapRow({ ms, reason }: { ms: number; reason: string }) {
  return (
    <div className="mx-1 mt-px flex h-6 items-center gap-2.5 pl-[30px] pr-2 font-mono text-label-12-mono text-gray-700">
      <span className="h-px w-3 shrink-0 bg-gray-400" />
      <span className="shrink-0">
        {formatDurationPrecise(ms)} idle{reason ? ` · ${reason}` : ''}
      </span>
      <span className="h-px flex-1 bg-gray-400" />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Event row
// ──────────────────────────────────────────────────────────────────────────

/** Marks every case-insensitive match of `query`. */
function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(query, from);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded-xs bg-amber-200 text-amber-900">
        {text.slice(at, at + query.length)}
      </mark>
    );
    from = at + query.length;
    at = lower.indexOf(query, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

interface EventRowProps {
  event: Event;
  /** Position among events (not gap rows); drives zebra striping. */
  index: number;
  isSelected: boolean;
  /** The one row Tab lands on (roving tabindex): the selection, else the first row. */
  isTabStop: boolean;
  /** The row belongs to the selected event's step, hook, wait or run. */
  isRelated: boolean;
  onSelect: (event: Event) => void;
  correlationNameMap: Map<string, string>;
  hookNameMap: Map<string, string>;
  workflowName: string | null;
  durationMap: Map<string, DurationInfo>;
  eventDurationMap: Map<string, number>;
  /** Epoch ms the "Since start" column is measured from. */
  runStartMs?: number;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  /** The event repeats a class already in the log, so the runtime ignored it. */
  isDuplicate?: boolean;
  /** Lowercased search text to mark in the row. */
  highlight?: string;
}

function EventRow({
  event,
  index,
  isSelected,
  isTabStop,
  isRelated,
  onSelect,
  correlationNameMap,
  hookNameMap,
  workflowName,
  durationMap,
  eventDurationMap,
  runStartMs,
  showSeparateEventOccurrenceTimestamps = false,
  isDuplicate = false,
  highlight,
}: EventRowProps) {
  const level = getEventLevel(event, isDuplicate);
  const notice = isDuplicate
    ? DUPLICATE_EVENT_MESSAGE
    : isSealedNoopEvent(event)
      ? SEALED_EVENT_MESSAGE
      : undefined;
  const occurredAt = parseEventDate(event.occurredAt);
  const displayedAt = showSeparateEventOccurrenceTimestamps
    ? new Date(event.createdAt)
    : getEffectiveEventDate(event);
  const name = getEventName(event, {
    correlationNameMap,
    hookNameMap,
    workflowName,
  });
  const durationKey =
    event.correlationId ?? (isRunLevel(event.eventType) ? '__run__' : '');
  const durationInfo = durationKey ? durationMap.get(durationKey) : undefined;
  const message = getEventMessage(event, { durationInfo, isDuplicate });
  const eventDuration = eventDurationMap.get(event.eventId);
  const zebra = (level === 'default' || level === 'muted') && index % 2 === 1;
  // Tinted rows keep one color throughout.
  const secondaryClass =
    level === 'warning' || level === 'error' ? undefined : 'text-gray-900';

  return (
    <div
      data-event-id={event.eventId}
      role="button"
      tabIndex={isTabStop ? 0 : -1}
      aria-pressed={isSelected}
      onClick={() => onSelect(event)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(event);
        }
      }}
      className={cn(
        'mx-1 mt-px flex h-6 cursor-pointer items-center rounded-md font-mono text-[13px] leading-5 outline-none focus-visible:relative focus-visible:z-10 focus-visible:shadow-[0_0_0_2px_var(--ds-focus-color)]',
        LEVEL_ROW_CLASS[level],
        zebra && 'bg-gray-alpha-100',
        isSelected && LEVEL_SELECTED_CLASS[level]
      )}
    >
      <div className={cn(CELL, COL.level)}>
        <LevelIcon level={level} />
      </div>
      {showSeparateEventOccurrenceTimestamps &&
        (occurredAt ? (
          <TimestampCell date={occurredAt} secondaryClass={secondaryClass} />
        ) : (
          <div className={cn(CELL, COL.time, secondaryClass)}>—</div>
        ))}
      <TimestampCell date={displayedAt} secondaryClass={secondaryClass} />
      <div className={cn(CELL, COL.since, 'tabular-nums', secondaryClass)}>
        {runStartMs !== undefined
          ? formatSinceStart(getEffectiveEventTime(event) - runStartMs)
          : ''}
      </div>
      <div className={cn(CELL, COL.event)}>
        <EventNoticeTooltip notice={notice}>
          <span
            className={cn('truncate', notice && 'line-through')}
            title={event.eventType}
          >
            <HighlightText text={event.eventType} query={highlight} />
          </span>
        </EventNoticeTooltip>
      </div>
      <div className={cn(CELL, COL.name, 'gap-2')} title={name || undefined}>
        <ResourceIcon
          resource={getEventResource(event.eventType)}
          isErrored={
            event.eventType === 'step_failed' ||
            event.eventType === 'run_failed'
          }
          isCancelled={event.eventType === 'run_cancelled'}
        />
        {name ? (
          <span
            className={cn(
              '-mx-1 truncate rounded px-1',
              isRelated && 'bg-blue-100 text-blue-900'
            )}
          >
            <HighlightText text={name} query={highlight} />
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          CELL,
          'min-w-0 flex-1 h-3.5 border-l',
          LEVEL_SEPARATOR_CLASS[level]
        )}
        title={message || undefined}
      >
        <span className="truncate">
          <HighlightText text={message} query={highlight} />
        </span>
      </div>
      <div className={cn(CELL, COL.duration, 'tabular-nums')}>
        {eventDuration !== undefined
          ? formatDurationPrecise(eventDuration)
          : ''}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Details panel
// ──────────────────────────────────────────────────────────────────────────

type TimingSegment = {
  kind: 'queued' | 'failed' | 'backoff' | 'ok' | 'running';
  label: string;
  ms: number;
};

const SEGMENT_COLOR: Record<TimingSegment['kind'], string> = {
  queued: 'bg-gray-400',
  failed: 'bg-amber-700',
  backoff: 'bg-amber-300',
  ok: 'bg-green-700',
  running: 'bg-blue-700',
};

/**
 * Split a step's loaded events into queued → attempt → backoff → attempt…
 * Measured from the events on hand, so a partially loaded log may show a
 * partial breakdown.
 */
function buildStepTiming(
  correlationId: string,
  events: Event[],
  duplicateEventIds: ReadonlySet<string>
): TimingSegment[] {
  const own = events
    .filter(
      (e) =>
        e.correlationId === correlationId && !duplicateEventIds.has(e.eventId)
    )
    .sort((a, b) => getEffectiveEventTime(a) - getEffectiveEventTime(b));
  const segments: TimingSegment[] = [];
  let createdAt: number | undefined;
  let attemptStart: number | undefined;
  let backoffStart: number | undefined;
  let attempt = 0;
  for (const event of own) {
    const ts = getEffectiveEventTime(event);
    switch (event.eventType) {
      case 'step_created':
        createdAt = ts;
        break;
      case 'step_started':
        if (attempt === 0 && createdAt !== undefined) {
          segments.push({
            kind: 'queued',
            label: 'Queued',
            ms: ts - createdAt,
          });
        }
        if (backoffStart !== undefined) {
          segments.push({
            kind: 'backoff',
            label: 'Backoff',
            ms: ts - backoffStart,
          });
          backoffStart = undefined;
        }
        attempt += 1;
        attemptStart = ts;
        break;
      case 'step_retrying':
        if (attemptStart !== undefined) {
          segments.push({
            kind: 'failed',
            label: `Attempt ${attempt} · failed`,
            ms: ts - attemptStart,
          });
        }
        attemptStart = undefined;
        backoffStart = ts;
        break;
      case 'step_completed':
      case 'step_failed':
        if (attemptStart !== undefined) {
          const failed = event.eventType === 'step_failed';
          segments.push({
            kind: failed ? 'failed' : 'ok',
            label: `Attempt ${attempt} · ${failed ? 'failed' : 'ok'}`,
            ms: ts - attemptStart,
          });
        }
        attemptStart = undefined;
        break;
    }
  }
  return segments.filter((segment) => segment.ms > 0);
}

function PanelMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-label-13 text-gray-900">{label}</span>
      <span className="truncate text-label-14 tabular-nums text-gray-1000">
        {value}
      </span>
    </div>
  );
}

function formatShare(value: number, sum: number): string {
  const percent = (value / sum) * 100;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function PayloadView({
  data,
  eventType,
}: {
  data: unknown;
  eventType: string;
}) {
  const cleaned = useMemo(() => deepParseJson(data), [data]);
  return (
    <Collapsible
      defaultOpen
      label="Payload"
      actions={
        <CopyButton
          copyText={serializeForClipboard(cleaned)}
          ariaLabel="Copy payload"
          className="flex h-6 w-6 items-center justify-center rounded-md p-0 hover:bg-gray-alpha-200"
        />
      }
    >
      {eventType === 'attr_set' ? (
        <AttrSetEventBlock data={cleaned} />
      ) : (
        <div className="overflow-x-auto">
          <DataInspector data={cleaned} />
        </div>
      )}
    </Collapsible>
  );
}

interface EventDetailsPanelProps {
  event: Event;
  events: Event[];
  duplicateEventIds: ReadonlySet<string>;
  correlationNameMap: Map<string, string>;
  hookNameMap: Map<string, string>;
  workflowName: string | null;
  eventDurationMap: Map<string, number>;
  runStartMs?: number;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  cachedEventData: unknown | null;
  onCacheEventData: (eventId: string, data: unknown) => void;
  encryptionKey?: Uint8Array;
  onEncryptedDataDetected?: () => void;
  containerRef: RefObject<HTMLElement | null>;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onViewInTrace?: (spanId: string) => void;
}

const EVENT_DETAIL_PANEL_ID = 'event-detail-panel';

/**
 * Right-hand details for the selected event. Mounted with `key={eventId}` so
 * its load state and section toggles reset per event.
 */
function EventDetailsPanel({
  event,
  events,
  duplicateEventIds,
  correlationNameMap,
  hookNameMap,
  workflowName,
  eventDurationMap,
  runStartMs,
  onLoadEventData,
  cachedEventData,
  onCacheEventData,
  encryptionKey,
  onEncryptedDataDetected,
  containerRef,
  onPrev,
  onNext,
  onClose,
  onViewInTrace,
}: EventDetailsPanelProps) {
  // Inline eventData is complete only when the event type has no ref fields
  // (list endpoints strip input/result/error/payload) or there is no loader.
  const inlineIsComplete =
    event.eventData != null &&
    (!onLoadEventData || getEventDataRefFields(event.eventType).length === 0);
  const [data, setData] = useState<unknown | null>(
    cachedEventData ?? (inlineIsComplete ? event.eventData : null)
  );
  const [loading, setLoading] = useState(
    data === null && !!onLoadEventData && !!event.correlationId
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load (or reload once decryption is available) the full payload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the event or key changes
  useEffect(() => {
    if (!onLoadEventData || (inlineIsComplete && !encryptionKey)) return;
    if (data !== null && !encryptionKey) return;
    let cancelled = false;
    setLoadError(null);
    if (data === null) setLoading(true);
    onLoadEventData(event)
      .then((loaded) => {
        if (cancelled || loaded == null) return;
        setData(loaded);
        onCacheEventData(event.eventId, loaded);
        if (!encryptionKey && hasEncryptedValues(loaded)) {
          onEncryptedDataDetected?.();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : 'Failed to load event details'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event.eventId, encryptionKey]);

  const name =
    getEventName(event, { correlationNameMap, hookNameMap, workflowName }) ||
    event.eventType;
  const effectiveDate = getEffectiveEventDate(event);
  const ts = formatTimestampParts(effectiveDate);
  const duration = eventDurationMap.get(event.eventId);
  const occurredAt = parseEventDate(event.occurredAt);
  const createdAt = new Date(event.createdAt);
  const structuredError = extractStructuredError(data, event.eventType);
  const isStep = event.eventType.startsWith('step_') && !!event.correlationId;
  const timing = useMemo(
    () =>
      isStep && event.correlationId
        ? buildStepTiming(event.correlationId, events, duplicateEventIds)
        : [],
    [isStep, event.correlationId, events, duplicateEventIds]
  );
  const timingTotal = timing.reduce((sum, s) => sum + s.ms, 0);
  const rawEvent = useMemo(
    () =>
      serializeForClipboard({ ...event, eventData: data ?? event.eventData }),
    [event, data]
  );

  return (
    <DetailPanelShell
      id={EVENT_DETAIL_PANEL_ID}
      containerRef={containerRef}
      itemLabel="event"
      title={<span className="truncate">{name}</span>}
      headerActions={
        <>
          <CopyButton copyText={rawEvent} ariaLabel="Copy event as JSON" />
          {onViewInTrace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="View in Trace"
                  onClick={() =>
                    onViewInTrace(
                      isRunLevel(event.eventType)
                        ? event.runId
                        : (event.correlationId ?? event.runId)
                    )
                  }
                >
                  <ChartGantt className="h-4 w-4" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>View in Trace</TooltipContent>
            </Tooltip>
          ) : null}
        </>
      }
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
    >
      <div className="@container px-4">
        <Collapsible defaultOpen label="Metrics">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 @sm:grid-cols-3">
              <PanelMetric label="Start" value={`${ts.clock}${ts.ms}`} />
              <PanelMetric
                label="Duration"
                value={
                  duration !== undefined ? formatDurationPrecise(duration) : '—'
                }
              />
              <PanelMetric
                label="Since start"
                value={
                  runStartMs !== undefined
                    ? formatSinceStart(effectiveDate.getTime() - runStartMs)
                    : '—'
                }
              />
            </div>
            {timing.length > 0 && timingTotal > 0 ? (
              <div className="flex flex-col gap-2">
                <PanelMetric
                  label="Time"
                  value={formatDurationPrecise(timingTotal)}
                />
                <div
                  aria-hidden
                  className="flex h-2 gap-0.5 overflow-hidden rounded-full"
                >
                  {timing.map((segment, i) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                      key={i}
                      className={cn(
                        'h-full min-w-1 basis-0',
                        SEGMENT_COLOR[segment.kind]
                      )}
                      style={{ flexGrow: segment.ms }}
                    />
                  ))}
                </div>
                <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {timing.map((segment, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                      key={i}
                      className="flex items-center gap-1.5 text-label-14"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <span
                          aria-hidden
                          className={cn(
                            'block size-2.5 rounded-full',
                            SEGMENT_COLOR[segment.kind]
                          )}
                        />
                      </span>
                      <span className="text-gray-900">{segment.label}</span>
                      <span className="tabular-nums text-gray-1000">
                        {formatDurationPrecise(segment.ms)}
                      </span>
                      <span className="tabular-nums text-gray-700">
                        {formatShare(segment.ms, timingTotal)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Collapsible>

        {structuredError ? (
          <Collapsible defaultOpen label="Error">
            <ErrorStackBlock value={structuredError} />
          </Collapsible>
        ) : null}

        {data != null ? (
          <PayloadView data={data} eventType={event.eventType} />
        ) : loading || loadError ? (
          <Collapsible defaultOpen label="Payload">
            {loadError ? (
              <div className="rounded-md border border-red-400 bg-red-100 px-2 py-1.5 text-copy-13-mono text-red-1000">
                {loadError}
              </div>
            ) : (
              <div className="flex flex-col gap-2 py-1">
                <Skeleton className="h-3" style={{ width: '70%' }} />
                <Skeleton className="h-3" style={{ width: '45%' }} />
              </div>
            )}
          </Collapsible>
        ) : null}

        <Collapsible defaultOpen label="Identifiers">
          <div className="flex flex-col">
            <DetailMonoKeyValueRow
              label="Event ID"
              value={event.eventId}
              copyText={event.eventId}
            />
            {event.correlationId ? (
              <DetailMonoKeyValueRow
                label="Correlation ID"
                value={event.correlationId}
                copyText={event.correlationId}
              />
            ) : null}
            <DetailMonoKeyValueRow
              label="Created"
              value={createdAt.toLocaleString()}
            />
            {occurredAt ? (
              <DetailMonoKeyValueRow
                label="Occurred"
                value={occurredAt.toLocaleString()}
              />
            ) : null}
          </div>
        </Collapsible>
      </div>
    </DetailPanelShell>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Skeleton
// ──────────────────────────────────────────────────────────────────────────

const SKELETON_MESSAGE_WIDTHS = ['40%', '0%', '25%', '55%', '0%', '30%'];

function RowsSkeleton() {
  return (
    <div className="flex-1 overflow-hidden pt-px">
      {Array.from({ length: 18 }, (_, i) => (
        <div
          key={i}
          className={cn(
            'mx-1 mt-px flex h-6 items-center rounded-md',
            i % 2 === 1 && 'bg-gray-alpha-100'
          )}
        >
          <div className={cn(CELL, COL.level)} />
          <div className={cn(CELL, COL.time)}>
            <Skeleton className="h-3 w-[136px]" />
          </div>
          <div className={cn(CELL, COL.since)}>
            <Skeleton className="h-3 w-12" />
          </div>
          <div className={cn(CELL, COL.event)}>
            <Skeleton className="h-3 w-[104px]" />
          </div>
          <div className={cn(CELL, COL.name)}>
            <Skeleton className="h-3 w-24" />
          </div>
          <div className={cn(CELL, 'min-w-0 flex-1')}>
            <Skeleton
              className="h-3"
              style={{
                width:
                  SKELETON_MESSAGE_WIDTHS[i % SKELETON_MESSAGE_WIDTHS.length],
              }}
            />
          </div>
          <div className={cn(CELL, COL.duration)} />
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

interface EventsListProps {
  events: Event[] | null;
  run?: WorkflowRun | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  hasMoreEvents?: boolean;
  isLoadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => Promise<void> | void;
  /** When provided, signals that decryption is active (triggers re-load of expanded events) */
  encryptionKey?: Uint8Array;
  /** When true, shows a loading state instead of "No events found" for empty lists */
  isLoading?: boolean;
  /** Sort order for events. Defaults to 'asc'. */
  sortOrder?: 'asc' | 'desc';
  /** @deprecated The Events tab has no sort control; ignored. */
  onSortOrderChange?: (order: 'asc' | 'desc') => void;
  /** Called when the user clicks the Decrypt button. */
  onDecrypt?: () => void;
  /** Whether the encryption key is currently being fetched. */
  isDecrypting?: boolean;
  /** Whether decryption is unavailable. */
  isDecryptDisabled?: boolean;
  /** Explains why decryption is unavailable. */
  decryptDisabledReason?: string;
  /** Run-level hint: the run contains encrypted data (from probe). */
  hasEncryptedData?: boolean;
  /** Fetch events for an exact correlation or event ID. */
  onExactIdSearch?: (
    id: string,
    kind: ExactWorkflowSearchIdKind,
    signal?: AbortSignal
  ) => Promise<ExactIdSearchResult>;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  /** Shows "View in Trace" in the details panel, with the trace span ID to select. */
  onViewInTrace?: (spanId: string) => void;
}

function groupKeyOf(event: Event): string | undefined {
  return isRunLevel(event.eventType)
    ? '__run__'
    : (event.correlationId ?? undefined);
}

function EventListViewInner({
  events,
  run,
  onLoadEventData,
  hasMoreEvents = false,
  isLoadingMoreEvents = false,
  onLoadMoreEvents,
  encryptionKey,
  isLoading = false,
  sortOrder: effectiveSortOrder = 'asc',
  onDecrypt,
  isDecrypting = false,
  isDecryptDisabled = false,
  decryptDisabledReason,
  hasEncryptedData: hasEncryptedDataProp = false,
  onExactIdSearch,
  showSeparateEventOccurrenceTimestamps = false,
  onViewInTrace,
}: EventsListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Event[] | null>(null);
  const [searchResultsTruncated, setSearchResultsTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchNotFound, setSearchNotFound] = useState(false);
  const searchRequestRef = useRef(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const parsedSearchId = useMemo(
    () => parseExactWorkflowSearchId(searchQuery),
    [searchQuery]
  );
  const isExactSearchActive = searchResults !== null;

  const sortedEvents = useMemo(() => {
    const sourceEvents = isExactSearchActive ? searchResults : (events ?? []);
    if (sourceEvents.length === 0) return [];
    const dir = effectiveSortOrder === 'desc' ? -1 : 1;
    return [...sourceEvents].sort(
      (a, b) => dir * (getEffectiveEventTime(a) - getEffectiveEventTime(b))
    );
  }, [events, effectiveSortOrder, isExactSearchActive, searchResults]);

  // Events every replay reads past as repeats. A page short of the whole log,
  // or an exact-ID search, cannot answer that question, so both classify
  // nothing (see findDuplicateEventIds).
  const duplicateEventIds = useMemo(
    () =>
      findDuplicateEventIds(events ?? [], {
        isCompleteHistory: !hasMoreEvents && !isExactSearchActive,
      }),
    [events, hasMoreEvents, isExactSearchActive]
  );

  // Detect encrypted fields across all loaded events (inline eventData).
  const hasEncryptedInlineData = useMemo(() => {
    const sourceEvents = isExactSearchActive ? searchResults : events;
    if (!sourceEvents) return false;
    for (const event of sourceEvents) {
      const ed = (event as Record<string, unknown>).eventData;
      if (hasEncryptedValues(ed)) return true;
    }
    return false;
  }, [events, isExactSearchActive, searchResults]);

  // Set by the details panel when a loaded payload contains encrypted markers.
  const [foundEncryptedInLazyData, setFoundEncryptedInLazyData] =
    useState(false);
  const handleEncryptedDataDetected = useCallback(() => {
    setFoundEncryptedInLazyData(true);
  }, []);

  const hasEncryptedData =
    hasEncryptedDataProp || hasEncryptedInlineData || foundEncryptedInLazyData;

  const { correlationNameMap, workflowName } = useMemo(
    () =>
      buildNameMaps(
        isExactSearchActive ? searchResults : (events ?? null),
        run ?? null
      ),
    [events, isExactSearchActive, run, searchResults]
  );
  const hookNameMap = useMemo(() => buildHookNameMap(events ?? null), [events]);

  const durationMap = useMemo(
    () => buildDurationMap(sortedEvents, duplicateEventIds),
    [sortedEvents, duplicateEventIds]
  );

  // Anything that isn't a complete ID filters the loaded events as you type,
  // matching what each row shows; complete IDs go to the server instead.
  const textFilter =
    !isExactSearchActive && !parsedSearchId
      ? searchQuery.trim().toLowerCase()
      : '';
  const visibleEvents = useMemo(() => {
    if (!textFilter) return sortedEvents;
    return sortedEvents.filter((event) => {
      const isDuplicate = duplicateEventIds.has(event.eventId);
      const durationKey =
        event.correlationId ?? (isRunLevel(event.eventType) ? '__run__' : '');
      const haystack = [
        event.eventType,
        event.eventId,
        event.correlationId ?? '',
        getEventName(event, { correlationNameMap, hookNameMap, workflowName }),
        getEventMessage(event, {
          durationInfo: durationKey ? durationMap.get(durationKey) : undefined,
          isDuplicate,
        }),
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(textFilter);
    });
  }, [
    textFilter,
    sortedEvents,
    duplicateEventIds,
    correlationNameMap,
    hookNameMap,
    workflowName,
    durationMap,
  ]);
  const eventDurationMap = useMemo(
    () => buildEventDurationMap(events ?? [], duplicateEventIds),
    [events, duplicateEventIds]
  );

  // "Since start" is measured from the run, falling back to the earliest
  // loaded event when the run record isn't available.
  const runStartMs = useMemo(() => {
    const created = parseEventDate(run?.createdAt);
    if (created) return created.getTime();
    let min: number | undefined;
    for (const event of events ?? []) {
      const t = getEffectiveEventTime(event);
      if (min === undefined || t < min) min = t;
    }
    return min;
  }, [run?.createdAt, events]);

  // Selecting an event marks every event of the same step, hook, wait or run.
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const [selectedGroupKey, setSelectedGroupKey] = useState<
    string | undefined
  >();

  const selectEvent = useCallback((event: Event | undefined) => {
    setSelectedEventId(event?.eventId);
    setSelectedGroupKey(event ? groupKeyOf(event) : undefined);
  }, []);
  const toggleSelectedEvent = useCallback(
    (event: Event) => {
      selectEvent(event.eventId === selectedEventId ? undefined : event);
    },
    [selectedEventId, selectEvent]
  );
  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return undefined;
    return (
      sortedEvents.find((e) => e.eventId === selectedEventId) ??
      events?.find((e) => e.eventId === selectedEventId)
    );
  }, [selectedEventId, sortedEvents, events]);

  const bodyRef = useRef<HTMLDivElement>(null);

  // Event data cache: ref avoids re-renders when cache updates
  const eventDataCacheRef = useRef<Map<string, unknown>>(new Map());
  const cacheEventData = useCallback((eventId: string, data: unknown) => {
    eventDataCacheRef.current.set(eventId, data);
  }, []);

  const listItems = useMemo(
    () =>
      buildListItems(visibleEvents, {
        showGaps: !isExactSearchActive && !textFilter,
        hookNameMap,
      }),
    [visibleEvents, isExactSearchActive, textFilter, hookNameMap]
  );

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchRequestRef.current += 1;
      setSearchResults(null);
      setSearchResultsTruncated(false);
      setSearchError(null);
      setSearchLoading(false);
      setSearchNotFound(false);
      setSelectedGroupKey(undefined);
      return;
    }

    const parsed = parseExactWorkflowSearchId(trimmed);
    if (!parsed || !onExactIdSearch) {
      setSearchResults(null);
      setSearchLoading(false);
      setSearchNotFound(false);
      return;
    }

    const requestId = ++searchRequestRef.current;
    setSearchLoading(true);
    setSearchNotFound(false);
    setSearchError(null);

    const abortController = new AbortController();

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await onExactIdSearch(
            parsed.id,
            parsed.kind,
            abortController.signal
          );
          if (
            abortController.signal.aborted ||
            searchRequestRef.current !== requestId
          ) {
            return;
          }

          if (results.status === 'error') {
            setSearchResults([]);
            setSearchResultsTruncated(false);
            setSearchNotFound(false);
            setSearchError(results.message);
            setSelectedGroupKey(undefined);
            return;
          }

          if (
            results.status === 'not_found' ||
            (results.status === 'ok' && results.events.length === 0)
          ) {
            setSearchResults([]);
            setSearchResultsTruncated(false);
            setSearchNotFound(true);
            setSearchError(null);
            setSelectedGroupKey(undefined);
            return;
          }

          setSearchResults(results.events);
          setSearchResultsTruncated(Boolean(results.truncated));
          setSearchNotFound(false);
          setSearchError(null);
          setSelectedGroupKey(
            parsed.kind === 'event' ? groupKeyOf(results.events[0]) : parsed.id
          );
          virtuosoRef.current?.scrollToIndex({
            index: 0,
            align: 'start',
            behavior: 'smooth',
          });
        } catch {
          if (
            abortController.signal.aborted ||
            searchRequestRef.current !== requestId
          ) {
            return;
          }
          setSearchResults([]);
          setSearchResultsTruncated(false);
          setSearchNotFound(false);
          setSearchError('Failed to search events. Try again.');
          setSelectedGroupKey(undefined);
        } finally {
          if (
            searchRequestRef.current === requestId &&
            !abortController.signal.aborted
          ) {
            setSearchLoading(false);
          }
        }
      })();
    }, 300);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [searchQuery, onExactIdSearch]);

  // Track whether we've ever had events to distinguish initial load from refetch
  const hasHadEventsRef = useRef(false);
  if (sortedEvents.length > 0) {
    hasHadEventsRef.current = true;
  }
  const isInitialLoad = isLoading && !hasHadEventsRef.current;
  const isRefetching =
    isLoading && hasHadEventsRef.current && sortedEvents.length === 0;

  const selectedIndex = selectedEventId
    ? visibleEvents.findIndex((ev) => ev.eventId === selectedEventId)
    : -1;

  // Move the selection by one event, keeping the row in view and focused.
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (visibleEvents.length === 0) return;
      const nextIndex =
        selectedIndex === -1
          ? 0
          : Math.min(
              Math.max(selectedIndex + delta, 0),
              visibleEvents.length - 1
            );
      const next = visibleEvents[nextIndex];
      selectEvent(next);
      const itemIndex = listItems.findIndex(
        (item) => item.kind === 'event' && item.event.eventId === next.eventId
      );
      if (itemIndex >= 0) {
        virtuosoRef.current?.scrollIntoView({ index: itemIndex });
      }
      requestAnimationFrame(() => {
        bodyRef.current
          ?.querySelector<HTMLElement>(
            `[data-event-id="${CSS.escape(next.eventId)}"]`
          )
          ?.focus();
      });
    },
    [selectedIndex, selectEvent, visibleEvents, listItems]
  );

  // Up/Down or J/K walk the selection; Escape closes.
  const handleBodyKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && selectedEventId) {
        e.preventDefault();
        selectEvent(undefined);
        return;
      }
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target.closest('aside')) {
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveSelection(-1);
      }
    },
    [selectedEventId, selectEvent, moveSelection]
  );

  const toolbar = (
    <div className="flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100 pl-[34px] pr-2">
      <Search className="h-3.5 w-3.5 shrink-0 text-gray-800" />
      <input
        type="text"
        name="event-list-search"
        aria-label="Search events"
        placeholder="Search events..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && searchQuery) {
            e.preventDefault();
            e.stopPropagation();
            setSearchQuery('');
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800 disabled:cursor-not-allowed disabled:placeholder:text-gray-700"
      />
      {searchQuery ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setSearchQuery('')}
          className="flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent px-1 text-gray-900 hover:text-gray-1000"
        >
          <Kbd variant="outline" size="search">
            Esc
          </Kbd>
        </button>
      ) : null}
      {(hasEncryptedData || encryptionKey) && onDecrypt && (
        <DecryptButton
          decrypted={!!encryptionKey}
          loading={isDecrypting}
          disabled={isDecryptDisabled}
          disabledReason={decryptDisabledReason}
          onClick={onDecrypt}
        />
      )}
    </div>
  );

  if (isInitialLoad) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background-100">
        {toolbar}
        <ListHeader showOccurred={showSeparateEventOccurrenceTimestamps} />
        <RowsSkeleton />
      </div>
    );
  }

  const emptyMessage =
    searchNotFound && searchQuery.trim()
      ? `No events found for ${searchQuery.trim()}`
      : searchError
        ? searchError
        : parsedSearchId && searchQuery.trim() && !onExactIdSearch
          ? 'Exact ID search is unavailable in this view.'
          : textFilter
            ? `No loaded events match "${searchQuery.trim()}"`
            : 'No events found';

  const footerLabel = isExactSearchActive
    ? searchError
      ? searchError
      : searchNotFound
        ? `No events found for ${searchQuery.trim()}`
        : `${sortedEvents.length} event${sortedEvents.length !== 1 ? 's' : ''} for ${searchQuery.trim()}${searchResultsTruncated ? ' (results may be truncated)' : ''}`
    : textFilter
      ? `${visibleEvents.length} of ${sortedEvents.length} ${hasMoreEvents ? 'loaded ' : ''}event${sortedEvents.length !== 1 ? 's' : ''} match`
      : `${sortedEvents.length} event${sortedEvents.length !== 1 ? 's' : ''}${hasMoreEvents ? ' loaded' : ''}`;

  return (
    <DecryptClickContext.Provider
      value={
        onDecrypt
          ? {
              onDecrypt,
              isDecrypting,
              isDecryptDisabled,
              decryptDisabledReason,
            }
          : undefined
      }
    >
      <div className="flex h-full flex-col overflow-hidden bg-background-100">
        {toolbar}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard navigation for the rows inside */}
        <div
          ref={bodyRef}
          className="flex min-h-0 flex-1"
          onKeyDown={handleBodyKeyDown}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <ListHeader showOccurred={showSeparateEventOccurrenceTimestamps} />

            {isRefetching || searchLoading ? (
              <RowsSkeleton />
            ) : visibleEvents.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-copy-14 text-gray-900">
                {emptyMessage}
              </div>
            ) : (
              <Virtuoso
                ref={virtuosoRef}
                totalCount={listItems.length}
                overscan={20}
                defaultItemHeight={25}
                computeItemKey={(i) => {
                  const item = listItems[i];
                  return item.kind === 'gap' ? item.key : item.event.eventId;
                }}
                endReached={() => {
                  if (
                    isExactSearchActive ||
                    !hasMoreEvents ||
                    isLoadingMoreEvents
                  ) {
                    return;
                  }
                  void onLoadMoreEvents?.();
                }}
                components={{ Footer: () => <div className="h-2" /> }}
                itemContent={(i: number) => {
                  const item = listItems[i];
                  if (item.kind === 'gap') {
                    return <IdleGapRow ms={item.ms} reason={item.reason} />;
                  }
                  const ev = item.event;
                  return (
                    <EventRow
                      event={ev}
                      index={item.index}
                      isSelected={selectedEventId === ev.eventId}
                      isTabStop={
                        selectedIndex === -1
                          ? item.index === 0
                          : selectedEventId === ev.eventId
                      }
                      isRelated={
                        selectedGroupKey !== undefined &&
                        groupKeyOf(ev) === selectedGroupKey
                      }
                      onSelect={toggleSelectedEvent}
                      correlationNameMap={correlationNameMap}
                      hookNameMap={hookNameMap}
                      workflowName={workflowName}
                      durationMap={durationMap}
                      eventDurationMap={eventDurationMap}
                      runStartMs={runStartMs}
                      isDuplicate={duplicateEventIds.has(ev.eventId)}
                      highlight={textFilter || undefined}
                      showSeparateEventOccurrenceTimestamps={
                        showSeparateEventOccurrenceTimestamps
                      }
                    />
                  );
                }}
                style={{ flex: 1, minHeight: 0 }}
              />
            )}

            <div className="relative flex h-10 shrink-0 items-center border-t border-gray-alpha-400 px-4 text-label-13 text-gray-900">
              <span>{footerLabel}</span>
              {!isExactSearchActive && hasMoreEvents && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="pointer-events-auto">
                    <LoadMoreButton
                      loading={isLoadingMoreEvents}
                      onClick={() => void onLoadMoreEvents?.()}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {selectedEvent ? (
            <EventDetailsPanel
              key={selectedEvent.eventId}
              event={selectedEvent}
              events={events ?? []}
              duplicateEventIds={duplicateEventIds}
              correlationNameMap={correlationNameMap}
              hookNameMap={hookNameMap}
              workflowName={workflowName}
              eventDurationMap={eventDurationMap}
              runStartMs={runStartMs}
              onLoadEventData={onLoadEventData}
              cachedEventData={
                eventDataCacheRef.current.get(selectedEvent.eventId) ?? null
              }
              onCacheEventData={cacheEventData}
              encryptionKey={encryptionKey}
              onEncryptedDataDetected={handleEncryptedDataDetected}
              containerRef={bodyRef}
              onPrev={selectedIndex > 0 ? () => moveSelection(-1) : undefined}
              onNext={
                selectedIndex >= 0 && selectedIndex < visibleEvents.length - 1
                  ? () => moveSelection(1)
                  : undefined
              }
              onClose={() => selectEvent(undefined)}
              onViewInTrace={onViewInTrace}
            />
          ) : null}
        </div>
      </div>
    </DecryptClickContext.Provider>
  );
}

export function EventListView(props: EventsListProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <ContextCardProvider>
        <EventListViewInner {...props} />
      </ContextCardProvider>
    </TooltipProvider>
  );
}
