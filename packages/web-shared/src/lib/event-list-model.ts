/**
 * Row model for the Events tab: which entity each event belongs to, what its
 * row shows, how long it took, and how the list, its empty state and its
 * footer read for a given search. Pure data in, data out.
 */

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  isHookLifecycleEventType,
  isStepEventType,
  isWaitEventType,
  type WorkflowRun,
} from '@workflow/world';
import { DUPLICATE_EVENT_MESSAGE } from './duplicate-events';
import type { ExactWorkflowSearchId } from './exact-event-search-id';
import { isEncryptedMarker } from './hydration';
import { isSealedNoopEvent, SEALED_EVENT_MESSAGE } from './sealed-events';
import { formatPreciseDuration, getEventDate, parseDate } from './time';

// ──────────────────────────────────────────────────────────────────────────
// Time
// ──────────────────────────────────────────────────────────────────────────

/** Sorts a copy of `events` by when each happened. */
export function sortEventsByTime(
  events: readonly Event[],
  order: 'asc' | 'desc'
): Event[] {
  const dir = order === 'desc' ? -1 : 1;
  return [...events].sort(
    (a, b) => dir * (getEventDate(a).getTime() - getEventDate(b).getTime())
  );
}

/** Concatenates event lists, keeping the first copy of each eventId. */
export function mergeEventsById(...lists: readonly Event[][]): Event[] {
  const seen = new Set<string>();
  const merged: Event[] = [];
  for (const list of lists) {
    for (const event of list) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      merged.push(event);
    }
  }
  return merged;
}

/** Whether a loaded eventData object contains any encrypted marker values. */
export function hasEncryptedValues(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  for (const val of Object.values(data as Record<string, unknown>)) {
    if (isEncryptedMarker(val)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Entity
// ──────────────────────────────────────────────────────────────────────────

export type EventEntityKind = 'run' | 'step' | 'hook' | 'wait';

export interface EventEntity {
  kind: EventEntityKind;
  /**
   * Shared by every event of the same entity: {@link RUN_ENTITY_KEY} for the
   * run, else the correlationId. Null for a child event without one.
   */
  key: string | null;
}

/** Entity key of the run itself. */
const RUN_ENTITY_KEY = '__run__';

function getEntityKind(eventType: string): EventEntityKind {
  if (isStepEventType(eventType)) return 'step';
  if (isWaitEventType(eventType)) return 'wait';
  // hook_conflict is written instead of hook_created when the token is taken,
  // and carries the correlationId of the hook it would have created.
  if (isHookLifecycleEventType(eventType) || eventType === 'hook_conflict') {
    return 'hook';
  }
  // Run lifecycle events, plus attr_set and noop, whose correlationId is a
  // dedup or positional token rather than a child entity ID.
  return 'run';
}

/** The step, hook, wait or run an event belongs to. */
export function getEventEntity(
  event: Pick<Event, 'eventType' | 'correlationId'>
): EventEntity {
  const kind = getEntityKind(event.eventType);
  if (kind === 'run') return { kind, key: RUN_ENTITY_KEY };
  return { kind, key: event.correlationId ?? null };
}

/** The trace viewer's resource kind for an event, for its type icon. */
function getEventResource(event: Event, entity: EventEntity): string {
  // A sealed-slot noop stands for no entity, so it keeps the generic icon.
  if (event.eventType === 'noop') return 'event';
  return entity.kind === 'wait' ? 'sleep' : entity.kind;
}

// ──────────────────────────────────────────────────────────────────────────
// Names
// ──────────────────────────────────────────────────────────────────────────

export interface EventNames {
  /** Step correlationId → parsed step name. */
  correlationNameMap: Map<string, string>;
  /** Hook correlationId → token. */
  hookNameMap: Map<string, string>;
  workflowName: string | null;
}

/**
 * Step names from step_created (or step_started, for a step whose creation
 * the World recorded on its start alone), hook tokens from hook_created, and
 * the workflow name from the run.
 */
export function buildNameMaps(
  events: readonly Event[] | null,
  run: WorkflowRun | null
): EventNames {
  const correlationNameMap = new Map<string, string>();
  const hookNameMap = new Map<string, string>();

  for (const event of events ?? []) {
    if (!event.correlationId) continue;
    if (event.eventType === 'hook_created') {
      // The token is never stripped from a list response.
      const token = (event.eventData as { token?: unknown } | undefined)?.token;
      if (typeof token === 'string')
        hookNameMap.set(event.correlationId, token);
      continue;
    }
    if (
      event.eventType !== 'step_created' &&
      event.eventType !== 'step_started'
    ) {
      continue;
    }
    const stepName = event.eventData?.stepName;
    if (typeof stepName !== 'string') continue;
    if (
      event.eventType === 'step_started' &&
      correlationNameMap.has(event.correlationId)
    ) {
      continue;
    }
    const parsed = parseStepName(stepName) ?? parseWorkflowName(stepName);
    correlationNameMap.set(event.correlationId, parsed?.shortName ?? stepName);
  }

  const workflowName = run?.workflowName
    ? (parseWorkflowName(run.workflowName)?.shortName ?? run.workflowName)
    : null;

  return { correlationNameMap, hookNameMap, workflowName };
}

function getEventName(entity: EventEntity, names: EventNames): string {
  if (entity.kind === 'run') return names.workflowName ?? '';
  if (entity.key === null) return '';
  if (entity.kind === 'hook')
    return names.hookNameMap.get(entity.key) ?? 'hook';
  if (entity.kind === 'wait') return 'sleep';
  return names.correlationNameMap.get(entity.key) ?? '';
}

// ──────────────────────────────────────────────────────────────────────────
// Timing
// ──────────────────────────────────────────────────────────────────────────

export type TimingSegment = {
  kind: 'queued' | 'failed' | 'backoff' | 'ok';
  label: string;
  ms: number;
};

export interface EventTiming {
  /**
   * eventId → how long the attempt, wait or run that this event closes took.
   * A retrying step gets one value per failed attempt, measured from the
   * `step_started` that opened that attempt.
   */
  eventDurations: Map<string, number>;
  /**
   * Entity key → a step's queued, attempt and backoff segments of positive
   * length; none for other entities. Queued runs from created to the first
   * start, which retries do not move. Measured from the events on hand, so a
   * partially loaded log may give a partial breakdown.
   */
  stepSegments: Map<string, TimingSegment[]>;
}

/** One entity's created time, open attempt, wait or run, and step segments. */
interface Clock {
  createdAt?: number;
  openedAt?: number;
  backoffStart?: number;
  attempt: number;
  segments: TimingSegment[];
}

/** The outcome of the step attempt each of these event types closes. */
const ATTEMPT_OUTCOME: Record<string, 'ok' | 'failed'> = {
  step_completed: 'ok',
  step_failed: 'failed',
  step_retrying: 'failed',
};

/**
 * Measures every entity in one chronological pass, so the result does not
 * depend on the caller's sort order.
 *
 * Events every replay reads past as repeats are excluded: a second
 * `step_completed` written by a concurrent replay would otherwise stretch the
 * step's measured runtime to whenever that replay happened to commit. The
 * caller supplies them, because whether an event is a repeat is a property of
 * the whole log and this function may be handed a page of it.
 */
export function buildEventTiming(
  events: readonly Event[],
  duplicateEventIds: ReadonlySet<string> = new Set()
): EventTiming {
  const chronological = events
    .filter((event) => !duplicateEventIds.has(event.eventId))
    .sort((a, b) => getEventDate(a).getTime() - getEventDate(b).getTime());

  const clocks = new Map<string, Clock>();
  const eventDurations = new Map<string, number>();

  for (const event of chronological) {
    const { key } = getEventEntity(event);
    if (key === null) continue;
    const ts = getEventDate(event).getTime();
    const type = event.eventType;
    let clock = clocks.get(key);
    if (!clock) {
      clock = { attempt: 0, segments: [] };
      clocks.set(key, clock);
    }

    switch (type) {
      case 'step_created':
      case 'run_created':
        clock.createdAt ??= ts;
        break;
      case 'step_started':
        if (clock.attempt === 0 && clock.createdAt !== undefined) {
          clock.segments.push({
            kind: 'queued',
            label: 'Queued',
            ms: ts - clock.createdAt,
          });
        }
        if (clock.backoffStart !== undefined) {
          clock.segments.push({
            kind: 'backoff',
            label: 'Backoff',
            ms: ts - clock.backoffStart,
          });
          clock.backoffStart = undefined;
        }
        clock.attempt += 1;
        clock.openedAt = ts;
        break;
      case 'run_started':
      case 'wait_created':
        clock.openedAt = ts;
        break;
      case 'step_completed':
      case 'step_failed':
      case 'step_retrying':
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled':
      case 'wait_completed': {
        if (type === 'step_retrying') clock.backoffStart = ts;
        if (clock.openedAt === undefined) break;
        const ms = ts - clock.openedAt;
        clock.openedAt = undefined;
        eventDurations.set(event.eventId, ms);
        const outcome = ATTEMPT_OUTCOME[type];
        if (outcome) {
          clock.segments.push({
            kind: outcome,
            label: `Attempt ${clock.attempt} · ${outcome}`,
            ms,
          });
        }
        break;
      }
    }
  }

  const stepSegments = new Map<string, TimingSegment[]>();
  for (const [key, clock] of clocks) {
    stepSegments.set(
      key,
      clock.segments.filter((segment) => segment.ms > 0)
    );
  }

  return { eventDurations, stepSegments };
}

// ──────────────────────────────────────────────────────────────────────────
// Level and message
// ──────────────────────────────────────────────────────────────────────────

export type EventLevel = 'default' | 'warning' | 'error' | 'muted';

/**
 * Rows are tinted by level. Only events that need attention get color;
 * everything else stays neutral.
 */
function getEventLevel(event: Event): EventLevel {
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

/**
 * One-line summary from what a list response carries inline. Payload fields
 * (input, result, error, payload) are stripped by `resolveData: 'none'`, so
 * the summary only uses the scalar fields every event keeps.
 */
function getEventMessage(event: Event, queuedMs?: number): string {
  const data = (event.eventData ?? {}) as Record<string, unknown>;
  const attempt = typeof data.attempt === 'number' ? data.attempt : undefined;

  switch (event.eventType) {
    case 'step_started':
      if (attempt && attempt > 1) return `attempt ${attempt}`;
      return queuedMs ? `queued ${formatPreciseDuration(queuedMs)}` : '';
    case 'step_retrying':
      return attempt ? `attempt ${attempt} failed` : 'attempt failed';
    case 'step_failed':
      return attempt ? `failed on attempt ${attempt}` : 'failed';
    case 'run_failed':
      return typeof data.errorCode === 'string' ? data.errorCode : '';
    case 'run_cancelled':
      return typeof data.cancelReason === 'string' ? data.cancelReason : '';
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

export interface EventMessageTime {
  date: Date;
  verbs: [future: string, past: string];
}

function getEventMessageTime(event: Event): EventMessageTime | undefined {
  const data = (event.eventData ?? {}) as Record<string, unknown>;

  if (event.eventType === 'step_retrying') {
    const date = parseDate(data.retryAfter);
    return date ? { date, verbs: ['retries', 'retried'] } : undefined;
  }
  if (event.eventType === 'wait_created') {
    const date = parseDate(data.resumeAt);
    return date ? { date, verbs: ['resumes', 'resumed'] } : undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Rows
// ──────────────────────────────────────────────────────────────────────────

/** Everything an event's row, the text filter and the details panel read. */
export interface EventListLookups {
  names: EventNames;
  timing: EventTiming;
  duplicateEventIds: ReadonlySet<string>;
}

/**
 * Lookups over every event on hand. `duplicateEventIds` is classified by the
 * caller, which knows whether `events` is the whole log.
 */
export function buildEventLookups(
  events: readonly Event[],
  run: WorkflowRun | null,
  duplicateEventIds: ReadonlySet<string>
): EventListLookups {
  return {
    names: buildNameMaps(events, run),
    timing: buildEventTiming(events, duplicateEventIds),
    duplicateEventIds,
  };
}

export interface EventListRow {
  event: Event;
  entity: EventEntity;
  level: EventLevel;
  /** The trace viewer's resource kind, for the type icon. */
  resource: string;
  /** Step name, hook token, `sleep`, or the workflow name; may be empty. */
  name: string;
  message: string;
  /** When the step retries or the wait resumes, shown after the message. */
  messageTime?: EventMessageTime;
  /** Why the row is struck through, when it is. */
  notice?: string;
  /** The step's queued, attempt and backoff breakdown; empty for other events. */
  segments: TimingSegment[];
  durationMs?: number;
}

export function buildEventRow(
  event: Event,
  lookups: EventListLookups
): EventListRow {
  const entity = getEventEntity(event);
  const segments =
    entity.key === null
      ? []
      : (lookups.timing.stepSegments.get(entity.key) ?? []);
  // An event the runtime ignores is muted and struck through, and says why.
  const ignored = lookups.duplicateEventIds.has(event.eventId)
    ? {
        message: 'duplicate, ignored on replay',
        notice: DUPLICATE_EVENT_MESSAGE,
      }
    : isSealedNoopEvent(event)
      ? {
          message: 'sealed slot, never observed by the run',
          notice: SEALED_EVENT_MESSAGE,
        }
      : null;
  return {
    event,
    entity,
    level: ignored ? 'muted' : getEventLevel(event),
    resource: getEventResource(event, entity),
    name: getEventName(entity, lookups.names),
    message:
      ignored?.message ??
      getEventMessage(
        event,
        segments.find((segment) => segment.kind === 'queued')?.ms
      ),
    messageTime: ignored ? undefined : getEventMessageTime(event),
    notice: ignored?.notice,
    segments,
    durationMs: lookups.timing.eventDurations.get(event.eventId),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Idle gaps
// ──────────────────────────────────────────────────────────────────────────

/** A pause this long between consecutive events gets a divider row. */
const IDLE_GAP_MS = 30_000;

export type EventListItem =
  | {
      kind: 'event';
      row: EventListRow;
      index: number;
      sincePreviousMs?: number;
    }
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

/** Rows interleaved, when `showGaps`, with a divider at each idle pause. */
export function buildListItems(
  rows: EventListRow[],
  options: { showGaps: boolean; hookNameMap: Map<string, string> }
): EventListItem[] {
  const items: EventListItem[] = [];
  const isNewestFirst =
    rows.length > 1 &&
    getEventDate(rows[0].event).getTime() >
      getEventDate(rows[rows.length - 1].event).getTime();
  const previousOffset = isNewestFirst ? 1 : -1;
  rows.forEach((row, index) => {
    if (options.showGaps && index > 0) {
      const prev = rows[index - 1].event;
      const event = row.event;
      const a = getEventDate(prev).getTime();
      const b = getEventDate(event).getTime();
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
    const previous = rows[index + previousOffset];
    items.push({
      kind: 'event',
      row,
      index,
      sincePreviousMs: previous
        ? getEventDate(row.event).getTime() -
          getEventDate(previous.event).getTime()
        : undefined,
    });
  });
  return items;
}

// ──────────────────────────────────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────────────────────────────────

/**
 * What the search box is doing. `query` is the trimmed input. A complete
 * ID is looked up on the server; anything else leaves the loaded events as
 * they are, since a local filter would miss events on unloaded pages.
 */
export type EventSearchState =
  | { status: 'idle' }
  | { status: 'incomplete'; query: string }
  | { status: 'unavailable'; query: string }
  | { status: 'loading'; query: string; id: ExactWorkflowSearchId }
  | {
      status: 'ok';
      query: string;
      id: ExactWorkflowSearchId;
      events: Event[];
      truncated: boolean;
    }
  | { status: 'not_found'; query: string; id: ExactWorkflowSearchId }
  | {
      status: 'error';
      query: string;
      id: ExactWorkflowSearchId;
      message?: string;
    };

const NO_EVENTS: Event[] = [];

/**
 * The events the list shows: the run's log, which pages in more as it
 * scrolls, or the events a settled exact-ID search found in its place.
 */
export function getListSource(
  search: EventSearchState,
  log: { events: Event[] | null; hasMore: boolean }
): {
  events: Event[];
  hasMore: boolean;
  /** The run's log, not a search result. */
  isLog: boolean;
} {
  switch (search.status) {
    case 'ok':
      return { events: search.events, hasMore: false, isLog: false };
    case 'not_found':
    case 'error':
      return { events: NO_EVENTS, hasMore: false, isLog: false };
    default:
      return {
        events: log.events ?? NO_EVENTS,
        hasMore: log.hasMore,
        isLog: true,
      };
  }
}

function countEvents(n: number): string {
  return `${n} event${n !== 1 ? 's' : ''}`;
}

/** Shown in place of the list when it has no rows. */
export function getEmptyMessage(search: EventSearchState): string {
  return search.status === 'not_found'
    ? `No events found for ${search.query}`
    : 'No events found';
}

/** Shown under the search box while the query cannot be looked up. */
export function getSearchHint(search: EventSearchState): string | null {
  switch (search.status) {
    case 'incomplete':
      return 'Enter a full step, wait, hook, or event ID to search';
    case 'unavailable':
      return 'Search isn’t available in this view';
    default:
      return null;
  }
}

export function getFooterLabel(
  search: EventSearchState,
  counts: {
    /** Events the list draws its rows from. */
    total: number;
    hasMoreEvents: boolean;
  }
): string | null {
  const { total, hasMoreEvents } = counts;
  switch (search.status) {
    case 'ok':
      return `${countEvents(total)} for ${search.query}${search.truncated ? ' (results may be truncated)' : ''}`;
    case 'loading':
    case 'not_found':
    case 'error':
      return null;
    default:
      return `${countEvents(total)}${hasMoreEvents ? ' loaded' : ''}`;
  }
}
