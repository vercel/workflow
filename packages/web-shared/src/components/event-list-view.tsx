'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, WorkflowRun } from '@workflow/world';
import { Check, ChevronRight, Copy } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { isEncryptedMarker } from '../lib/hydration';
import { DecryptButton } from './ui/decrypt-button';
import { formatDuration } from '../lib/utils';
import { DataInspector } from './ui/data-inspector';
import {
  ErrorStackBlock,
  isStructuredErrorWithStack,
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

const BUTTON_RESET_STYLE: React.CSSProperties = {
  appearance: 'none',
  WebkitAppearance: 'none',
  border: 'none',
  background: 'transparent',
};
const DOT_PULSE_ANIMATION =
  'workflow-dot-pulse 1.25s cubic-bezier(0, 0, 0.2, 1) infinite';

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

function formatEventType(eventType: Event['eventType']): string {
  return eventType
    .split('_')
    .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ──────────────────────────────────────────────────────────────────────────
// Event type → status color (small dot only)
// ──────────────────────────────────────────────────────────────────────────

/** Returns a CSS color using Geist design tokens for the status dot. */
function getStatusDotColor(eventType: string): string {
  // Failed → red
  if (
    eventType === 'step_failed' ||
    eventType === 'run_failed' ||
    eventType === 'workflow_failed'
  ) {
    return 'var(--ds-red-700)';
  }
  // Cancelled → amber
  if (eventType === 'run_cancelled') {
    return 'var(--ds-amber-700)';
  }
  // Retrying → amber
  if (eventType === 'step_retrying') {
    return 'var(--ds-amber-700)';
  }
  // Completed/succeeded → green
  if (
    eventType === 'step_completed' ||
    eventType === 'run_completed' ||
    eventType === 'workflow_completed' ||
    eventType === 'hook_disposed' ||
    eventType === 'wait_completed'
  ) {
    return 'var(--ds-green-700)';
  }
  // Started/running → blue
  if (
    eventType === 'step_started' ||
    eventType === 'run_started' ||
    eventType === 'workflow_started' ||
    eventType === 'hook_received'
  ) {
    return 'var(--ds-blue-700)';
  }
  // Created/pending → gray
  return 'var(--ds-gray-600)';
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

interface DurationInfo {
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
function buildDurationMap(events: Event[]): Map<string, DurationInfo> {
  const createdTimes = new Map<string, number>();
  const startedTimes = new Map<string, number>();
  const durations = new Map<string, DurationInfo>();

  for (const event of events) {
    const ts = new Date(event.createdAt).getTime();
    const key = event.correlationId ?? '__run__';
    const type: string = event.eventType;

    // Track created times (first event for each correlation)
    if (type === 'step_created' || type === 'run_created') {
      createdTimes.set(key, ts);
    }

    // Track started times & compute queued duration
    if (
      type === 'step_started' ||
      type === 'run_started' ||
      type === 'workflow_started'
    ) {
      startedTimes.set(key, ts);
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
    eventType === 'workflow_failed'
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tree gutter — fixed-width, shows branch lines only for the selected group
// ──────────────────────────────────────────────────────────────────────────

/** Fixed gutter width: 20px root area + 16px for one branch lane */
const GUTTER_WIDTH = 36;
/** X position of the single branch lane line */
const LANE_X = 20;
const ROOT_LINE_COLOR = 'var(--ds-gray-500)';

function TreeGutter({
  isFirst,
  isLast,
  isRunLevel: isRun,
  statusDotColor,
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
  statusDotColor?: string;
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
  const dotSize = isRun ? 8 : 6;
  const dotLeft = isRun ? 5 : 6;
  const dotOpacity = hasSelection && !showBranch && !isRun ? 0.3 : 1;

  return (
    <div
      className="relative flex-shrink-0 self-stretch"
      style={{
        width: GUTTER_WIDTH,
        minHeight: continuationOnly ? 0 : undefined,
      }}
    >
      {/* Root vertical line (leftmost, always visible) */}
      <div
        style={{
          position: 'absolute',
          left: 8,
          top: continuationOnly ? 0 : isFirst ? '50%' : 0,
          bottom: continuationOnly ? 0 : isLast ? '50%' : 0,
          width: 2,
          backgroundColor: ROOT_LINE_COLOR,
          zIndex: 0,
        }}
      />

      {!continuationOnly && (
        <>
          {/* Status dot on the root line for every event */}
          <div
            style={{
              position: 'absolute',
              left: dotLeft,
              top: '50%',
              transform: 'translateY(-50%)',
              width: dotSize,
              height: dotSize,
              zIndex: 2,
            }}
          >
            {/* Opaque backdrop ensures gutter lines never visually cut through dots */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                backgroundColor: 'var(--ds-background-100)',
                zIndex: 0,
              }}
            />
            {pulse && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  backgroundColor: statusDotColor,
                  opacity: 0.75 * dotOpacity,
                  animation: DOT_PULSE_ANIMATION,
                  zIndex: 1,
                }}
              />
            )}
            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                backgroundColor: statusDotColor,
                opacity: dotOpacity,
                transition: 'opacity 150ms',
                zIndex: 2,
              }}
            />
          </div>

          {/* Horizontal branch from root to gutter edge (selected group events only) */}
          {showBranch && (
            <div
              style={{
                position: 'absolute',
                left: 9,
                top: '50%',
                width: GUTTER_WIDTH - 9,
                height: 2,
                backgroundColor: ROOT_LINE_COLOR,
                zIndex: 0,
              }}
            />
          )}
        </>
      )}

      {/* Vertical lane line connecting the selected group's events */}
      {showLaneLine && (
        <div
          style={{
            position: 'absolute',
            left: LANE_X,
            top: continuationOnly ? 0 : isLaneStart ? '50%' : 0,
            bottom: continuationOnly ? 0 : isLaneEnd ? '50%' : 0,
            width: 2,
            backgroundColor: ROOT_LINE_COLOR,
            zIndex: 0,
          }}
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
  style: styleProp,
}: {
  value: string;
  className?: string;
  style?: React.CSSProperties;
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
      className={`group/copy flex items-center gap-1 min-w-0 px-4 ${className ?? ''}`}
      style={styleProp}
    >
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {value || '-'}
      </span>
      {value ? (
        <button
          type="button"
          onClick={handleCopy}
          className="flex-shrink-0 opacity-0 group-hover/copy:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--ds-gray-alpha-200)]"
          style={BUTTON_RESET_STYLE}
          aria-label={`Copy ${value}`}
        >
          {copied ? (
            <Check
              className="h-3 w-3"
              style={{ color: 'var(--ds-green-700)' }}
            />
          ) : (
            <Copy className="h-3 w-3" style={{ color: 'var(--ds-gray-700)' }} />
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
 * Extracts a structured error with a stack trace from event data, if present.
 * Returns the error object to render with ErrorStackBlock, or null if not applicable.
 */
function extractStructuredError(
  data: unknown,
  eventType?: string
): (Record<string, unknown> & { stack: string }) | null {
  if (!eventType || !ERROR_EVENT_TYPES.has(eventType)) return null;
  if (data == null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  // Check the nested `error` field first (the StructuredError)
  if (isStructuredErrorWithStack(record.error)) return record.error;
  // Some error formats put the stack at the top level of eventData
  if (isStructuredErrorWithStack(record)) return record;
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

  return (
    <div className="relative group/payload">
      <div
        className="overflow-x-auto p-2 text-[11px]"
        style={{ color: 'var(--ds-gray-1000)' }}
      >
        <DataInspector data={cleaned} expandLevel={2} />
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute bottom-2 right-2 opacity-0 group-hover/payload:opacity-100 transition-opacity flex items-center gap-1 px-2 py-1 rounded-md text-xs hover:bg-[var(--ds-gray-alpha-200)]"
        style={{ ...BUTTON_RESET_STYLE, color: 'var(--ds-gray-700)' }}
        aria-label="Copy payload"
      >
        {copied ? (
          <>
            <Check
              className="h-3 w-3"
              style={{ color: 'var(--ds-green-700)' }}
            />
            <span style={{ color: 'var(--ds-green-700)' }}>Copied</span>
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

function RowsSkeleton() {
  return (
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: 16 }, (_, i) => (
        <div key={i} className="flex items-center gap-0" style={{ height: 40 }}>
          {/* Gutter area */}
          <div
            className="relative flex-shrink-0 self-stretch flex items-center"
            style={{ width: GUTTER_WIDTH }}
          >
            {/* Vertical line skeleton */}
            <div
              style={{
                position: 'absolute',
                left: 8,
                top: i === 0 ? '50%' : 0,
                bottom: 0,
                width: 2,
              }}
            >
              <Skeleton className="w-full h-full" style={{ borderRadius: 1 }} />
            </div>
            {/* Dot skeleton */}
            <Skeleton
              className="flex-shrink-0"
              style={{
                width: i % 4 === 0 ? 8 : 6,
                height: i % 4 === 0 ? 8 : 6,
                borderRadius: '50%',
                marginLeft: i % 4 === 0 ? 5 : 6,
              }}
            />
          </div>
          {/* Chevron placeholder */}
          <div className="w-5 flex-shrink-0 flex items-center justify-center">
            <Skeleton className="w-5 h-5" style={{ borderRadius: 4 }} />
          </div>
          {/* Time */}
          <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <Skeleton className="h-3" style={{ width: '70%' }} />
          </div>
          {/* Event Type */}
          <div
            className="min-w-0 px-4 flex items-center gap-1.5"
            style={{ flex: '2 1 0%' }}
          >
            <Skeleton
              className="flex-shrink-0"
              style={{ width: 6, height: 6, borderRadius: '50%' }}
            />
            <Skeleton className="h-3" style={{ width: '60%' }} />
          </div>
          {/* Name */}
          <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <Skeleton className="h-3" style={{ width: '50%' }} />
          </div>
          {/* Correlation ID */}
          <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
            <Skeleton className="h-3" style={{ width: '75%' }} />
          </div>
          {/* Event ID */}
          <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
            <Skeleton className="h-3" style={{ width: '75%' }} />
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
}

function EventRow({
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

  const statusDotColor = getStatusDotColor(event.eventType);
  const createdAt = new Date(event.createdAt);
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
  const isDimmed = hasActive && !isRelated;
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

  const contentOpacity = isDimmed ? 0.3 : 1;

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
        className="w-full text-left flex items-center gap-0 text-[13px] hover:bg-[var(--ds-gray-alpha-100)] transition-colors cursor-pointer"
        style={{ minHeight: 40 }}
      >
        <TreeGutter
          isFirst={isFirst}
          isLast={isLast && !isExpanded}
          isRunLevel={isRun}
          statusDotColor={statusDotColor}
          pulse={isPulsing}
          hasSelection={hasActive}
          showBranch={showBranch}
          showLaneLine={showLaneLine}
          isLaneStart={isLaneStart}
          isLaneEnd={isLaneEnd}
        />

        {/* Content area — dims when unrelated */}
        <div
          className="flex items-center flex-1 min-w-0"
          style={{ opacity: contentOpacity, transition: 'opacity 150ms' }}
        >
          {/* Expand chevron indicator */}
          <div
            className="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded"
            style={{
              border: '1px solid var(--ds-gray-400)',
            }}
          >
            <ChevronRight
              className="h-3 w-3 transition-transform"
              style={{
                color: 'var(--ds-gray-900)',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            />
          </div>

          {/* Time */}
          <div
            className="tabular-nums min-w-0 px-4"
            style={{ color: 'var(--ds-gray-900)', flex: '2 1 0%' }}
          >
            <TimestampTooltip date={createdAt}>
              <span>{formatEventTime(createdAt)}</span>
            </TimestampTooltip>
          </div>

          {/* Event Type */}
          <div className="font-medium min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <span
              className="inline-flex items-center gap-1.5"
              style={{ color: 'var(--ds-gray-900)' }}
            >
              <span
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                }}
              >
                {isPulsing && (
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: '50%',
                      backgroundColor: statusDotColor,
                      opacity: 0.75,
                      animation: DOT_PULSE_ANIMATION,
                    }}
                  />
                )}
                <span
                  style={{
                    position: 'relative',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: statusDotColor,
                  }}
                />
              </span>
              {formatEventType(event.eventType)}
            </span>
          </div>

          {/* Name */}
          <div
            className="min-w-0 px-4 overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ flex: '2 1 0%' }}
            title={eventName !== '-' ? eventName : undefined}
          >
            {eventName}
          </div>

          {/* Correlation ID */}
          <CopyableCell
            value={event.correlationId || ''}
            className="font-mono"
            style={{ flex: '3 1 0%' }}
          />

          {/* Event ID */}
          <CopyableCell
            value={event.eventId}
            className="font-mono"
            style={{ flex: '3 1 0%' }}
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
            className="flex-1 my-1.5 mr-3 ml-2 py-2 rounded-md border overflow-hidden"
            style={{
              borderColor: 'var(--ds-gray-alpha-200)',
              opacity: contentOpacity,
              transition: 'opacity 150ms',
            }}
          >
            {/* Duration info */}
            {(durationInfo?.queued !== undefined ||
              durationInfo?.ran !== undefined) && (
              <div
                className="px-2 pb-1.5 text-xs flex gap-3"
                style={{ color: 'var(--ds-gray-900)' }}
              >
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
              <div
                className="rounded-md border p-3 text-xs"
                style={{
                  borderColor: 'var(--ds-red-400)',
                  backgroundColor: 'var(--ds-red-100)',
                  color: 'var(--ds-red-900)',
                }}
              >
                {loadError}
              </div>
            ) : isLoading ||
              (loadedEventData === null &&
                !hasAttemptedLoad &&
                event.correlationId) ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-3" style={{ width: '75%' }} />
                <Skeleton className="h-3" style={{ width: '50%' }} />
                <Skeleton className="h-3" style={{ width: '60%' }} />
              </div>
            ) : (
              <div
                className="p-2 text-xs"
                style={{ color: 'var(--ds-gray-900)' }}
              >
                No data
              </div>
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

export function EventListView({
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
}: EventsListProps) {
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

  const sortedEvents = useMemo(() => {
    if (!events || events.length === 0) return [];
    const dir = effectiveSortOrder === 'desc' ? -1 : 1;
    return [...events].sort(
      (a, b) =>
        dir *
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    );
  }, [events, effectiveSortOrder]);

  // Detect encrypted fields across all loaded events (inline eventData).
  const hasEncryptedInlineData = useMemo(() => {
    if (!events) return false;
    for (const event of events) {
      const ed = (event as Record<string, unknown>).eventData;
      if (hasEncryptedValues(ed)) return true;
    }
    return false;
  }, [events]);

  // Tracks whether any expanded row's lazy-loaded data contained encrypted markers.
  // Set to true by EventRow via onEncryptedDataDetected; never reset (sticky).
  const [foundEncryptedInLazyData, setFoundEncryptedInLazyData] =
    useState(false);
  const handleEncryptedDataDetected = useCallback(() => {
    setFoundEncryptedInLazyData(true);
  }, []);

  const hasEncryptedData = hasEncryptedInlineData || foundEncryptedInLazyData;

  const { correlationNameMap, workflowName } = useMemo(
    () => buildNameMaps(events ?? null, run ?? null),
    [events, run]
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

  const [searchQuery, setSearchQuery] = useState('');
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const searchIndex = useMemo(() => {
    const entries: {
      fields: string[];
      groupKey?: string;
      eventId: string;
      index: number;
    }[] = [];
    for (let i = 0; i < sortedEvents.length; i++) {
      const ev = sortedEvents[i];
      const isRun = isRunLevel(ev.eventType);
      const name = isRun
        ? (workflowName ?? '')
        : ev.correlationId
          ? (correlationNameMap.get(ev.correlationId) ?? '')
          : '';
      entries.push({
        fields: [
          ev.eventId,
          ev.correlationId ?? '',
          ev.eventType,
          formatEventType(ev.eventType),
          name,
        ].map((f) => f.toLowerCase()),
        groupKey: ev.correlationId ?? (isRun ? '__run__' : undefined),
        eventId: ev.eventId,
        index: i,
      });
    }
    return entries;
  }, [sortedEvents, correlationNameMap, workflowName]);

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      setSelectedGroupKey(undefined);
      return;
    }
    let bestMatch: (typeof searchIndex)[number] | null = null;
    let bestScore = 0;
    for (const entry of searchIndex) {
      for (const field of entry.fields) {
        if (field && field.includes(q)) {
          const score = q.length / field.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = entry;
          }
        }
      }
    }
    if (bestMatch) {
      setSelectedGroupKey(bestMatch.groupKey);
      virtuosoRef.current?.scrollToIndex({
        index: bestMatch.index,
        align: 'center',
        behavior: 'smooth',
      });
    }
  }, [searchQuery, searchIndex]);

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
        <div style={{ padding: 6 }}>
          <Skeleton style={{ height: 40, borderRadius: 6 }} />
        </div>
        {/* Skeleton header */}
        <div
          className="flex items-center gap-0 h-10 border-b flex-shrink-0"
          style={{ borderColor: 'var(--ds-gray-alpha-200)' }}
        >
          <div className="flex-shrink-0" style={{ width: GUTTER_WIDTH }} />
          <div className="w-5 flex-shrink-0" />
          <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <Skeleton className="h-3" style={{ width: 40 }} />
          </div>
          <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <Skeleton className="h-3" style={{ width: 72 }} />
          </div>
          <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
            <Skeleton className="h-3" style={{ width: 44 }} />
          </div>
          <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
            <Skeleton className="h-3" style={{ width: 92 }} />
          </div>
          <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
            <Skeleton className="h-3" style={{ width: 60 }} />
          </div>
        </div>
        <RowsSkeleton />
      </div>
    );
  }

  if (!isLoading && (!events || events.length === 0)) {
    return (
      <div
        className="flex items-center justify-center h-full text-sm"
        style={{ color: 'var(--ds-gray-700)' }}
      >
        No events found
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <style>{`@keyframes workflow-dot-pulse{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.2);opacity:0}}`}</style>
      {/* Search bar + sort */}
      <div
        style={{
          padding: 6,
          backgroundColor: 'var(--ds-background-100)',
          display: 'flex',
          gap: 6,
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            boxShadow: '0 0 0 1px var(--ds-gray-alpha-400)',
            background: 'var(--ds-background-100)',
            height: 40,
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ds-gray-800)',
              flexShrink: 0,
            }}
          >
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
            placeholder="Search by name, event type, or ID…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              marginLeft: -16,
              paddingInline: 12,
              fontFamily: 'inherit',
              fontSize: 14,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              height: 40,
              width: '100%',
            }}
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
      <div
        className="flex items-center gap-0 text-[13px] font-medium h-10 border-b flex-shrink-0"
        style={{
          borderColor: 'var(--ds-gray-alpha-200)',
          color: 'var(--ds-gray-900)',
          backgroundColor: 'var(--ds-background-100)',
        }}
      >
        <div className="flex-shrink-0" style={{ width: GUTTER_WIDTH }} />
        <div className="w-5 flex-shrink-0" />
        <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
          Time
        </div>
        <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
          Event Type
        </div>
        <div className="min-w-0 px-4" style={{ flex: '2 1 0%' }}>
          Name
        </div>
        <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
          Correlation ID
        </div>
        <div className="min-w-0 px-4" style={{ flex: '3 1 0%' }}>
          Event ID
        </div>
      </div>

      {/* Virtualized event rows or refetching skeleton */}
      {isRefetching ? (
        <RowsSkeleton />
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          totalCount={sortedEvents.length}
          overscan={20}
          defaultItemHeight={40}
          endReached={() => {
            if (!hasMoreEvents || isLoadingMoreEvents) {
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
              />
            );
          }}
          style={{ flex: 1, minHeight: 0 }}
        />
      )}

      {/* Fixed footer — count + load more */}
      <div
        className="relative flex-shrink-0 flex items-center h-10 border-t px-4 text-xs"
        style={{
          borderColor: 'var(--ds-gray-alpha-200)',
          color: 'var(--ds-gray-900)',
          backgroundColor: 'var(--ds-background-100)',
        }}
      >
        <span>
          {sortedEvents.length} event
          {sortedEvents.length !== 1 ? 's' : ''} loaded
        </span>
        {hasMoreEvents && (
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
  );
}
