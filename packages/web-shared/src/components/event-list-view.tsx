'use client';

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, Step, WorkflowRun } from '@workflow/world';
import { Check, ChevronRight, Copy } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { formatDuration } from '../lib/utils';
import { DataInspector } from './ui/data-inspector';
import { Skeleton } from './ui/skeleton';

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
 * Build a map from correlationId (stepId) → display name using step entities,
 * and parse the workflow name from the run.
 */
function buildNameMaps(
  steps: Step[] | null,
  run: WorkflowRun | null
): {
  correlationNameMap: Map<string, string>;
  workflowName: string | null;
} {
  const correlationNameMap = new Map<string, string>();

  // Map step correlationId (= stepId) → parsed step name
  if (steps) {
    for (const step of steps) {
      const parsed = parseStepName(String(step.stepName));
      correlationNameMap.set(step.stepId, parsed?.shortName ?? step.stepName);
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
      className={`group/copy flex items-center gap-1 flex-1 min-w-0 px-4 ${className ?? ''}`}
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
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepParseJson(v);
    }
    return result;
  }
  return value;
}

function PayloadBlock({ data }: { data: unknown }): ReactNode {
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
// Event row
// ──────────────────────────────────────────────────────────────────────────

interface EventsListProps {
  events: Event[] | null;
  steps?: Step[] | null;
  run?: WorkflowRun | null;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
  hasMoreEvents?: boolean;
  isLoadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => Promise<void> | void;
}

function EventRow({
  event,
  index,
  isFirst,
  isLast,
  activeGroupKey,
  selectedGroupKey,
  selectedGroupRange,
  correlationNameMap,
  workflowName,
  durationMap,
  onSelectGroup,
  onHoverGroup,
  onLoadEventData,
}: {
  event: Event;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  activeGroupKey?: string;
  selectedGroupKey?: string;
  selectedGroupRange: { first: number; last: number } | null;
  correlationNameMap: Map<string, string>;
  workflowName: string | null;
  durationMap: Map<string, DurationInfo>;
  onSelectGroup: (groupKey: string | undefined) => void;
  onHoverGroup: (groupKey: string | undefined) => void;
  onLoadEventData?: (event: Event) => Promise<unknown | null>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadedEventData, setLoadedEventData] = useState<unknown | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasAttemptedLoad, setHasAttemptedLoad] = useState(false);

  const rowGroupKey =
    event.correlationId ??
    (isRunLevel(event.eventType) ? '__run__' : undefined);

  // Collapse when a different group gets selected
  useEffect(() => {
    if (selectedGroupKey !== undefined && selectedGroupKey !== rowGroupKey) {
      setIsExpanded(false);
    }
  }, [selectedGroupKey, rowGroupKey]);

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
    if (loadedEventData !== null || hasExistingEventData) {
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    try {
      if (!onLoadEventData) {
        setLoadError('Event details unavailable');
        return;
      }
      const eventData = await onLoadEventData(event);
      if (eventData !== null && eventData !== undefined) {
        setLoadedEventData(eventData);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Failed to load event details'
      );
    } finally {
      setIsLoading(false);
      setHasAttemptedLoad(true);
    }
  }, [event, loadedEventData, hasExistingEventData, onLoadEventData]);

  const handleExpandToggle = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      const newExpanded = !isExpanded;
      setIsExpanded(newExpanded);
      if (newExpanded && loadedEventData === null && !hasExistingEventData) {
        loadEventDetails();
      }
    },
    [isExpanded, loadedEventData, hasExistingEventData, loadEventDetails]
  );

  const handleRowClick = useCallback(() => {
    if (selectedGroupKey === rowGroupKey) {
      onSelectGroup(undefined);
    } else {
      onSelectGroup(rowGroupKey);
    }
  }, [selectedGroupKey, rowGroupKey, onSelectGroup]);

  const eventData = hasExistingEventData
    ? (event as Event & { eventData: unknown }).eventData
    : loadedEventData;

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
        className="w-full text-left flex items-center gap-0 text-sm hover:bg-[var(--ds-gray-alpha-100)] transition-colors cursor-pointer"
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
          {/* Expand chevron button */}
          <button
            type="button"
            onClick={handleExpandToggle}
            className="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded hover:bg-[var(--ds-gray-alpha-200)] transition-colors"
            style={{
              ...BUTTON_RESET_STYLE,
              border: '1px solid var(--ds-gray-alpha-400)',
            }}
            aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
          >
            <ChevronRight
              className="h-3 w-3 transition-transform"
              style={{
                color: 'var(--ds-gray-700)',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            />
          </button>

          {/* Time */}
          <div
            className="text-xs tabular-nums flex-1 min-w-0 px-4"
            style={{ color: 'var(--ds-gray-900)' }}
          >
            {formatEventTime(createdAt)}
          </div>

          {/* Event Type */}
          <div className="text-xs font-medium flex-1 min-w-0 px-4">
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
            className="text-xs flex-1 min-w-0 px-4 overflow-hidden text-ellipsis whitespace-nowrap"
            title={eventName !== '-' ? eventName : undefined}
          >
            {eventName}
          </div>

          {/* Correlation ID */}
          <CopyableCell
            value={event.correlationId || ''}
            className="font-mono text-xs"
          />

          {/* Event ID */}
          <CopyableCell value={event.eventId} className="font-mono text-xs" />
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
            {eventData != null ? (
              <PayloadBlock data={eventData} />
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
              (!hasExistingEventData &&
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
  steps,
  run,
  onLoadEventData,
  hasMoreEvents = false,
  isLoadingMoreEvents = false,
  onLoadMoreEvents,
}: EventsListProps) {
  const sortedEvents = useMemo(() => {
    if (!events || events.length === 0) return [];
    return [...events].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [events]);

  const { correlationNameMap, workflowName } = useMemo(
    () => buildNameMaps(steps ?? null, run ?? null),
    [steps, run]
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
      text: string;
      groupKey?: string;
      eventId: string;
      index: number;
    }[] = [];
    for (let i = 0; i < sortedEvents.length; i++) {
      const ev = sortedEvents[i];
      entries.push({
        text: [ev.eventId, ev.correlationId ?? ''].join(' ').toLowerCase(),
        groupKey:
          ev.correlationId ??
          (isRunLevel(ev.eventType) ? '__run__' : undefined),
        eventId: ev.eventId,
        index: i,
      });
    }
    return entries;
  }, [sortedEvents]);

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      setSelectedGroupKey(undefined);
      return;
    }
    const match = searchIndex.find((entry) => entry.text.includes(q));
    if (match) {
      setSelectedGroupKey(match.groupKey);
      virtuosoRef.current?.scrollToIndex({
        index: match.index,
        align: 'center',
        behavior: 'smooth',
      });
    }
  }, [searchQuery, searchIndex]);

  if (!events || events.length === 0) {
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
      {/* Search bar */}
      <div style={{ padding: 6, backgroundColor: 'var(--ds-background-100)' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            boxShadow: '0 0 0 1px var(--ds-gray-alpha-400)',
            background: 'var(--ds-background-100)',
            height: 40,
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
            placeholder="Search by event ID or correlation ID…"
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
      </div>

      {/* Header */}
      <div
        className="flex items-center gap-0 text-sm font-medium h-10 border-b flex-shrink-0"
        style={{
          borderColor: 'var(--ds-gray-alpha-200)',
          color: 'var(--ds-gray-900)',
          backgroundColor: 'var(--ds-background-100)',
        }}
      >
        <div className="flex-shrink-0" style={{ width: GUTTER_WIDTH }} />
        <div className="w-5 flex-shrink-0" />
        <div className="flex-1 min-w-0 px-4">Time</div>
        <div className="flex-1 min-w-0 px-4">Event Type</div>
        <div className="flex-1 min-w-0 px-4">Name</div>
        <div className="flex-1 min-w-0 px-4">Correlation ID</div>
        <div className="flex-1 min-w-0 px-4">Event ID</div>
      </div>

      {/* Virtualized event rows */}
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
          return (
            <EventRow
              event={sortedEvents[index]}
              index={index}
              isFirst={index === 0}
              isLast={index === sortedEvents.length - 1}
              activeGroupKey={activeGroupKey}
              selectedGroupKey={selectedGroupKey}
              selectedGroupRange={selectedGroupRange}
              correlationNameMap={correlationNameMap}
              workflowName={workflowName}
              durationMap={durationMap}
              onSelectGroup={onSelectGroup}
              onHoverGroup={onHoverGroup}
              onLoadEventData={onLoadEventData}
            />
          );
        }}
        components={{
          Footer: () => (
            <>
              {hasMoreEvents && (
                <div className="px-3 pt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void onLoadMoreEvents?.()}
                    disabled={isLoadingMoreEvents}
                    className="h-8 px-3 text-xs rounded-md border transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      borderColor: 'var(--ds-gray-alpha-400)',
                      color: 'var(--ds-gray-900)',
                      backgroundColor: 'var(--ds-background-100)',
                    }}
                  >
                    {isLoadingMoreEvents
                      ? 'Loading more events...'
                      : 'Load more'}
                  </button>
                </div>
              )}
              <div
                className="mt-4 pt-3 border-t text-xs px-3"
                style={{
                  borderColor: 'var(--ds-gray-alpha-200)',
                  color: 'var(--ds-gray-900)',
                }}
              >
                {sortedEvents.length} event
                {sortedEvents.length !== 1 ? 's' : ''} total
              </div>
            </>
          ),
        }}
        style={{ flex: 1, minHeight: 0 }}
      />
    </div>
  );
}
