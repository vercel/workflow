'use client';

import { clsx } from 'clsx';
import type { CSSProperties, MutableRefObject, ReactNode } from 'react';
import { memo, useEffect, useRef } from 'react';
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
import { formatDuration } from '../util/timing';
import { SpanContent } from './span-content';
import { computeSegments } from './span-segments';
import {
  type SpanLayout,
  getResourceType,
  getSpanLayout,
} from './span-strategies';

export const getSpanColorClassName = (node: SpanNode): string => {
  if (node.isVercel) return String(styles.colorVercel);
  return String(styles[`color${node.resourceIndex % 5}` as 'color0']);
};

export const SpanNodes = memo(function SpanNodes({
  root,
  scale,
  spans,
  scrollSnapshotRef,
  cache,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
}: {
  root: RootNode;
  scale: number;
  spans: VisibleSpan[];
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
  scrollSnapshotRef,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
}: {
  node: VisibleSpan;
  root: RootNode;
  scale: number;
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
  const layout = getSpanLayout(
    resourceType,
    node,
    root,
    scale,
    scrollSnapshotRef
  );

  const duration = node.isInstrumentationHint
    ? 'Get Started'
    : formatDuration(node.duration);

  // Get custom class name from callback if provided
  const customClassName = customSpanClassNameFunc
    ? customSpanClassNameFunc(node)
    : '';

  // Workflow span types use colored segments + boundary line markers
  // Generic OTEL spans use diamond event markers
  const isWorkflowSpan = resourceType !== 'default';
  const hasSegments =
    isWorkflowSpan && computeSegments(resourceType, node).segments.length > 0;

  // Determine if this span is still active (live).
  // A span is only "live" when the overall trace is still growing, i.e. the
  // root's endTime is being advanced by useLiveTick (within a few seconds of
  // now).  For completed runs root.endTime is a past timestamp, so no span
  // receives the live-growth animation — this prevents hooks that were never
  // explicitly disposed from expanding to infinity.
  const data = span.attributes?.data as Record<string, unknown> | undefined;
  const rootIsLive = root.endTime >= Date.now() - 10_000;
  const isLive =
    rootIsLive && isWorkflowSpan && data
      ? resourceType === 'hook'
        ? !data.disposedAt
        : !data.completedAt
      : false;

  // For live spans the data-level `node.duration` can be stale (from the last
  // fetch) while the visual width is growing via rAF. Recompute from real
  // elapsed time so that:
  //  - height/isSmall classification stays correct (not shrunken to 40%)
  //  - React-rendered width matches the rAF-driven width, preventing a brief
  //    shrink→expand flash on re-render that breaks cursor hit-testing
  if (isLive) {
    const elapsed = Date.now() - node.startTime;
    const liveActualWidth = elapsed * scale;
    const liveWidth = Math.max(liveActualWidth, 4);
    layout.actualWidth = liveActualWidth;
    layout.width = liveWidth;
    layout.isSmall = liveActualWidth < 64;
    layout.isHuge = liveActualWidth >= 500;
    if (!layout.isSmall) {
      layout.height = ROW_HEIGHT;
      layout.top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * node.row;
    }
  }

  // Smoothly grow active span width at 60fps using wall clock time
  useEffect(() => {
    if (!isLive || !ref.current) return;

    let rafId = 0;
    const tick = (): void => {
      const $el = ref.current;
      if (!$el) return;
      const elapsed = Date.now() - node.startTime;
      const w = Math.max(elapsed * scale, 2);
      $el.style.width = `${w}px`;
      $el.style.setProperty('--span-width', `${w}px`);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isLive, node.startTime, scale]);

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
        data-start-time={node.startTime - root.startTime}
        data-right-side={layout.isNearRightSide}
        data-selected={node.isSelected ? '' : undefined}
        ref={ref}
        style={getSpanStyle(layout, node, root, scale)}
        type="button"
      >
        <SpanContent resourceType={resourceType} node={node} layout={layout} />
      </button>
      {node.events && !layout.isSmall
        ? node.events.map((x) => (
            <SpanEventComponent
              customSpanEventClassNameFunc={customSpanEventClassNameFunc}
              event={x}
              key={x.key}
              node={node}
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
