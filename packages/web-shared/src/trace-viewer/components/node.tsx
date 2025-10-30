import { clsx } from 'clsx';
import type { CSSProperties, MutableRefObject, ReactNode } from 'react';
import { memo, useRef } from 'react';
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

const isSpanSmall = (node: VisibleSpan, scale: number): boolean =>
  node.duration * scale < 64;

const isSpanHuge = (node: VisibleSpan, scale: number): boolean =>
  node.duration * scale >= 500;

export const getSpanColorClassName = (node: SpanNode): string => {
  if (node.isVercel) return String(styles.colorVercel);
  return String(styles[`color${node.resourceIndex % 5}` as 'color0']);
};

export const getSpanClassName = (node: VisibleSpan, scale: number): string => {
  const isHuge = isSpanHuge(node, scale);
  const isHovered = node.isHovered && !isHuge && node.isHighlighted !== false;

  return clsx(
    styles.spanNode,
    isHuge && styles.huge,
    isSpanSmall(node, scale) && styles.small,
    node.isSelected && styles.selected,
    isHovered && styles.xHover,
    node.isHighlighted ? styles.colorHighlight : getSpanColorClassName(node),
    node.isHighlighted === false && styles.unlit
  );
};

const getDuration = (node: SpanNode): string => {
  if (node.isInstrumentationHint) {
    return 'Get Started';
  }

  return formatDuration(node.duration);
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
  cacheKey?: MemoCacheKey;
  customSpanClassNameFunc?: (span: SpanNode) => string;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
}): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);
  node.ref = ref;

  const { span } = node;
  const duration = getDuration(node);

  const left = (node.startTime - root.startTime) * scale;
  let top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * node.row;
  const actualWidth = node.duration * scale;
  // Enforce minimum width so very short spans are always visible
  const MIN_SPAN_WIDTH = 4;
  const width = Math.max(actualWidth, MIN_SPAN_WIDTH);
  let height = ROW_HEIGHT;
  const isHuge = isSpanHuge(node, scale);
  // Check if span is small based on actual width, not minimum width
  const isSmall = actualWidth < 64;
  const isHovered = node.isHovered && !isHuge && node.isHighlighted !== false;
  if (isSmall && !isHovered) {
    height *= 0.4;
    top += (ROW_HEIGHT - height) * 0.5;
  }

  let isNearRightSide = false;
  if (isHovered) {
    let { duration: visibleDuration, endTime: visibleEndTime } = root;
    const snapshot = scrollSnapshotRef.current;
    if (snapshot) {
      visibleDuration = snapshot.endTime - snapshot.startTime;
      visibleEndTime = snapshot.endTime;
    }
    isNearRightSide = visibleEndTime - node.startTime < 0.25 * visibleDuration;
  }

  // Get custom class name from callback if provided
  const customClassName = customSpanClassNameFunc
    ? customSpanClassNameFunc(node)
    : '';

  return (
    <>
      <button
        aria-label={`${span.name} - ${duration}`}
        className={clsx(getSpanClassName(node, scale), customClassName)}
        data-span-id={span.spanId}
        data-start-time={node.startTime - root.startTime}
        data-right-side={isNearRightSide}
        ref={ref}
        style={
          {
            // Use actualWidth for CSS variable so hover expansion is accurate
            '--span-width': `${Math.max(actualWidth, 1)}px`,
            minWidth: isHovered ? width : undefined,
            width: isHovered ? undefined : width,
            height,
            maxWidth:
              isHovered && !isNearRightSide
                ? (root.endTime - node.startTime) * scale
                : undefined,
            containIntrinsicWidth: isHovered ? undefined : width,
            containIntrinsicHeight: height,
            left: isNearRightSide ? undefined : left,
            right: isNearRightSide
              ? (root.endTime - node.endTime) * scale
              : undefined,
            top,
          } as CSSProperties
        }
        type="button"
      >
        {isSmall && !isHovered ? null : (
          <>
            <span className={styles.spanName}>{node.label || span.name}</span>
            {isHuge ? <span className={styles.spanSpacer} /> : null}
            {isHovered || width > 128 ? (
              <span className={styles.spanDuration}>{duration}</span>
            ) : null}
          </>
        )}
      </button>
      {node.events && !isSmall
        ? node.events.map((x) => (
            <SpanEventComponent
              customSpanEventClassNameFunc={customSpanEventClassNameFunc}
              event={x}
              key={x.key}
              node={node}
              root={root}
              scale={scale}
            />
          ))
        : null}
    </>
  );
});

export const SpanEventComponent = memo(function SpanEventComponent({
  event,
  node,
  root,
  scale,
  customSpanEventClassNameFunc,
}: {
  event: VisibleSpanEvent;
  node: VisibleSpan;
  root: RootNode;
  scale: number;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  event.ref = ref;

  const {
    event: { name },
  } = event;
  const timestamp = formatDuration(event.timestamp - root.startTime);

  const left = (event.timestamp - root.startTime) * scale;
  const top = MARKER_HEIGHT + (ROW_HEIGHT + ROW_PADDING) * node.row;

  // Get custom class name from callback if provided
  const customClassName = customSpanEventClassNameFunc
    ? customSpanEventClassNameFunc(event)
    : '';

  return (
    <div
      title={`${name} at ${timestamp}`}
      className={clsx(
        styles.spanNodeEvent,
        customClassName,
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
          (event.timestamp - node.startTime) / node.duration < 0.5
            ? styles.alignStart
            : styles.alignEnd
        )}
      >
        <span className={styles.eventName}>{name}</span>
        <span className={styles.eventTimestamp}>{timestamp}</span>
      </div>
      <div className={styles.eventDiamond} />
    </div>
  );
});
