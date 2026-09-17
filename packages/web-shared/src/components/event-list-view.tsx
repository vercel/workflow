'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import {
  type Event,
  getEventDataRefFields,
  type WorkflowRun,
} from '@workflow/world';
import { format } from 'date-fns';
import { ArrowUpRight, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useReducedMotion } from '../hooks/use-reduced-motion';
import { cn } from '../lib/cn';
import {
  DUPLICATE_EVENT_MESSAGE,
  findDuplicateEventIds,
} from '../lib/duplicate-events';
import {
  type ExactIdSearchResult,
  type ExactWorkflowSearchIdKind,
  looksLikeWorkflowIdSearchInput,
  parseExactWorkflowSearchId,
} from '../lib/exact-event-search-id';
import { isEncryptedMarker } from '../lib/hydration';
import { isSealedNoopEvent, SEALED_EVENT_MESSAGE } from '../lib/sealed-events';
import { useToast } from '../lib/toast';
import { formatDurationPrecise } from '../lib/utils';
import {
  AttrSetEventBlock,
  DetailMonoKeyValueRow,
} from './sidebar/attributes-block';
import { CopyButton } from './trace-viewer/components/copy-button';
import {
  clampPanelWidth,
  computeMaxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  readStoredPanelWidth,
  writeStoredPanelWidth,
} from './trace-viewer/components/detail-panel-width';
import { DraggableBorder } from './trace-viewer/components/draggable-border';
import { useElementWidth } from './trace-viewer/components/use-element-width';
import {
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
} from './ui/collapsible';
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
import { MenuDropdown } from './ui/menu-dropdown';
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

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function formatEventDelta(deltaMs: number): string {
  return deltaMs === 0 ? '0ms' : formatDurationPrecise(deltaMs);
}

function EventTime({
  date,
  previousDeltaMs,
}: {
  date: Date;
  previousDeltaMs?: number;
}): ReactNode {
  return (
    <TimestampTooltip date={date}>
      <span className="inline-flex whitespace-nowrap text-label-13-mono tabular-nums">
        <span className="text-gray-900">
          {format(date, 'MMM dd').toUpperCase()}
        </span>
        <span className="ml-2">
          <span className="text-gray-1000">{format(date, 'HH:mm:ss')}</span>
          <span className="text-gray-900">{format(date, '.SS')}</span>
        </span>
        {previousDeltaMs !== undefined ? (
          <span className="ml-2 text-gray-900">
            +{formatEventDelta(previousDeltaMs)}
          </span>
        ) : null}
      </span>
    </TimestampTooltip>
  );
}

function EventMetadataTime({ date }: { date: Date }): ReactNode {
  return (
    <TimestampTooltip date={date}>
      <span className="whitespace-nowrap text-gray-1000">
        {format(date, 'HH:mm:ss.SSS')}
      </span>
    </TimestampTooltip>
  );
}

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

function formatEventType(eventType: Event['eventType']): string {
  return eventType
    .split('_')
    .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ──────────────────────────────────────────────────────────────────────────
// Event type → status color (small dot only)
// ──────────────────────────────────────────────────────────────────────────

/** Returns a Geist design-token class for the status dot. */
function getStatusDotClass(eventType: string): string {
  // Failed → red
  if (
    eventType === 'step_failed' ||
    eventType === 'run_failed' ||
    eventType === 'workflow_failed'
  ) {
    return 'bg-red-700';
  }
  // Cancelled → amber
  if (eventType === 'run_cancelled') {
    return 'bg-amber-700';
  }
  // Retrying → amber
  if (eventType === 'step_retrying') {
    return 'bg-amber-700';
  }
  // Attribute changes → teal
  if (eventType === 'attr_set') {
    return 'bg-teal-900';
  }
  // Completed/succeeded → green
  if (
    eventType === 'step_completed' ||
    eventType === 'run_completed' ||
    eventType === 'workflow_completed' ||
    eventType === 'hook_disposed' ||
    eventType === 'wait_completed'
  ) {
    return 'bg-green-700';
  }
  // Started/running → blue
  if (
    eventType === 'step_started' ||
    eventType === 'run_started' ||
    eventType === 'workflow_started' ||
    eventType === 'hook_received'
  ) {
    return 'bg-blue-700';
  }
  // Sealed positions → dim gray, one step quieter than pending: the row is
  // log filler the run never observed.
  if (eventType === 'noop') {
    return 'bg-gray-500';
  }
  // Created/pending → gray
  return 'bg-gray-600';
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

  // Map step correlationId (= stepId) → parsed step name from step_created events
  if (events) {
    for (const event of events) {
      if (event.eventType === 'step_created' && event.correlationId) {
        const stepName = event.eventData?.stepName ?? '';
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

interface EventMetadataInfo {
  previousDeltaMs?: number;
  attempt?: number;
}

function buildEventMetadataMap(
  events: Event[],
  canInferAttempts: boolean
): Map<string, EventMetadataInfo> {
  const chronological = [...events].sort(
    (a, b) => getEffectiveEventTime(a) - getEffectiveEventTime(b)
  );
  const attemptsByCorrelation = new Map<string, number>();
  const metadata = new Map<string, EventMetadataInfo>();
  let previousEventTime: number | undefined;

  for (const event of chronological) {
    const eventTime = getEffectiveEventTime(event);
    const eventData =
      event.eventData && typeof event.eventData === 'object'
        ? (event.eventData as Record<string, unknown>)
        : null;
    const explicitAttempt =
      typeof eventData?.attempt === 'number' ? eventData.attempt : undefined;
    let attempt = explicitAttempt;

    if (event.correlationId && event.eventType === 'step_started') {
      if (explicitAttempt !== undefined) {
        attemptsByCorrelation.set(event.correlationId, explicitAttempt);
      } else if (canInferAttempts) {
        attempt = (attemptsByCorrelation.get(event.correlationId) ?? 0) + 1;
        attemptsByCorrelation.set(event.correlationId, attempt);
      }
    } else if (event.correlationId && event.eventType === 'step_retrying') {
      attempt =
        explicitAttempt ??
        (canInferAttempts
          ? attemptsByCorrelation.get(event.correlationId)
          : undefined);
    }

    metadata.set(event.eventId, {
      previousDeltaMs:
        previousEventTime === undefined
          ? undefined
          : Math.max(0, eventTime - previousEventTime),
      attempt,
    });
    previousEventTime = eventTime;
  }

  return metadata;
}

function getEventRetryAfter(event: Event): Date | null {
  const eventRecord = event as Event & { retryAfter?: unknown };
  const eventData =
    event.eventData && typeof event.eventData === 'object'
      ? (event.eventData as Record<string, unknown>)
      : null;
  return parseEventDate(eventRecord.retryAfter ?? eventData?.retryAfter);
}

/** Check if a loaded eventData object contains any encrypted marker values. */
function hasEncryptedValues(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  for (const val of Object.values(data as Record<string, unknown>)) {
    if (isEncryptedMarker(val)) return true;
  }
  return false;
}

function getEventDataCacheKey(
  event: Pick<Event, 'eventId' | 'runId'>,
  encryptionKey?: Uint8Array
): string {
  return `${event.runId}:${event.eventId}:${encryptionKey ? 'decrypted' : 'encrypted'}`;
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
// Copyable cell: shows a copy button on hover
// ──────────────────────────────────────────────────────────────────────────

function CopyableCell({
  value,
  className,
}: {
  value: string;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'group/copy flex min-w-0 items-center gap-1 px-4',
        className
      )}
    >
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {value || '-'}
      </span>
      {value ? (
        <CopyButton
          copyText={value}
          ariaLabel={`Copy ${value}`}
          className="-mr-1 shrink-0 opacity-0 group-hover/row:opacity-100 group-focus-within/copy:opacity-100 focus-visible:opacity-100"
        />
      ) : null}
    </div>
  );
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

function PayloadBlock({
  data,
  eventType,
}: {
  data: unknown;
  eventType?: string;
}): ReactNode {
  const structuredError = useMemo(
    () => extractStructuredError(data, eventType),
    [data, eventType]
  );

  const cleaned = useMemo(() => deepParseJson(data), [data]);

  const formatted = useMemo(() => {
    try {
      return JSON.stringify(cleaned, null, 2);
    } catch {
      return String(cleaned);
    }
  }, [cleaned]);

  if (structuredError) {
    return (
      <div className="p-2">
        <ErrorStackBlock value={structuredError} />
      </div>
    );
  }

  // Attribute changes: render the changed keys and the writer instead of
  // the raw JSON payload.
  if (eventType === 'attr_set') {
    return <AttrSetEventBlock data={cleaned} />;
  }

  // Cancellation reason: render the free-text reason as a readable line
  // instead of a raw JSON payload (the only field run_cancelled carries).
  if (eventType === 'run_cancelled') {
    const cancelReason =
      cleaned != null &&
      typeof cleaned === 'object' &&
      typeof (cleaned as Record<string, unknown>).cancelReason === 'string'
        ? ((cleaned as Record<string, unknown>).cancelReason as string)
        : null;
    if (cancelReason) {
      return (
        <div className="p-2 text-label-12 text-gray-1000">
          <span className="text-gray-900">Reason: </span>
          <span className="whitespace-pre-wrap break-words">
            {cancelReason}
          </span>
        </div>
      );
    }
  }

  return (
    <div className="relative overflow-x-auto p-3 text-gray-1000">
      <CopyButton
        copyText={formatted}
        ariaLabel="Copy payload"
        className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-gray-alpha-400 !bg-background-100 p-0 text-gray-900 transition-transform transition-colors duration-100 hover:bg-gray-200 active:scale-95 active:bg-gray-300"
      />
      <div className="text-[11px]">
        <DataInspector data={cleaned} expandLevel={2} />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sort options for the events list
// ──────────────────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'desc' as const, label: 'Newest' },
  { value: 'asc' as const, label: 'Oldest' },
];

const EVENT_DETAIL_PANEL_ID = 'event-detail-panel';

function RowsSkeleton({
  showSeparateEventOccurrenceTimestamps = false,
}: {
  showSeparateEventOccurrenceTimestamps?: boolean;
}) {
  return (
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: 16 }, (_, i) => (
        <div
          key={i}
          className="flex h-[30px] items-center gap-0 pl-4 shadow-[inset_0_-1px_var(--ds-gray-alpha-400)]"
        >
          {showSeparateEventOccurrenceTimestamps && (
            <div className="min-w-0 flex-[2_1_0%] px-4">
              <Skeleton className="h-3 w-[70%]" />
            </div>
          )}
          {/* Created */}
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-[70%]" />
          </div>
          {/* Event Type */}
          <div className="flex min-w-0 flex-[2_1_0%] items-center gap-1.5 px-4">
            <Skeleton className="size-1.5 shrink-0 rounded-full" />
            <Skeleton className="h-3 w-[60%]" />
          </div>
          {/* Name */}
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-1/2" />
          </div>
          {/* Correlation ID */}
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-3/4" />
          </div>
          {/* Event ID */}
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EventDetailPanel({
  containerWidth,
  isNarrowPanel,
  event,
  metadataInfo,
  durationInfo,
  onLoadEventData,
  cachedEventData,
  onCacheEventData,
  encryptionKey,
  onEncryptedDataDetected,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious,
  hasNext,
  onClose,
  onViewInTrace,
}: {
  containerWidth: number;
  isNarrowPanel: boolean;
  event: Event;
  metadataInfo?: EventMetadataInfo;
  durationInfo?: DurationInfo;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  cachedEventData: unknown | null;
  onCacheEventData: (event: Event, data: unknown) => void;
  encryptionKey?: Uint8Array;
  onEncryptedDataDetected?: () => void;
  onNavigatePrevious: () => void;
  onNavigateNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onClose: () => void;
  onViewInTrace?: () => void;
}): ReactNode {
  const [storedWidth, setStoredWidth] = useState<number>(() =>
    readStoredPanelWidth()
  );
  const asideRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadedEventData, setLoadedEventData] = useState<unknown | null>(
    cachedEventData
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(
    cachedEventData !== null
  );
  const detailRequestIdRef = useRef(0);
  const eventRef = useRef(event);
  eventRef.current = event;
  const previousEncryptionKeyRef = useRef(encryptionKey);
  // List endpoints resolve events with `resolveData: 'none'`, which strips the
  // ref/payload fields (input, result, error, …) and leaves a partial stub
  // (stepName, timings, …). Rendering that stub while the full payload loads
  // flashes an incomplete JSON document whose missing fields pop in after a
  // skeleton, so only trust inline eventData when it can't be a stub: either
  // there is no loader to fetch the full payload, or the event type carries
  // no ref fields (its eventData is never stripped).
  const hasExistingEventData =
    'eventData' in event &&
    event.eventData != null &&
    (!onLoadEventData || getEventDataRefFields(event.eventType).length === 0);

  useEffect(() => {
    if (!isNarrowPanel) return;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isNarrowPanel]);

  const loadEventDetails = useCallback(async () => {
    if (hasAttemptedLoad || loadedEventData !== null) return;
    if (cachedEventData !== null) {
      setLoadedEventData(cachedEventData);
      setHasAttemptedLoad(true);
      return;
    }
    // Inline eventData of a ref-less event type is already complete (ref
    // fields are the only ones ever stripped), so there is nothing to fetch.
    if (hasExistingEventData) {
      setHasAttemptedLoad(true);
      return;
    }
    if (isLoading) return;

    setIsLoading(true);
    setLoadError(null);
    const requestId = ++detailRequestIdRef.current;
    try {
      if (!onLoadEventData) {
        setLoadError('Event details unavailable');
        return;
      }
      const data = await onLoadEventData(event);
      if (data !== null && data !== undefined) {
        onCacheEventData(event, data);
        if (detailRequestIdRef.current !== requestId) return;
        setLoadedEventData(data);
        if (!encryptionKey && hasEncryptedValues(data)) {
          onEncryptedDataDetected?.();
        }
      }
    } catch (error) {
      if (detailRequestIdRef.current !== requestId) return;
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load event details'
      );
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setIsLoading(false);
        setHasAttemptedLoad(true);
      }
    }
  }, [
    cachedEventData,
    encryptionKey,
    event,
    hasAttemptedLoad,
    hasExistingEventData,
    isLoading,
    loadedEventData,
    onCacheEventData,
    onEncryptedDataDetected,
    onLoadEventData,
  ]);

  useEffect(() => {
    if (
      cachedEventData !== null &&
      !encryptionKey &&
      hasEncryptedValues(cachedEventData)
    ) {
      onEncryptedDataDetected?.();
    }
    const timer = window.setTimeout(() => void loadEventDetails(), 120);
    return () => window.clearTimeout(timer);
  }, [
    cachedEventData,
    encryptionKey,
    loadEventDetails,
    onEncryptedDataDetected,
  ]);

  useEffect(() => {
    const encryptionKeyChanged =
      previousEncryptionKeyRef.current !== encryptionKey;
    previousEncryptionKeyRef.current = encryptionKey;
    if (!encryptionKeyChanged || !encryptionKey || !onLoadEventData) return;

    let active = true;
    const eventAtRequest = eventRef.current;
    const requestId = ++detailRequestIdRef.current;
    setIsLoading(false);
    setHasAttemptedLoad(false);
    onLoadEventData(eventAtRequest)
      .then((data) => {
        if (data !== null && data !== undefined) {
          onCacheEventData(eventAtRequest, data);
          if (active && detailRequestIdRef.current === requestId) {
            setLoadedEventData(data);
          }
        }
        if (active && detailRequestIdRef.current === requestId) {
          setHasAttemptedLoad(true);
        }
      })
      .catch(() => {
        if (active && detailRequestIdRef.current === requestId) {
          setHasAttemptedLoad(true);
        }
      });

    return () => {
      active = false;
    };
  }, [encryptionKey, onCacheEventData, onLoadEventData]);

  const mergedEventData =
    loadedEventData ??
    (hasExistingEventData
      ? (event as Event & { eventData: unknown }).eventData
      : null);
  const displayPayload = isLoading ? loadedEventData : mergedEventData;
  const occurredAt = parseEventDate(event.occurredAt);
  const metadataDate = occurredAt ?? new Date(event.createdAt);
  const retryAfter = getEventRetryAfter(event);
  const retryDelayMs = retryAfter
    ? Math.max(0, retryAfter.getTime() - getEffectiveEventTime(event))
    : undefined;
  const retryValue =
    event.eventType === 'step_retrying'
      ? [
          metadataInfo?.attempt
            ? `attempt ${metadataInfo.attempt} failed`
            : 'attempt failed',
          retryDelayMs !== undefined
            ? `next attempt in ${formatDurationPrecise(retryDelayMs)} (backoff)`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const durationsValue = [
    durationInfo?.queued !== undefined
      ? `queued ${formatDurationPrecise(durationInfo.queued)}`
      : null,
    durationInfo?.ran !== undefined
      ? `ran ${formatDurationPrecise(durationInfo.ran)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const handleResize = useCallback(
    (nextWidth: number) => {
      const clampedWidth = clampPanelWidth(nextWidth, containerWidth);
      setStoredWidth(clampedWidth);
      writeStoredPanelWidth(clampedWidth);
    },
    [containerWidth]
  );
  const panelWidth = isNarrowPanel
    ? containerWidth
    : clampPanelWidth(storedWidth, containerWidth);
  const panelMaxWidth = isNarrowPanel
    ? containerWidth
    : Math.max(PANEL_MIN_WIDTH, computeMaxPanelWidth(containerWidth));

  return (
    <TooltipProvider delayDuration={100}>
      <aside
        ref={asideRef}
        id={EVENT_DETAIL_PANEL_ID}
        role={isNarrowPanel ? 'dialog' : undefined}
        aria-label="Event details"
        className="relative flex h-full max-h-full shrink-0 flex-col border-l border-gray-alpha-400 bg-background-100 max-[679px]:absolute max-[679px]:inset-0 max-[679px]:z-10 max-[679px]:border-l-0"
        style={{ width: panelWidth }}
      >
        <div className="max-[679px]:hidden">
          <DraggableBorder
            element={asideRef}
            position="left"
            onWidthChange={handleResize}
            onReset={() => handleResize(PANEL_DEFAULT_WIDTH)}
            aria-label="Resize event details panel"
            aria-controls={EVENT_DETAIL_PANEL_ID}
            aria-valuemin={PANEL_MIN_WIDTH}
            aria-valuemax={panelMaxWidth}
            aria-valuenow={Math.min(
              Math.max(Math.round(panelWidth), PANEL_MIN_WIDTH),
              panelMaxWidth
            )}
          />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-[7.5px]">
          <span className="block truncate text-label-14 text-gray-1000">
            {formatEventType(event.eventType)}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Navigate up"
                  aria-keyshortcuts="K"
                  onClick={onNavigatePrevious}
                  disabled={!hasPrevious}
                >
                  <ChevronUp className="size-4" />
                </IconButton>
              </TooltipTrigger>
              {hasPrevious ? (
                <TooltipContent>
                  Navigate up
                  <Kbd>K</Kbd>
                </TooltipContent>
              ) : null}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label="Navigate down"
                  aria-keyshortcuts="J"
                  onClick={onNavigateNext}
                  disabled={!hasNext}
                >
                  <ChevronDown className="size-4" />
                </IconButton>
              </TooltipTrigger>
              {hasNext ? (
                <TooltipContent>
                  Navigate down
                  <Kbd>J</Kbd>
                </TooltipContent>
              ) : null}
            </Tooltip>
            <div aria-hidden className="mx-1 h-4 w-px bg-gray-alpha-400" />
            <IconButton
              ref={closeButtonRef}
              aria-label="Close event details"
              aria-keyshortcuts="Escape"
              onClick={onClose}
            >
              <X className="size-4" />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-gray-alpha-400">
          <div className="px-4">
            <CollapsibleRoot defaultOpen>
              <CollapsibleTrigger>Metadata</CollapsibleTrigger>
              <CollapsibleContent className="mb-2 mt-0">
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
                    label={occurredAt ? 'Occurred' : 'Created'}
                    value={<EventMetadataTime date={metadataDate} />}
                  />
                  {retryValue ? (
                    <DetailMonoKeyValueRow label="Retry" value={retryValue} />
                  ) : null}
                  {durationsValue ? (
                    <DetailMonoKeyValueRow
                      label="Durations"
                      value={durationsValue}
                    />
                  ) : null}
                </div>
              </CollapsibleContent>
            </CollapsibleRoot>
            {onViewInTrace ? (
              <button
                type="button"
                onClick={onViewInTrace}
                className="mb-3 inline-flex h-10 items-center gap-1.5 rounded-md border border-gray-alpha-400 bg-background-100 px-3 text-button-14 text-gray-1000 transition-colors hover:bg-gray-100"
              >
                View in trace
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="border-t border-gray-alpha-400">
            {displayPayload != null ? (
              <PayloadBlock data={displayPayload} eventType={event.eventType} />
            ) : loadError ? (
              <div className="m-3 rounded-md border border-red-400 bg-red-100 p-3 text-label-12 text-red-900">
                {loadError}
              </div>
            ) : isLoading || !hasAttemptedLoad ? (
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ) : (
              <div className="p-4 text-label-12 text-gray-1000">No data</div>
            )}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Event row
// ──────────────────────────────────────────────────────────────────────────

interface EventsListProps {
  events: Event[] | null;
  run?: WorkflowRun | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  hasMoreEvents?: boolean;
  isLoadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => Promise<void> | void;
  /** When provided, signals that decryption is active for selected event details. */
  encryptionKey?: Uint8Array;
  /** When true, shows a loading state instead of "No events found" for empty lists */
  isLoading?: boolean;
  /** Sort order for events. Defaults to 'asc'. */
  sortOrder?: 'asc' | 'desc';
  /** Called when the user changes sort order. When provided, the sort dropdown is shown
   *  and the parent is expected to refetch from the API with the new order. */
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
  /** Opens the trace viewer. */
  onViewInTrace?: () => void;
}

export function EventRow({
  event,
  isSelected,
  activeGroupKey,
  correlationNameMap,
  workflowName,
  onSelectEvent,
  onHoverGroup,
  onFocusEvent,
  previousDeltaMs,
  suppressGroupDimming = false,
  showSeparateEventOccurrenceTimestamps = false,
  isDuplicate = false,
}: {
  event: Event;
  isSelected: boolean;
  activeGroupKey?: string;
  correlationNameMap: Map<string, string>;
  workflowName: string | null;
  onSelectEvent: (eventId: string) => void;
  onHoverGroup: (groupKey: string | undefined) => void;
  onFocusEvent?: (eventId: string) => void;
  previousDeltaMs?: number;
  /** Exact-ID search results should not dim unrelated rows. */
  suppressGroupDimming?: boolean;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
  /** The event repeats a class already in the log, so the runtime ignored it. */
  isDuplicate?: boolean;
}) {
  const rowGroupKey = isRunLevel(event.eventType)
    ? '__run__'
    : (event.correlationId ?? undefined);

  const isSealed = isSealedNoopEvent(event);
  const rowNotice = isDuplicate
    ? DUPLICATE_EVENT_MESSAGE
    : isSealed
      ? SEALED_EVENT_MESSAGE
      : undefined;
  const createdAt = new Date(event.createdAt);
  const occurredAt = parseEventDate(event.occurredAt);
  const displayedCreatedAt = showSeparateEventOccurrenceTimestamps
    ? createdAt
    : getEffectiveEventDate(event);
  const isRun = isRunLevel(event.eventType);
  const eventName = isRun
    ? (workflowName ?? '-')
    : event.correlationId
      ? (correlationNameMap.get(event.correlationId) ?? '-')
      : '-';

  const hasActive = activeGroupKey !== undefined;
  const isRelated = rowGroupKey !== undefined && rowGroupKey === activeGroupKey;
  const isDimmed = hasActive && !isRelated && !suppressGroupDimming;
  const statusDotClass = isDimmed
    ? 'bg-gray-900'
    : getStatusDotClass(event.eventType);

  const handleRowClick = useCallback(() => {
    onSelectEvent(event.eventId);
  }, [event.eventId, onSelectEvent]);

  return (
    <div
      data-event-id={event.eventId}
      onMouseEnter={() => onHoverGroup(rowGroupKey)}
      onMouseLeave={() => onHoverGroup(undefined)}
      className="shadow-[inset_0_-1px_var(--ds-gray-alpha-400)]"
    >
      {/* Row */}
      <div
        data-event-row-id={event.eventId}
        role="button"
        tabIndex={0}
        aria-expanded={isSelected}
        aria-controls={isSelected ? EVENT_DETAIL_PANEL_ID : undefined}
        aria-keyshortcuts="J K ArrowUp ArrowDown"
        onClick={handleRowClick}
        onFocus={() => onFocusEvent?.(event.eventId)}
        onKeyDown={(e) => {
          if (
            e.target === e.currentTarget &&
            (e.key === 'Enter' || e.key === ' ')
          ) {
            e.preventDefault();
            handleRowClick();
          }
        }}
        className={cn(
          'group/row flex h-[30px] w-full cursor-pointer items-center gap-0 pl-4 text-left text-label-14',
          isSelected
            ? 'bg-gray-100 hover:bg-gray-200 focus-visible:bg-gray-200'
            : 'hover:bg-gray-100 focus-visible:bg-gray-100'
        )}
      >
        {/* Content area: mutes when unrelated */}
        <div
          className={`flex min-w-0 flex-1 items-center transition-colors ${
            isDimmed ? 'text-gray-900' : 'text-gray-1000'
          }`}
        >
          {showSeparateEventOccurrenceTimestamps && (
            <div className="min-w-0 flex-[2_1_0%] overflow-hidden px-4">
              {occurredAt ? (
                <EventTime
                  date={occurredAt}
                  previousDeltaMs={previousDeltaMs}
                />
              ) : (
                '-'
              )}
            </div>
          )}

          {/* Created */}
          <div className="min-w-0 flex-[2_1_0%] overflow-hidden px-4">
            <EventTime
              date={displayedCreatedAt}
              previousDeltaMs={
                showSeparateEventOccurrenceTimestamps
                  ? undefined
                  : previousDeltaMs
              }
            />
          </div>

          {/* Event Type */}
          <div className="min-w-0 flex-[2_1_0%] overflow-hidden px-4">
            <EventNoticeTooltip notice={rowNotice}>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  rowNotice ? 'text-gray-700' : 'text-gray-1000'
                )}
              >
                <span className="relative inline-flex size-1.5 shrink-0">
                  <span
                    className={cn(
                      'relative size-1.5 rounded-full',
                      statusDotClass
                    )}
                  />
                </span>
                {formatEventType(event.eventType)}
              </span>
            </EventNoticeTooltip>
          </div>

          {/* Name */}
          <div className="min-w-0 flex-[2_1_0%] overflow-hidden text-ellipsis whitespace-nowrap px-4">
            {eventName}
          </div>

          {/* Correlation ID */}
          <CopyableCell
            value={event.correlationId || ''}
            className="flex-[3_1_0%] text-label-13-mono"
          />

          {/* Event ID */}
          <CopyableCell
            value={event.eventId}
            className="flex-[3_1_0%] text-label-13-mono"
          />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

function EventListViewInner({
  events,
  run,
  onLoadEventData,
  hasMoreEvents = false,
  isLoadingMoreEvents = false,
  onLoadMoreEvents,
  encryptionKey,
  isLoading = false,
  sortOrder: sortOrderProp,
  onSortOrderChange,
  onDecrypt,
  isDecrypting = false,
  isDecryptDisabled = false,
  decryptDisabledReason,
  hasEncryptedData: hasEncryptedDataProp = false,
  onExactIdSearch,
  showSeparateEventOccurrenceTimestamps = false,
  onViewInTrace,
}: EventsListProps) {
  const toast = useToast();
  const reducedMotion = useReducedMotion();
  const [internalSortOrder, setInternalSortOrder] = useState<'asc' | 'desc'>(
    'asc'
  );
  const effectiveSortOrder = sortOrderProp ?? internalSortOrder;
  const handleSortOrderChange = useCallback(
    (order: 'asc' | 'desc') => {
      if (onSortOrderChange) {
        onSortOrderChange(order);
      } else {
        setInternalSortOrder(order);
      }
    },
    [onSortOrderChange]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Event[] | null>(null);
  const [searchResultsTruncated, setSearchResultsTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchNotFound, setSearchNotFound] = useState(false);
  const searchRequestRef = useRef(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const eventListRootRef = useRef<HTMLDivElement>(null);
  const eventListWidth = useElementWidth(eventListRootRef);
  const isNarrowPanel = eventListWidth > 0 && eventListWidth < 680;
  const navigationRequestRef = useRef(0);

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

  const eventIds = useMemo(
    () => sortedEvents.map((event) => event.eventId),
    [sortedEvents]
  );
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const selectedEventIdRef = useRef(selectedEventId);
  selectedEventIdRef.current = selectedEventId;

  useEffect(() => {
    if (activeEventId && !eventIds.includes(activeEventId)) {
      navigationRequestRef.current += 1;
      setActiveEventId(null);
    }
  }, [activeEventId, eventIds]);

  const focusEventRow = useCallback((eventId: string) => {
    const rows =
      eventListRootRef.current?.querySelectorAll<HTMLElement>(
        '[data-event-row-id]'
      ) ?? [];
    for (const row of rows) {
      if (row.dataset.eventRowId === eventId) {
        row.focus({ preventScroll: true });
        return;
      }
    }
  }, []);

  const navigateToEvent = useCallback(
    (eventId: string) => {
      const index = eventIds.indexOf(eventId);
      if (index === -1) return;

      setActiveEventId(eventId);
      const requestId = ++navigationRequestRef.current;
      const focusTarget = () => {
        if (navigationRequestRef.current === requestId) {
          focusEventRow(eventId);
        }
      };

      const virtuoso = virtuosoRef.current;
      if (!virtuoso) {
        focusTarget();
        return;
      }

      virtuoso.scrollIntoView({
        index,
        behavior: reducedMotion ? 'auto' : 'smooth',
        done: focusTarget,
      });
    },
    [eventIds, focusEventRow, reducedMotion]
  );

  // Events every replay reads past as repeats. Computed from the source list
  // rather than `sortedEvents` because which occurrence counted is a property
  // of the log, not of the direction the table happens to be sorted in.
  //
  // A page short of the whole log, or an exact-ID search that returns one
  // event, cannot answer that question: the event a repeat lost to may be
  // outside the window, and reading it the other way round would mark the
  // event the run acted on and drop it from the durations. Both cases classify
  // nothing.
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

  // Tracks whether loaded event details contained encrypted markers.
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

  const durationMap = useMemo(
    () => buildDurationMap(sortedEvents, duplicateEventIds),
    [sortedEvents, duplicateEventIds]
  );
  const eventMetadataMap = useMemo(
    () =>
      buildEventMetadataMap(
        sortedEvents,
        !hasMoreEvents && !isExactSearchActive
      ),
    [hasMoreEvents, isExactSearchActive, sortedEvents]
  );

  const [selectedGroupKey, setSelectedGroupKey] = useState<string | undefined>(
    undefined
  );
  const [hoveredGroupKey, setHoveredGroupKey] = useState<string | undefined>(
    undefined
  );
  const onHoverGroup = useCallback((groupKey: string | undefined) => {
    setHoveredGroupKey(groupKey);
  }, []);

  const activeGroupKey = selectedGroupKey ?? hoveredGroupKey;

  // Event data cache: ref avoids re-renders when cache updates
  const eventDataCacheRef = useRef<Map<string, unknown>>(new Map());
  const eventDataRequestCacheRef = useRef<Map<string, Promise<unknown | null>>>(
    new Map()
  );
  const cacheEventData = useCallback(
    (event: Event, data: unknown) => {
      eventDataCacheRef.current.set(
        getEventDataCacheKey(event, encryptionKey),
        data
      );
    },
    [encryptionKey]
  );
  const loadEventData = useCallback(
    (event: Event): Promise<unknown | null> => {
      if (!onLoadEventData) return Promise.resolve(null);

      const cacheKey = getEventDataCacheKey(event, encryptionKey);
      if (eventDataCacheRef.current.has(cacheKey)) {
        return Promise.resolve(eventDataCacheRef.current.get(cacheKey) ?? null);
      }
      const pendingRequest = eventDataRequestCacheRef.current.get(cacheKey);
      if (pendingRequest) return pendingRequest;

      const request = onLoadEventData(event);
      eventDataRequestCacheRef.current.set(cacheKey, request);
      const clearRequest = () => {
        if (eventDataRequestCacheRef.current.get(cacheKey) === request) {
          eventDataRequestCacheRef.current.delete(cacheKey);
        }
      };
      void request.then(clearRequest, clearRequest);
      return request;
    },
    [encryptionKey, onLoadEventData]
  );

  // Lookup from eventId → groupKey for selected-row correlation highlighting.
  const eventGroupKeyMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of sortedEvents) {
      const gk = isRunLevel(ev.eventType)
        ? '__run__'
        : (ev.correlationId ?? '');
      if (gk) map.set(ev.eventId, gk);
    }
    return map;
  }, [sortedEvents]);

  const selectedEventIndex = selectedEventId
    ? eventIds.indexOf(selectedEventId)
    : -1;
  const selectedEvent =
    selectedEventIndex === -1 ? null : sortedEvents[selectedEventIndex];
  const selectedDurationKey = selectedEvent
    ? (selectedEvent.correlationId ??
      (isRunLevel(selectedEvent.eventType) ? '__run__' : ''))
    : '';
  const selectedDurationInfo = selectedDurationKey
    ? durationMap.get(selectedDurationKey)
    : undefined;
  const previousEventId =
    selectedEventIndex > 0 ? eventIds[selectedEventIndex - 1] : null;
  const nextEventId =
    selectedEventIndex >= 0 ? (eventIds[selectedEventIndex + 1] ?? null) : null;

  const showEventDetails = useCallback(
    (eventId: string) => {
      if (!eventIds.includes(eventId)) return;
      setSelectedEventId(eventId);
      setSelectedGroupKey(eventGroupKeyMap.get(eventId));
    },
    [eventGroupKeyMap, eventIds]
  );

  const closeEventDetails = useCallback(() => {
    const eventId = selectedEventId;
    setSelectedEventId(null);
    setSelectedGroupKey(undefined);
    if (eventId) {
      requestAnimationFrame(() => navigateToEvent(eventId));
    }
  }, [navigateToEvent, selectedEventId]);

  useEffect(() => {
    if (selectedEventId && !eventIds.includes(selectedEventId)) {
      closeEventDetails();
    }
  }, [closeEventDetails, eventIds, selectedEventId]);

  const handleSelectEvent = useCallback(
    (eventId: string) => {
      setActiveEventId(eventId);
      if (selectedEventId === eventId) {
        closeEventDetails();
      } else {
        showEventDetails(eventId);
      }
    },
    [closeEventDetails, selectedEventId, showEventDetails]
  );

  const navigateToEventDetails = useCallback(
    (eventId: string) => {
      showEventDetails(eventId);
      navigateToEvent(eventId);
    },
    [navigateToEvent, showEventDetails]
  );

  useEffect(() => {
    if (!activeEventId) return;

    const activeIndex = eventIds.indexOf(activeEventId);
    if (activeIndex === -1) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.key !== 'j' &&
          event.key !== 'k' &&
          event.key !== 'ArrowDown' &&
          event.key !== 'ArrowUp') ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const isEventRow = target.hasAttribute('data-event-row-id');
      const isEventPanel = Boolean(target.closest(`#${EVENT_DETAIL_PANEL_ID}`));
      if (!isEventRow && !isEventPanel) return;

      const offset = event.key === 'k' || event.key === 'ArrowUp' ? -1 : 1;
      const currentIndex = isEventPanel ? selectedEventIndex : activeIndex;
      const targetId = eventIds[currentIndex + offset];
      if (!targetId) return;

      event.preventDefault();
      if (isEventPanel || selectedEventId) {
        navigateToEventDetails(targetId);
      } else {
        navigateToEvent(targetId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeEventId,
    eventIds,
    navigateToEvent,
    navigateToEventDetails,
    selectedEventIndex,
    selectedEventId,
  ]);

  useEffect(() => {
    if (!selectedEventId) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        !(target instanceof Node) ||
        !eventListRootRef.current?.contains(target)
      ) {
        return;
      }
      closeEventDetails();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeEventDetails, selectedEventId]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchRequestRef.current += 1;
      setSearchResults(null);
      setSearchResultsTruncated(false);
      setSearchError(null);
      setSearchLoading(false);
      setSearchNotFound(false);
      if (!selectedEventIdRef.current) setSelectedGroupKey(undefined);
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
            parsed.kind === 'event'
              ? (() => {
                  const first = results.events[0];
                  if (!first) return undefined;
                  return isRunLevel(first.eventType)
                    ? '__run__'
                    : (first.correlationId ?? undefined);
                })()
              : parsed.id
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

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape' && searchQuery) {
        event.preventDefault();
        event.stopPropagation();
        setSearchQuery('');
        return;
      }

      if (event.key !== 'Enter') {
        return;
      }

      const trimmed = searchQuery.trim();
      if (
        !trimmed ||
        parseExactWorkflowSearchId(trimmed) ||
        !onExactIdSearch ||
        !looksLikeWorkflowIdSearchInput(trimmed)
      ) {
        return;
      }

      toast.info('Enter a full step ID, wait ID, hook ID, or event ID');
    },
    [searchQuery, onExactIdSearch, toast]
  );

  // Track whether we've ever had events to distinguish initial load from refetch
  const hasHadEventsRef = useRef(false);
  if (sortedEvents.length > 0) {
    hasHadEventsRef.current = true;
  }
  const isInitialLoad = isLoading && !hasHadEventsRef.current;
  const isRefetching =
    isLoading && hasHadEventsRef.current && sortedEvents.length === 0;

  if (isInitialLoad) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-100">
        {/* Skeleton search bar */}
        <div className="flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100">
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-4 pr-2">
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-3.5 w-64 max-w-[60%]" />
          </div>
          <Skeleton className="h-10 w-24 shrink-0 rounded-md" />
        </div>
        {/* Skeleton header */}
        <div className="flex h-10 flex-shrink-0 items-center gap-0 border-b border-gray-alpha-400">
          <div className="w-4 shrink-0" />
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-18" />
          </div>
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-11" />
          </div>
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-23" />
          </div>
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-15" />
          </div>
        </div>
        <RowsSkeleton />
      </div>
    );
  }

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
      <div
        ref={eventListRootRef}
        onBlurCapture={() => {
          navigationRequestRef.current += 1;
        }}
        className="relative flex h-full min-h-0 w-full overflow-hidden bg-background-100"
      >
        <div
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
          inert={selectedEvent && isNarrowPanel ? true : undefined}
        >
          {/* Search bar + sort */}
          <div className="flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-gray-alpha-400 bg-background-100">
            <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-4 pr-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-gray-800" />
              <input
                id="event-list-search"
                name="event-list-search"
                type="text"
                placeholder="Search events..."
                aria-label="Search events"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                disabled={!onExactIdSearch}
                className="min-w-0 flex-1 bg-transparent text-label-14 text-gray-1000 outline-none placeholder:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-900 disabled:placeholder:text-gray-900"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery('')}
                  className="-mr-2 hidden h-full max-w-full shrink-0 cursor-pointer items-center rounded-r-md border-0 bg-transparent px-2.5 font-[inherit] text-label-16 text-gray-900 no-underline transition-colors duration-150 ease-in hover:text-gray-1000 focus-visible:-outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ds-focus-color)] min-[961px]:flex"
                >
                  <Kbd variant="outline" size="search">
                    Esc
                  </Kbd>
                </button>
              )}
            </div>
            <MenuDropdown
              options={SORT_OPTIONS}
              value={effectiveSortOrder}
              onChange={handleSortOrderChange}
            />
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

          {/* Header */}
          <div className="flex h-10 flex-shrink-0 items-center gap-0 border-b border-gray-alpha-400 bg-background-100 text-label-13 text-gray-900">
            <div className="w-4 shrink-0" />
            {showSeparateEventOccurrenceTimestamps && (
              <div className="min-w-0 flex-[2_1_0%] px-4">Occurred</div>
            )}
            <div className="min-w-0 flex-[2_1_0%] px-4">Created</div>
            <div className="min-w-0 flex-[2_1_0%] px-4">Event Type</div>
            <div className="min-w-0 flex-[2_1_0%] px-4">Name</div>
            <div className="min-w-0 flex-[3_1_0%] px-4">Correlation ID</div>
            <div className="min-w-0 flex-[3_1_0%] px-4">Event ID</div>
          </div>

          {/* Virtualized event rows or refetching skeleton */}
          {isRefetching || searchLoading ? (
            <RowsSkeleton
              showSeparateEventOccurrenceTimestamps={
                showSeparateEventOccurrenceTimestamps
              }
            />
          ) : sortedEvents.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-copy-14 text-gray-700">
              {searchNotFound && searchQuery.trim()
                ? `No events found for ${searchQuery.trim()}`
                : searchError
                  ? searchError
                  : parsedSearchId && searchQuery.trim() && !onExactIdSearch
                    ? 'Exact ID search is unavailable in this view.'
                    : 'No events found'}
            </div>
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              totalCount={sortedEvents.length}
              computeItemKey={(index) => sortedEvents[index].eventId}
              overscan={20}
              defaultItemHeight={30}
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
              itemContent={(index: number) => {
                const ev = sortedEvents[index];
                return (
                  <EventRow
                    event={ev}
                    isSelected={selectedEventId === ev.eventId}
                    activeGroupKey={activeGroupKey}
                    correlationNameMap={correlationNameMap}
                    workflowName={workflowName}
                    onSelectEvent={handleSelectEvent}
                    onHoverGroup={onHoverGroup}
                    onFocusEvent={setActiveEventId}
                    previousDeltaMs={
                      eventMetadataMap.get(ev.eventId)?.previousDeltaMs
                    }
                    suppressGroupDimming={isExactSearchActive}
                    isDuplicate={duplicateEventIds.has(ev.eventId)}
                    showSeparateEventOccurrenceTimestamps={
                      showSeparateEventOccurrenceTimestamps
                    }
                  />
                );
              }}
              className="min-h-0 flex-1"
            />
          )}

          {/* Fixed footer: count + load more */}
          <div className="relative flex h-10 flex-shrink-0 items-center border-t border-gray-alpha-400 bg-background-100 px-4 text-label-12 text-gray-900">
            <span>
              {isExactSearchActive
                ? searchError
                  ? searchError
                  : searchNotFound
                    ? `No events found for ${searchQuery.trim()}`
                    : `${sortedEvents.length} event${sortedEvents.length !== 1 ? 's' : ''} for ${searchQuery.trim()}${searchResultsTruncated ? ' (results may be truncated)' : ''}`
                : `${sortedEvents.length} event${sortedEvents.length !== 1 ? 's' : ''} loaded`}
            </span>
            {!isExactSearchActive && hasMoreEvents && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
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
          <EventDetailPanel
            key={selectedEvent.eventId}
            containerWidth={eventListWidth}
            isNarrowPanel={isNarrowPanel}
            event={selectedEvent}
            metadataInfo={eventMetadataMap.get(selectedEvent.eventId)}
            durationInfo={selectedDurationInfo}
            onLoadEventData={onLoadEventData ? loadEventData : undefined}
            cachedEventData={
              eventDataCacheRef.current.get(
                getEventDataCacheKey(selectedEvent, encryptionKey)
              ) ?? null
            }
            onCacheEventData={cacheEventData}
            encryptionKey={encryptionKey}
            onEncryptedDataDetected={handleEncryptedDataDetected}
            onNavigatePrevious={() => {
              if (previousEventId) navigateToEventDetails(previousEventId);
            }}
            onNavigateNext={() => {
              if (nextEventId) navigateToEventDetails(nextEventId);
            }}
            hasPrevious={previousEventId !== null}
            hasNext={nextEventId !== null}
            onClose={closeEventDetails}
            onViewInTrace={onViewInTrace}
          />
        ) : null}
      </div>
    </DecryptClickContext.Provider>
  );
}

export function EventListView(props: EventsListProps) {
  const runId = props.run?.runId ?? props.events?.[0]?.runId ?? 'events';
  return (
    <ContextCardProvider>
      <EventListViewInner key={runId} {...props} />
    </ContextCardProvider>
  );
}
