'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, WorkflowRun } from '@workflow/world';
import { Check, ChevronRight, Copy } from 'lucide-react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { cn } from '../lib/cn';
import {
  type ExactIdSearchResult,
  type ExactWorkflowSearchIdKind,
  looksLikeWorkflowIdSearchInput,
  parseExactWorkflowSearchId,
} from '../lib/exact-event-search-id';
import { isEncryptedMarker } from '../lib/hydration';
import { useToast } from '../lib/toast';
import { formatDuration } from '../lib/utils';
import { AttrSetEventBlock } from './sidebar/attributes-block';
import { ContextCardProvider } from './ui/context-card';
import { DataInspector, DecryptClickContext } from './ui/data-inspector';
import { DecryptButton } from './ui/decrypt-button';
import {
  ErrorStackBlock,
  isStructuredError,
  type StructuredErrorRecord,
} from './ui/error-stack-block';
import { LoadMoreButton } from './ui/load-more-button';
import { MenuDropdown } from './ui/menu-dropdown';
import { Skeleton } from './ui/skeleton';
import { TimestampTooltip } from './ui/timestamp-tooltip';

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

function formatEventTime(date: Date): string {
  return (
    date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) +
    '.' +
    date.getMilliseconds().toString().padStart(3, '0')
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

/** Returns a Geist theme utility for the status dot. */
function getStatusDotClassName(eventType: string): string {
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
  // Created/pending → gray
  return 'bg-gray-600';
}

/**
 * Build a map from correlationId (stepId) → display name using step_created
 * events, and parse the workflow name from the run.
 */
function buildNameMaps(
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
        const parsed = parseStepName(String(stepName));
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
 */
export function buildDurationMap(events: Event[]): Map<string, DurationInfo> {
  // Process events in chronological order so the result doesn't depend on
  // the caller's sort direction. Retried steps emit multiple `step_started`
  // events for the same correlationId; the queued duration must be measured
  // against the first one, not the last.
  const chronological = [...events].sort(
    (a, b) => getEffectiveEventTime(a) - getEffectiveEventTime(b)
  );

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
      // The queued duration is anchored on the first start event only —
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
    // attr_set carries a dedup correlationId rather than a child entity ID,
    // so it groups and labels with the run itself.
    eventType === 'attr_set'
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tree gutter — fixed-width, shows branch lines only for the selected group
// ──────────────────────────────────────────────────────────────────────────

function TreeGutter({
  isFirst,
  isLast,
  isRunLevel: isRun,
  statusDotClassName,
  pulse = false,
  hasSelection,
  showBranch,
  showLaneLine,
  isLaneStart,
  isLaneEnd,
  continuationOnly = false,
}: {
  isFirst: boolean;
  isLast: boolean;
  isRunLevel: boolean;
  statusDotClassName?: string;
  pulse?: boolean;
  /** Whether any group is currently active (selected or hovered) */
  hasSelection: boolean;
  /** Whether to show a horizontal branch line for this row (event belongs to active group) */
  showBranch: boolean;
  /** Whether the vertical lane line passes through this row */
  showLaneLine: boolean;
  /** Whether the vertical lane line starts at this row (top clipped to 50%) */
  isLaneStart: boolean;
  /** Whether the vertical lane line ends at this row (bottom clipped to 50%) */
  isLaneEnd: boolean;
  continuationOnly?: boolean;
}) {
  const isDotDimmed = hasSelection && !showBranch && !isRun;

  return (
    <div
      className={cn(
        'relative w-9 flex-shrink-0 self-stretch',
        continuationOnly && 'min-h-0'
      )}
    >
      {/* Root vertical line (leftmost, always visible) */}
      <div
        className={cn(
          'absolute left-2 z-0 w-0.5 bg-gray-500',
          continuationOnly
            ? 'inset-y-0'
            : [
                isFirst ? 'top-1/2' : 'top-0',
                isLast ? 'bottom-1/2' : 'bottom-0',
              ]
        )}
      />

      {!continuationOnly && (
        <>
          {/* Status dot on the root line for every event */}
          <div
            className={cn(
              'absolute top-1/2 z-[2] -translate-y-1/2',
              isRun ? 'left-[5px] size-2' : 'left-1.5 size-1.5'
            )}
          >
            {/* Opaque backdrop ensures gutter lines never visually cut through dots */}
            <div className="absolute inset-0 z-0 rounded-full bg-background-100" />
            {pulse && (
              <div
                className={cn(
                  'absolute inset-0 z-[1] animate-[workflow-dot-pulse_1.25s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full',
                  statusDotClassName,
                  isDotDimmed ? 'opacity-[0.225]' : 'opacity-75'
                )}
              />
            )}
            <div
              className={cn(
                'relative z-[2] size-full rounded-full transition-opacity duration-150',
                statusDotClassName,
                isDotDimmed ? 'opacity-30' : 'opacity-100'
              )}
            />
          </div>

          {/* Horizontal branch from root to gutter edge (selected group events only) */}
          {showBranch && (
            <div className="absolute top-1/2 left-[9px] z-0 h-0.5 w-[27px] bg-gray-500" />
          )}
        </>
      )}

      {/* Vertical lane line connecting the selected group's events */}
      {showLaneLine && (
        <div
          className={cn(
            'absolute left-5 z-0 w-0.5 bg-gray-500',
            continuationOnly
              ? 'inset-y-0'
              : [
                  isLaneStart ? 'top-1/2' : 'top-0',
                  isLaneEnd ? 'bottom-1/2' : 'bottom-0',
                ]
          )}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Copyable cell — shows a copy button on hover
// ──────────────────────────────────────────────────────────────────────────

function CopyableCell({
  value,
  className,
}: {
  value: string;
  className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const resetCopiedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetCopiedTimeoutRef.current !== null) {
        window.clearTimeout(resetCopiedTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        if (resetCopiedTimeoutRef.current !== null) {
          window.clearTimeout(resetCopiedTimeoutRef.current);
        }
        resetCopiedTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          resetCopiedTimeoutRef.current = null;
        }, 1500);
      });
    },
    [value]
  );

  return (
    <div
      className={`group/copy flex min-w-0 items-center gap-1 px-4 ${className ?? ''}`}
    >
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {value || '-'}
      </span>
      {value ? (
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 appearance-none rounded !border-none !bg-transparent p-0.5 opacity-0 transition-opacity hover:!bg-gray-alpha-200 group-hover/copy:opacity-100"
          aria-label={`Copy ${value}`}
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-700" />
          ) : (
            <Copy className="h-3 w-3 text-gray-700" />
          )}
        </button>
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
    // class instance refs) — don't destructure them into plain objects
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

  const [copied, setCopied] = useState(false);
  const resetCopiedTimeoutRef = useRef<number | null>(null);
  const cleaned = useMemo(() => deepParseJson(data), [data]);

  useEffect(() => {
    return () => {
      if (resetCopiedTimeoutRef.current !== null) {
        window.clearTimeout(resetCopiedTimeoutRef.current);
      }
    };
  }, []);

  const formatted = useMemo(() => {
    try {
      return JSON.stringify(cleaned, null, 2);
    } catch {
      return String(cleaned);
    }
  }, [cleaned]);

  const handleCopy = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(formatted).then(() => {
        setCopied(true);
        if (resetCopiedTimeoutRef.current !== null) {
          window.clearTimeout(resetCopiedTimeoutRef.current);
        }
        resetCopiedTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          resetCopiedTimeoutRef.current = null;
        }, 1500);
      });
    },
    [formatted]
  );

  if (structuredError) {
    return (
      <div className="p-2">
        <ErrorStackBlock value={structuredError} />
      </div>
    );
  }

  // Attribute changes — render the changed keys and the writer instead of
  // the raw JSON payload.
  if (eventType === 'attr_set') {
    return <AttrSetEventBlock data={cleaned} />;
  }

  // Cancellation reason — render the free-text reason as a readable line
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
        <div className="p-2 text-gray-1000 text-xs">
          <span className="text-gray-900">Reason: </span>
          <span className="whitespace-pre-wrap break-words">
            {cancelReason}
          </span>
        </div>
      );
    }
  }

  return (
    <div className="relative group/payload">
      <div className="overflow-x-auto p-2 text-[11px] text-gray-1000">
        <DataInspector data={cleaned} expandLevel={2} />
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 bottom-2 flex appearance-none items-center gap-1 rounded-md !border-none !bg-transparent px-2 py-1 text-gray-700 text-xs opacity-0 transition-opacity hover:!bg-gray-alpha-200 group-hover/payload:opacity-100"
        aria-label="Copy payload"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-green-700" />
            <span className="text-green-700">Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            <span>Copy</span>
          </>
        )}
      </button>
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

function RowsSkeleton({
  showSeparateEventOccurrenceTimestamps = false,
}: {
  showSeparateEventOccurrenceTimestamps?: boolean;
}) {
  return (
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: 16 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-0">
          {/* Gutter area */}
          <div className="relative flex w-9 flex-shrink-0 items-center self-stretch">
            {/* Vertical line skeleton */}
            <div
              className={cn(
                'absolute bottom-0 left-2 w-0.5',
                i === 0 ? 'top-1/2' : 'top-0'
              )}
            >
              <Skeleton className="h-full w-full rounded-[1px]" />
            </div>
            {/* Dot skeleton */}
            <Skeleton
              className={cn(
                'flex-shrink-0 rounded-full',
                i % 4 === 0 ? 'ml-[5px] size-2' : 'ml-1.5 size-1.5'
              )}
            />
          </div>
          {/* Chevron placeholder */}
          <div className="w-5 flex-shrink-0 flex items-center justify-center">
            <Skeleton className="h-5 w-5 rounded" />
          </div>
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
            <Skeleton className="size-1.5 flex-shrink-0 rounded-full" />
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
  /** When provided, signals that decryption is active (triggers re-load of expanded events) */
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
}

export function EventRow({
  event,
  index,
  isFirst,
  isLast,
  isExpanded,
  onToggleExpand,
  activeGroupKey,
  selectedGroupKey,
  selectedGroupRange,
  correlationNameMap,
  workflowName,
  durationMap,
  onSelectGroup,
  onHoverGroup,
  onLoadEventData,
  cachedEventData,
  onCacheEventData,
  encryptionKey,
  onEncryptedDataDetected,
  suppressGroupDimming = false,
  showSeparateEventOccurrenceTimestamps = false,
}: {
  event: Event;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  isExpanded: boolean;
  onToggleExpand: (eventId: string) => void;
  activeGroupKey?: string;
  selectedGroupKey?: string;
  selectedGroupRange: { first: number; last: number } | null;
  correlationNameMap: Map<string, string>;
  workflowName: string | null;
  durationMap: Map<string, DurationInfo>;
  onSelectGroup: (groupKey: string | undefined) => void;
  onHoverGroup: (groupKey: string | undefined) => void;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  cachedEventData: unknown | null;
  onCacheEventData: (eventId: string, data: unknown) => void;
  encryptionKey?: Uint8Array;
  onEncryptedDataDetected?: () => void;
  /** Exact-ID search results should not dim unrelated rows. */
  suppressGroupDimming?: boolean;
  /** Show occurredAt separately instead of folding it into the Created timestamp. */
  showSeparateEventOccurrenceTimestamps?: boolean;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadedEventData, setLoadedEventData] = useState<unknown | null>(
    cachedEventData
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(
    cachedEventData !== null
  );

  // Notify parent if cached data has encrypted markers on mount
  useEffect(() => {
    if (
      cachedEventData !== null &&
      !encryptionKey &&
      hasEncryptedValues(cachedEventData)
    ) {
      onEncryptedDataDetected?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rowGroupKey = isRunLevel(event.eventType)
    ? '__run__'
    : (event.correlationId ?? undefined);

  const statusDotClassName = getStatusDotClassName(event.eventType);
  const createdAt = new Date(event.createdAt);
  const occurredAt = parseEventDate(event.occurredAt);
  const displayedCreatedAt = showSeparateEventOccurrenceTimestamps
    ? createdAt
    : getEffectiveEventDate(event);
  const hasExistingEventData = 'eventData' in event && event.eventData != null;
  const isRun = isRunLevel(event.eventType);
  const eventName = isRun
    ? (workflowName ?? '-')
    : event.correlationId
      ? (correlationNameMap.get(event.correlationId) ?? '-')
      : '-';

  const durationKey = event.correlationId ?? (isRun ? '__run__' : '');
  const durationInfo = durationKey ? durationMap.get(durationKey) : undefined;

  const hasActive = activeGroupKey !== undefined;
  const isRelated = rowGroupKey !== undefined && rowGroupKey === activeGroupKey;
  const isDimmed = hasActive && !isRelated && !suppressGroupDimming;
  const isPulsing = hasActive && isRelated;

  // Gutter state derived from selectedGroupRange
  const showBranch = hasActive && isRelated && !isRun;
  const showLaneLine =
    selectedGroupRange !== null &&
    index >= selectedGroupRange.first &&
    index <= selectedGroupRange.last;
  const isLaneStart =
    selectedGroupRange !== null && index === selectedGroupRange.first;
  const isLaneEnd =
    selectedGroupRange !== null && index === selectedGroupRange.last;

  const loadEventDetails = useCallback(async () => {
    if (loadedEventData !== null) {
      return;
    }
    if (cachedEventData !== null) {
      setLoadedEventData(cachedEventData);
      setHasAttemptedLoad(true);
      return;
    }
    if (isLoading) {
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    try {
      if (!onLoadEventData) {
        setLoadError('Event details unavailable');
        return;
      }
      const data = await onLoadEventData(event);
      if (data !== null && data !== undefined) {
        setLoadedEventData(data);
        onCacheEventData(event.eventId, data);
        if (!encryptionKey && hasEncryptedValues(data)) {
          onEncryptedDataDetected?.();
        }
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load event details'
      );
    } finally {
      setIsLoading(false);
      setHasAttemptedLoad(true);
    }
  }, [
    event,
    loadedEventData,
    isLoading,
    onLoadEventData,
    onCacheEventData,
    encryptionKey,
    onEncryptedDataDetected,
    cachedEventData,
  ]);

  // Auto-load event data when remounting in expanded state without cached data
  useEffect(() => {
    if (!isExpanded || isLoading) {
      return;
    }
    void loadEventDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When encryption key changes and this event was previously loaded,
  // re-load to get decrypted data
  useEffect(() => {
    if (encryptionKey && hasAttemptedLoad && onLoadEventData) {
      setLoadedEventData(null);
      setHasAttemptedLoad(false);
      onLoadEventData(event)
        .then((data) => {
          if (data !== null && data !== undefined) {
            setLoadedEventData(data);
            onCacheEventData(event.eventId, data);
          }
          setHasAttemptedLoad(true);
        })
        .catch(() => {
          setHasAttemptedLoad(true);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey]);

  const handleRowClick = useCallback(() => {
    onSelectGroup(rowGroupKey === selectedGroupKey ? undefined : rowGroupKey);
    onToggleExpand(event.eventId);
    if (!isExpanded) {
      void loadEventDetails();
    }
  }, [
    selectedGroupKey,
    rowGroupKey,
    onSelectGroup,
    onToggleExpand,
    event.eventId,
    isExpanded,
    loadEventDetails,
  ]);

  const mergedEventData =
    loadedEventData ??
    (hasExistingEventData
      ? (event as Event & { eventData: unknown }).eventData
      : null);

  const displayPayload = isLoading ? loadedEventData : mergedEventData;

  return (
    <div
      data-event-id={event.eventId}
      onMouseEnter={() => onHoverGroup(rowGroupKey)}
      onMouseLeave={() => onHoverGroup(undefined)}
    >
      {/* Row */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleRowClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleRowClick();
        }}
        className="flex min-h-10 w-full cursor-pointer items-center gap-0 text-left text-[13px] transition-colors hover:bg-gray-alpha-100"
      >
        <TreeGutter
          isFirst={isFirst}
          isLast={isLast && !isExpanded}
          isRunLevel={isRun}
          statusDotClassName={statusDotClassName}
          pulse={isPulsing}
          hasSelection={hasActive}
          showBranch={showBranch}
          showLaneLine={showLaneLine}
          isLaneStart={isLaneStart}
          isLaneEnd={isLaneEnd}
        />

        {/* Content area — dims when unrelated */}
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center transition-opacity duration-150',
            isDimmed ? 'opacity-30' : 'opacity-100'
          )}
        >
          {/* Expand chevron indicator */}
          <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border border-gray-400">
            <ChevronRight
              className={cn(
                'h-3 w-3 text-gray-900 transition-transform',
                isExpanded && 'rotate-90'
              )}
            />
          </div>

          {showSeparateEventOccurrenceTimestamps && (
            <div className="min-w-0 flex-[2_1_0%] px-4 text-gray-900 tabular-nums">
              {occurredAt ? (
                <TimestampTooltip date={occurredAt}>
                  <span>{formatEventTime(occurredAt)}</span>
                </TimestampTooltip>
              ) : (
                '-'
              )}
            </div>
          )}

          {/* Created */}
          <div className="min-w-0 flex-[2_1_0%] px-4 text-gray-900 tabular-nums">
            <TimestampTooltip date={displayedCreatedAt}>
              <span>{formatEventTime(displayedCreatedAt)}</span>
            </TimestampTooltip>
          </div>

          {/* Event Type */}
          <div className="min-w-0 flex-[2_1_0%] px-4 font-medium">
            <span className="inline-flex items-center gap-1.5 text-gray-900">
              <span className="relative inline-flex size-1.5 flex-shrink-0">
                {isPulsing && (
                  <span
                    className={cn(
                      'absolute inset-0 animate-[workflow-dot-pulse_1.25s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full opacity-75',
                      statusDotClassName
                    )}
                  />
                )}
                <span
                  className={cn(
                    'relative size-1.5 rounded-full',
                    statusDotClassName
                  )}
                />
              </span>
              {formatEventType(event.eventType)}
            </span>
          </div>

          {/* Name */}
          <div
            className="min-w-0 flex-[2_1_0%] overflow-hidden text-ellipsis whitespace-nowrap px-4"
            title={eventName !== '-' ? eventName : undefined}
          >
            {eventName}
          </div>

          {/* Correlation ID */}
          <CopyableCell
            value={event.correlationId || ''}
            className="flex-[3_1_0%] font-mono"
          />

          {/* Event ID */}
          <CopyableCell
            value={event.eventId}
            className="flex-[3_1_0%] font-mono"
          />
        </div>
      </div>

      {/* Expanded details — tree lines continue through this area */}
      {isExpanded && (
        <div className="flex">
          {/* Continuation gutter — lane line continues if not at lane end */}
          <TreeGutter
            isFirst={false}
            isLast={isLast}
            isRunLevel={isRun}
            hasSelection={hasActive}
            showBranch={false}
            showLaneLine={showLaneLine && !isLaneEnd}
            isLaneStart={false}
            isLaneEnd={false}
            continuationOnly
          />
          {/* Spacer for chevron column */}
          <div className="w-5 flex-shrink-0" />
          <div
            className={cn(
              'my-1.5 mr-3 ml-2 flex-1 overflow-hidden rounded-md border border-gray-alpha-200 py-2 transition-opacity duration-150',
              isDimmed ? 'opacity-30' : 'opacity-100'
            )}
          >
            {/* Duration info */}
            {(durationInfo?.queued !== undefined ||
              durationInfo?.ran !== undefined) && (
              <div className="flex gap-3 px-2 pb-1.5 text-gray-900 text-xs">
                {durationInfo.queued !== undefined &&
                  durationInfo.queued > 0 && (
                    <span>
                      Queued for{' '}
                      <span className="font-mono tabular-nums">
                        {formatDuration(durationInfo.queued)}
                      </span>
                    </span>
                  )}
                {durationInfo.ran !== undefined && (
                  <span>
                    Ran for{' '}
                    <span className="font-mono tabular-nums">
                      {formatDuration(durationInfo.ran)}
                    </span>
                  </span>
                )}
              </div>
            )}

            {/* Payload */}
            {displayPayload != null ? (
              <PayloadBlock data={displayPayload} eventType={event.eventType} />
            ) : loadError ? (
              <div className="rounded-md border border-red-400 bg-red-100 p-3 text-red-900 text-xs">
                {loadError}
              </div>
            ) : isLoading ||
              (loadedEventData === null &&
                !hasAttemptedLoad &&
                event.correlationId) ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-[60%]" />
              </div>
            ) : (
              <div className="p-2 text-gray-900 text-xs">No data</div>
            )}
          </div>
        </div>
      )}
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
  hasEncryptedData: hasEncryptedDataProp = false,
  onExactIdSearch,
  showSeparateEventOccurrenceTimestamps = false,
}: EventsListProps) {
  const toast = useToast();
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

  // Tracks whether any expanded row's lazy-loaded data contained encrypted markers.
  // Set to true by EventRow via onEncryptedDataDetected; never reset (sticky).
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
    () => buildDurationMap(sortedEvents),
    [sortedEvents]
  );

  const [selectedGroupKey, setSelectedGroupKey] = useState<string | undefined>(
    undefined
  );
  const [hoveredGroupKey, setHoveredGroupKey] = useState<string | undefined>(
    undefined
  );
  const onSelectGroup = useCallback((groupKey: string | undefined) => {
    setSelectedGroupKey(groupKey);
  }, []);
  const onHoverGroup = useCallback((groupKey: string | undefined) => {
    setHoveredGroupKey(groupKey);
  }, []);

  const activeGroupKey = selectedGroupKey ?? hoveredGroupKey;

  // Expanded state lifted out of EventRow so it survives virtualization
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(
    () => new Set()
  );
  const toggleEventExpanded = useCallback((eventId: string) => {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }, []);

  // Event data cache — ref avoids re-renders when cache updates
  const eventDataCacheRef = useRef<Map<string, unknown>>(new Map());
  const cacheEventData = useCallback((eventId: string, data: unknown) => {
    eventDataCacheRef.current.set(eventId, data);
  }, []);

  // Lookup from eventId → groupKey for efficient collapse filtering
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

  // Collapse expanded events that don't belong to the newly selected group
  useEffect(() => {
    if (selectedGroupKey === undefined) return;
    setExpandedEventIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const eventId of prev) {
        if (eventGroupKeyMap.get(eventId) === selectedGroupKey) {
          next.add(eventId);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedGroupKey, eventGroupKeyMap]);

  // Compute the row-index range for the active group's connecting lane line.
  // Only applies to non-run groups (step/hook/wait correlations).
  const selectedGroupRange = useMemo(() => {
    if (!activeGroupKey || activeGroupKey === '__run__') return null;
    let first = -1;
    let last = -1;
    for (let i = 0; i < sortedEvents.length; i++) {
      if (sortedEvents[i].correlationId === activeGroupKey) {
        if (first === -1) first = i;
        last = i;
      }
    }
    return first >= 0 ? { first, last } : null;
  }, [activeGroupKey, sortedEvents]);

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
      <div className="h-full flex flex-col overflow-hidden">
        {/* Skeleton search bar */}
        <div className="p-1.5">
          <Skeleton className="h-10 rounded-md" />
        </div>
        {/* Skeleton header */}
        <div className="flex h-10 flex-shrink-0 items-center gap-0 border-gray-alpha-200 border-b">
          <div className="w-9 flex-shrink-0" />
          <div className="w-5 flex-shrink-0" />
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-[72px]" />
          </div>
          <div className="min-w-0 flex-[2_1_0%] px-4">
            <Skeleton className="h-3 w-11" />
          </div>
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-[92px]" />
          </div>
          <div className="min-w-0 flex-[3_1_0%] px-4">
            <Skeleton className="h-3 w-[60px]" />
          </div>
        </div>
        <RowsSkeleton />
      </div>
    );
  }

  return (
    <DecryptClickContext.Provider
      value={onDecrypt ? { onDecrypt, isDecrypting } : undefined}
    >
      <div className="h-full flex flex-col overflow-hidden">
        <style>{`@keyframes workflow-dot-pulse{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.2);opacity:0}}`}</style>
        {/* Search bar + sort */}
        <div className="flex gap-1.5 bg-background-100 p-1.5">
          <label className="flex h-10 min-w-0 flex-1 items-center justify-center rounded-md bg-background-100 shadow-[0_0_0_1px_var(--ds-gray-alpha-400)]">
            <div className="flex size-10 flex-shrink-0 items-center justify-center text-gray-800">
              <svg
                width={16}
                height={16}
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                focusable="false"
              >
                <circle
                  cx="7"
                  cy="7"
                  r="4.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M11.5 11.5L14 14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <input
              type="search"
              placeholder="Search by step ID, wait ID, hook ID, or event ID…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              disabled={!onExactIdSearch}
              title={
                onExactIdSearch
                  ? undefined
                  : 'Exact ID search is unavailable in this view.'
              }
              className={cn(
                '-ml-4 h-10 w-full !border-none !bg-transparent px-3 text-sm outline-none [font-family:inherit]',
                onExactIdSearch
                  ? 'cursor-text opacity-100'
                  : 'cursor-not-allowed opacity-50'
              )}
            />
          </label>
          <MenuDropdown
            options={SORT_OPTIONS}
            value={effectiveSortOrder}
            onChange={handleSortOrderChange}
          />
          {(hasEncryptedData || encryptionKey) && onDecrypt && (
            <DecryptButton
              decrypted={!!encryptionKey}
              loading={isDecrypting}
              onClick={onDecrypt}
            />
          )}
        </div>

        {/* Header */}
        <div className="flex h-10 flex-shrink-0 items-center gap-0 border-gray-alpha-200 border-b bg-background-100 font-medium text-[13px] text-gray-900">
          <div className="w-9 flex-shrink-0" />
          <div className="w-5 flex-shrink-0" />
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
          <div className="flex flex-1 items-center justify-center px-6 text-center text-gray-700 text-sm">
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
            overscan={20}
            defaultItemHeight={40}
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
                  index={index}
                  isFirst={index === 0}
                  isLast={index === sortedEvents.length - 1}
                  isExpanded={expandedEventIds.has(ev.eventId)}
                  onToggleExpand={toggleEventExpanded}
                  activeGroupKey={activeGroupKey}
                  selectedGroupKey={selectedGroupKey}
                  selectedGroupRange={selectedGroupRange}
                  correlationNameMap={correlationNameMap}
                  workflowName={workflowName}
                  durationMap={durationMap}
                  onSelectGroup={onSelectGroup}
                  onHoverGroup={onHoverGroup}
                  onLoadEventData={onLoadEventData}
                  cachedEventData={
                    eventDataCacheRef.current.get(ev.eventId) ?? null
                  }
                  onCacheEventData={cacheEventData}
                  encryptionKey={encryptionKey}
                  onEncryptedDataDetected={handleEncryptedDataDetected}
                  suppressGroupDimming={isExactSearchActive}
                  showSeparateEventOccurrenceTimestamps={
                    showSeparateEventOccurrenceTimestamps
                  }
                />
              );
            }}
            className="min-h-0 flex-1"
          />
        )}

        {/* Fixed footer — count + load more */}
        <div className="relative flex h-10 flex-shrink-0 items-center border-gray-alpha-200 border-t bg-background-100 px-4 text-gray-900 text-xs">
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
    </DecryptClickContext.Provider>
  );
}

export function EventListView(props: EventsListProps) {
  return (
    <ContextCardProvider>
      <EventListViewInner {...props} />
    </ContextCardProvider>
  );
}
