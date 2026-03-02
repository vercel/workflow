'use client';

import { clsx } from 'clsx';
import type { CSSProperties, MutableRefObject, ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import styles from '../trace-viewer.module.css';
import type {
  MemoCache,
  MemoCacheKey,
  RootNode,
  ScrollSnapshot,
  SpanNode,
  VisibleSpan,
  VisibleSpanEvent,
} from '../types';
import { MARKER_HEIGHT, ROW_HEIGHT, ROW_PADDING } from '../util/constants';
import { formatDuration, getHighResInMs } from '../util/timing';
import { SpanContent } from './span-content';
import { computeSegments } from './span-segments';
import {
  type ResourceType,
  type SpanLayout,
  getResourceType,
  getSpanLayout,
} from './span-strategies';

export const getSpanColorClassName = (node: SpanNode): string => {
  if (node.isVercel) return String(styles.colorVercel);
  return String(styles[`color${node.resourceIndex % 5}` as 'color0']);
};

function getTerminalTimestamp(
  resourceType: ResourceType,
  node: VisibleSpan
): number | undefined {
  const events = node.events;
  if (!events?.length) return undefined;

  switch (resourceType) {
    case 'hook':
      for (let i = events.length; i--; ) {
        if (events[i].event.name === 'hook_disposed') {
          return events[i].timestamp;
        }
      }
      return undefined;
    case 'sleep':
      for (let i = events.length; i--; ) {
        if (events[i].event.name === 'wait_completed') {
          return events[i].timestamp;
        }
      }
      return undefined;
    case 'run':
      for (let i = events.length; i--; ) {
        const name = events[i].event.name;
        if (
          name === 'run_completed' ||
          name === 'run_failed' ||
          name === 'run_cancelled'
        ) {
          return events[i].timestamp;
        }
      }
      return undefined;
    case 'step':
      for (let i = events.length; i--; ) {
        const name = events[i].event.name;
        if (name === 'step_completed' || name === 'step_failed') {
          return events[i].timestamp;
        }
        if (name === 'step_started' || name === 'step_retrying') {
          return undefined;
        }
      }
      return undefined;
    default:
      return undefined;
  }
}

export const SpanNodes = memo(function SpanNodes({
  root,
  scale,
  spans,
  isLive = false,
  scrollSnapshotRef,
  cache,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
}: {
  root: RootNode;
  scale: number;
  spans: VisibleSpan[];
  isLive?: boolean;
  scrollSnapshotRef: MutableRefObject<ScrollSnapshot | undefined>;
  /** Not used in the body — exists solely to bust React.memo when the global memo cache changes. */
  cacheKey?: MemoCacheKey;
  cache: MemoCache;
  customSpanClassNameFunc?: (span: SpanNode) => string;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
}) {
  return spans.map((x) => (
    <SpanComponent
      cacheKey={cache.get(x.span.spanId)}
      customSpanEventClassNameFunc={customSpanEventClassNameFunc}
      customSpanClassNameFunc={customSpanClassNameFunc}
      key={x.span.spanId}
      node={x}
      root={root}
      scale={scale}
      traceIsLive={isLive}
      scrollSnapshotRef={scrollSnapshotRef}
    />
  ));
});

// ──────────────────────────────────────────────────────────────────────────
// Compute inline styles from a SpanLayout
// ──────────────────────────────────────────────────────────────────────────

function getSpanStyle(
  layout: SpanLayout,
  node: VisibleSpan,
  root: RootNode,
  scale: number
): CSSProperties {
  // Use isExpanded (hovered or selected) for width expansion so that
  // selected small spans stay expanded and show their name.
  const expanded = layout.isExpanded;
  return {
    // Use actualWidth for CSS variable so hover expansion is accurate
    '--span-width': `${Math.max(layout.actualWidth, 1)}px`,
    minWidth: expanded ? layout.width : undefined,
    width: expanded ? undefined : layout.width,
    height: layout.height,
    maxWidth:
      expanded && !layout.isNearRightSide
        ? (root.endTime - node.startTime) * scale
        : undefined,
    containIntrinsicWidth: expanded ? undefined : layout.width,
    containIntrinsicHeight: layout.height,
    left: layout.isNearRightSide ? undefined : layout.left,
    right: layout.isNearRightSide
      ? (root.endTime - node.endTime) * scale
      : undefined,
    top: layout.top,
  } as CSSProperties;
}

// ──────────────────────────────────────────────────────────────────────────
// SpanComponent
// ──────────────────────────────────────────────────────────────────────────

export const SpanComponent = memo(function SpanComponent({
  node,
  root,
  scale,
  traceIsLive = false,
  scrollSnapshotRef,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
}: {
  node: VisibleSpan;
  root: RootNode;
  scale: number;
  traceIsLive?: boolean;
  scrollSnapshotRef: MutableRefObject<ScrollSnapshot | undefined>;
  /** Not used in the body — exists solely to bust React.memo for this span. */
  cacheKey?: MemoCacheKey;
  customSpanClassNameFunc?: (span: SpanNode) => string;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
}): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    node.ref = ref;
    return () => {
      node.ref = undefined;
    };
  }, [node]);

  const { span } = node;
  const resourceType = getResourceType(node);
  const [liveNow, setLiveNow] = useState(0);

  // Get custom class name from callback if provided
  const customClassName = customSpanClassNameFunc
    ? customSpanClassNameFunc(node)
    : '';

  // Workflow span types use colored segments + boundary line markers
  // Generic OTEL spans use diamond event markers
  const isWorkflowSpan = resourceType !== 'default';

  // Determine if this span is still active (live). We require the parent run
  // to be explicitly live to avoid completed/cancelled traces continuing to
  // grow due to timing heuristics.
  const data = span.attributes?.data as Record<string, unknown> | undefined;
  const terminalTimestamp = getTerminalTimestamp(resourceType, node);
  const hasTerminalEvent = terminalTimestamp != null;
  const isCompletedByData =
    resourceType === 'hook'
      ? Boolean(data?.disposedAt)
      : Boolean(data?.completedAt);
  const isCompleted = isCompletedByData || hasTerminalEvent;
  const isLive = traceIsLive && isWorkflowSpan && !isCompleted;

  useEffect(() => {
    if (!isLive) return;
    setLiveNow(Date.now());
    const interval = setInterval(() => {
      setLiveNow(Date.now());
    }, 250);
    return () => clearInterval(interval);
  }, [isLive]);

  const canonicalStartTime = getHighResInMs(span.startTime);
  const canonicalEndTime = getHighResInMs(span.endTime);
  const canonicalDuration = getHighResInMs(span.duration);
  const canonicalActiveStartTime = span.activeStartTime
    ? getHighResInMs(span.activeStartTime)
    : undefined;

  const durationMs =
    terminalTimestamp != null
      ? Math.max(0, terminalTimestamp - canonicalStartTime)
      : isLive
        ? Math.max(0, (liveNow || Date.now()) - canonicalStartTime)
        : canonicalDuration;
  const duration = node.isInstrumentationHint
    ? 'Get Started'
    : formatDuration(durationMs);
  const baseNode = {
    ...node,
    startTime: canonicalStartTime,
    endTime: canonicalEndTime,
    duration: canonicalDuration,
    activeStartTime: canonicalActiveStartTime,
  } as VisibleSpan;
  const segmentNode = isLive
    ? ({
        ...baseNode,
        duration: durationMs,
        endTime: canonicalStartTime + durationMs,
      } as VisibleSpan)
    : baseNode;
  const hasSegments =
    isWorkflowSpan &&
    computeSegments(resourceType, segmentNode).segments.length > 0;
  const layout = getSpanLayout(
    resourceType,
    segmentNode,
    root,
    scale,
    scrollSnapshotRef
  );

  // For live spans the data-level `node.duration` can be stale (from the last
  // fetch) while the visual width is growing via rAF. Recompute from real
  // elapsed time so that:
  //  - height/isSmall classification stays correct (not shrunken to 40%)
  //  - React-rendered width matches the rAF-driven width, preventing a brief
  //    shrink→expand flash on re-render that breaks cursor hit-testing
  if (isLive) {
    const elapsed = durationMs;
    const liveActualWidth = elapsed * scale;
    const liveWidth = Math.max(liveActualWidth, 4);
    layout.actualWidth = liveActualWidth;
    layout.width = liveWidth;
    layout.isSmall = liveActualWidth < 64;
    layout.isHuge = liveActualWidth >= 500;
    if (!layout.isSmall) {
      layout.height = ROW_HEIGHT;
      layout.top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * segmentNode.row;
    }
  }

  // Smoothly grow active span width at 60fps using wall clock time
  useEffect(() => {
    if (!isLive || !ref.current) return;

    let rafId = 0;
    const tick = (): void => {
      const $el = ref.current;
      if (!$el) return;
      const elapsed = Date.now() - canonicalStartTime;
      const w = Math.max(elapsed * scale, 2);
      $el.style.width = `${w}px`;
      $el.style.setProperty('--span-width', `${w}px`);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLive, canonicalStartTime, scale]);

  const renderNode = segmentNode;

  return (
    <>
      <button
        aria-label={`${span.name} - ${duration}`}
        className={clsx(
          styles.spanNode,
          layout.isHuge && styles.huge,
          layout.isSmall && styles.small,
          layout.isExpanded && styles.xHover,
          node.isHighlighted
            ? styles.colorHighlight
            : getSpanColorClassName(node),
          node.isHighlighted === false && styles.unlit,
          customClassName,
          hasSegments && styles.hasSegments
        )}
        data-span-id={span.spanId}
        data-start-time={segmentNode.startTime - root.startTime}
        data-right-side={layout.isNearRightSide}
        data-selected={node.isSelected ? '' : undefined}
        ref={ref}
        style={getSpanStyle(layout, segmentNode, root, scale)}
        type="button"
      >
        <SpanContent
          durationMs={durationMs}
          resourceType={resourceType}
          node={renderNode}
          layout={layout}
        />
      </button>
      {segmentNode.events && !layout.isSmall
        ? segmentNode.events.map((x) => (
            <SpanEventComponent
              customSpanEventClassNameFunc={customSpanEventClassNameFunc}
              event={x}
              key={x.key}
              node={segmentNode}
              root={root}
              scale={scale}
              asBoundary={isWorkflowSpan}
            />
          ))
        : null}
    </>
  );
});

// ──────────────────────────────────────────────────────────────────────────
// SpanEventComponent
// ──────────────────────────────────────────────────────────────────────────

/** Human-readable labels for workflow event types */
const BOUNDARY_LABELS: Record<string, string> = {
  step_started: 'Started',
  step_retrying: 'Retrying',
  step_failed: 'Failed',
  hook_created: 'Created',
  hook_received: 'Received',
  hook_disposed: 'Resolved',
  wait_created: 'Sleep started',
  wait_completed: 'Sleep completed',
  run_started: 'Started',
  run_completed: 'Completed',
  run_failed: 'Run failed',
  step_completed: 'Completed',
};

export const SpanEventComponent = memo(function SpanEventComponent({
  event,
  node,
  root,
  scale,
  customSpanEventClassNameFunc,
  asBoundary = false,
}: {
  event: VisibleSpanEvent;
  node: VisibleSpan;
  root: RootNode;
  scale: number;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
  asBoundary?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    event.ref = ref;
    return () => {
      event.ref = undefined;
    };
  }, [event]);

  const {
    event: { name },
  } = event;
  const timestamp = formatDuration(event.timestamp - root.startTime);
  const displayLabel = asBoundary ? (BOUNDARY_LABELS[name] ?? name) : name;

  // For boundary events, compute the duration of the phase.
  // "Forward" events (started, retrying) measure until the next event.
  // "Terminal" events (completed) measure from the previous started event.
  const isForwardEvent =
    asBoundary &&
    (name === 'step_started' ||
      name === 'run_started' ||
      name === 'step_retrying');
  const isTerminalEvent =
    asBoundary && (name === 'step_completed' || name === 'run_completed');

  let phaseDuration: string | null = null;
  let phaseLabel: string | null = null;
  if ((isForwardEvent || isTerminalEvent) && node.events) {
    const sortedNodeEvents = [...node.events].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    const currentIdx = sortedNodeEvents.findIndex((e) => e.key === event.key);

    if (isTerminalEvent) {
      // Look backward to find the last step_started
      let prevStartTime: number | null = null;
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (sortedNodeEvents[i].event.name === 'step_started') {
          prevStartTime = sortedNodeEvents[i].timestamp;
          break;
        }
      }
      if (prevStartTime !== null) {
        phaseDuration = formatDuration(event.timestamp - prevStartTime);
        phaseLabel = 'Executed';
      }
    } else {
      // Look forward to the next event
      const nextEvent = sortedNodeEvents[currentIdx + 1];
      const endTime = nextEvent ? nextEvent.timestamp : node.endTime;
      phaseDuration = formatDuration(endTime - event.timestamp);
      phaseLabel = name === 'step_retrying' ? 'Waited' : 'Executed';
    }
  }

  const left = (event.timestamp - root.startTime) * scale;
  const top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * node.row;
  const isLeftAligned =
    node.duration <= 0 ||
    (event.timestamp - node.startTime) / node.duration < 0.5;

  // Get custom class name from callback if provided
  const customClassName = customSpanEventClassNameFunc
    ? customSpanEventClassNameFunc(event)
    : '';

  return (
    <div
      title={
        phaseDuration
          ? `${displayLabel} ${timestamp}\n${phaseLabel} ${phaseDuration}`
          : `${displayLabel} ${timestamp}`
      }
      className={clsx(
        styles.spanNodeEvent,
        customClassName,
        asBoundary && styles.boundaryMarker,
        node.isHighlighted
          ? styles.colorHighlight
          : getSpanColorClassName(node),
        node.isHighlighted === false && styles.unlit
      )}
      data-hovered={event.isHovered}
      ref={ref}
      style={
        {
          left,
          top,
        } as CSSProperties
      }
    >
      <div
        className={clsx(
          styles.hoverInfo,
          isLeftAligned ? styles.alignStart : styles.alignEnd
        )}
      >
        {asBoundary ? (
          <>
            <span className={styles.eventName}>{displayLabel}</span>
            <span className={styles.eventTimestamp}>{timestamp}</span>
            {phaseDuration ? (
              <>
                <span className={styles.eventName}>{phaseLabel}</span>
                <span className={styles.eventTimestamp}>{phaseDuration}</span>
              </>
            ) : null}
          </>
        ) : (
          <>
            <span className={styles.eventName}>{name}</span>
            <span className={styles.eventTimestamp}>{timestamp}</span>
          </>
        )}
      </div>
      {asBoundary ? (
        <div className={styles.boundaryLine} />
      ) : (
        <div className={styles.eventDiamond} />
      )}
    </div>
  );
});
