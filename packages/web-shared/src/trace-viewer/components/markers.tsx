import { clsx } from 'clsx';
import type {
  CSSProperties,
  Dispatch,
  MutableRefObject,
  ReactNode,
} from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { type TraceViewerAction, useTraceViewer } from '../context';
import styles from '../trace-viewer.module.css';
import type {
  MemoCache,
  RootNode,
  ScrollSnapshot,
  VisibleSpan,
  VisibleSpanEvent,
} from '../types';
import {
  MARKER_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING,
  TIMELINE_PADDING,
} from '../util/constants';
import { formatDurationForTimeline, formatTimeSelection } from '../util/timing';
import { useImmediateStyle } from '../util/use-immediate-style';
import { useTrackpadZoom } from '../util/use-trackpad-zoom';

const DIVISORS = [1, 2, 4, 5, 8, 10];

export function Markers({ scale }: { scale: number }): ReactNode {
  const {
    state: { root },
  } = useTraceViewer();

  const fullDuration = root.duration;
  const logFull = Math.floor(Math.log10(fullDuration));
  const logHalf = Math.floor(Math.log10(fullDuration * 0.5));
  let markerDuration = Math.max(
    2,
    10 ** logFull * (logHalf === logFull ? 1 : 0.5)
  );
  let markerWidth = markerDuration * scale;
  let divisor = 1;
  for (const d of DIVISORS) {
    if (markerDuration / d < 24) break;
    divisor = d;
  }
  markerDuration /= divisor;
  markerWidth /= divisor;
  const markerCount = Math.ceil(fullDuration / markerDuration);

  // How often labels should appear for markers, e.g. 3 === one label for every third marker
  const labelSpacing = Math.ceil(100 / markerWidth) || 1;

  return (
    <div className={styles.markersContainer}>
      <div
        aria-hidden
        className={styles.markers}
        style={
          {
            width: Math.floor(root.duration * scale + 15),
            visibility: scale !== -1 ? 'visible' : 'hidden',
            '--marker-width': `${markerWidth}px`,
          } as CSSProperties
        }
      >
        {new Array(markerCount).fill(null).map((_, i) => {
          const hasLabel = i % labelSpacing === 0;
          return (
            <span
              className={clsx(styles.marker, !hasLabel && styles.notch)}
              key={String(i)}
            >
              {hasLabel ? (
                <span className={styles.markerLabel}>
                  {formatDurationForTimeline(markerDuration * i)}
                </span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function EventMarkers({
  events,
  root,
  scale,
}: {
  events: VisibleSpanEvent[];
  root: RootNode;
  scale: number;
}): ReactNode {
  // Filter out events that should not show vertical lines (workflow-specific feature)
  const eventsWithVerticalLines = useMemo(
    () => events.filter((x) => x.event.showVerticalLine !== false),
    [events]
  );

  return (
    <div className={styles.eventMarkersContainer}>
      <div
        aria-hidden
        className={styles.eventMarkers}
        style={
          {
            width: Math.floor(root.duration * scale),
          } as CSSProperties
        }
      >
        {eventsWithVerticalLines.map((x) => {
          return (
            <span
              className={clsx(styles.eventMarker)}
              key={x.key}
              style={{
                left: Math.floor((x.timestamp - root.startTime) * scale),
                ...(x.event.color && { borderLeftColor: x.event.color }),
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

const HOVER_OVERSCAN = 2;

interface TrackpadZoom {
  anchorX: number;
  anchorT: number;
}

export function CursorMarker({
  memoCacheRef,
  timelineRef,
  root,
  spans,
  events,
  scale,
  dispatch,
  scrollSnapshotRef,
}: {
  memoCacheRef: MutableRefObject<MemoCache>;
  timelineRef: MutableRefObject<HTMLDivElement | null>;
  root: RootNode;
  spans: VisibleSpan[];
  events: VisibleSpanEvent[];
  scale: number;
  dispatch: Dispatch<TraceViewerAction>;
  scrollSnapshotRef: MutableRefObject<ScrollSnapshot | undefined>;
}): ReactNode {
  const hasEnteredRef = useRef(false);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const labelRef = useRef<HTMLDivElement>(null);
  const { style: labelStyle, setStyle: setLabelStyle } =
    useImmediateStyle(labelRef);
  const labelTextRef = useRef<HTMLDivElement>(null);

  const ref = useRef<HTMLDivElement>(null);
  const { style, setStyle } = useImmediateStyle(ref);
  const rectRef = useRef<DOMRect>(undefined);

  const selectionRef = useRef<HTMLDivElement>(null);
  const { style: selectionStyle, setStyle: setSelectionStyle } =
    useImmediateStyle(selectionRef);

  const xRef = useRef(0);
  useEffect(() => {
    const $timeline = timelineRef.current;
    if (!$timeline) return;

    let x = xRef.current;
    let xStart = 0;
    let isDragging = false;
    let isExternalDrag = false;
    let hasMoved = false;
    let isRightClick = false;
    let scrollX = 0;
    let scrollY = 0;
    const hoverStartT = Date.now() + 500;
    const updateRect = (): void => {
      if (rectRef.current) return;
      rectRef.current = $timeline.getBoundingClientRect();
    };

    const getRowFromY = (y: number): number => {
      if (!rectRef.current) return 0;
      return (
        (y - MARKER_HEIGHT - TIMELINE_PADDING) / (ROW_HEIGHT + ROW_PADDING)
      );
    };

    const removeHover = (): void => {
      const cache = memoCacheRef.current;
      // Remove hover styling from any elements that have it
      for (const span of spansRef.current) {
        if (!span.isHovered) continue;
        span.isHovered = false;
        cache.set(span.span.spanId, {});
      }
      dispatch({
        type: 'forceRender',
      });
    };

    let nextFrame = 0;
    const onFrame = (): void => {
      if (!hasEnteredRef.current) return;
      if (!rectRef.current) updateRect();
      const rect = rectRef.current;
      if (!rect) return;

      const { scrollLeft, scrollTop } = $timeline;

      const left = Math.max(
        0,
        Math.min(
          x + scrollLeft - rect.left - TIMELINE_PADDING,
          root.duration * scale
        )
      );
      const leftStyle = `${left - scrollLeft + TIMELINE_PADDING}px`;
      setStyle('left', leftStyle);
      setLabelStyle('left', leftStyle);

      const t = root.startTime + left / scale;
      const labelT = t - root.startTime;
      if (labelT < 0 || labelT > root.duration) {
        labelTextRef.current?.removeAttribute('data-text');
      } else {
        labelTextRef.current?.setAttribute(
          'data-text',
          formatTimeSelection(labelT)
        );
      }

      if (isDragging) {
        const xDelta = x - xStart;
        const width = Math.abs(xDelta);
        if (!hasMoved) {
          if (width < 4) return;
          hasMoved = true;
          setSelectionStyle('display', 'flex');
          removeHover();
        }

        if (xDelta > 0) {
          setSelectionStyle('left', '');
          setSelectionStyle('right', '0');
        } else {
          setSelectionStyle('left', '0');
          setSelectionStyle('right', '');
        }
        setSelectionStyle('width', `${width}px`);

        const leftStart = Math.max(
          0,
          Math.min(
            xStart + scrollLeft - rect.left - TIMELINE_PADDING,
            root.duration * scale
          )
        );
        const labelTStart = leftStart / scale;
        let t1: number;
        let t2: number;
        if (labelTStart < labelT) {
          t1 = labelTStart;
          t2 = labelT;
        } else {
          t1 = labelT;
          t2 = labelTStart;
        }
        selectionRef.current?.setAttribute(
          'data-range',
          `${formatTimeSelection(t1)} — ${formatTimeSelection(t2)}`
        );
        selectionRef.current?.setAttribute(
          'data-duration',
          `${formatTimeSelection(t2 - t1)} selected`
        );
      }

      if (Date.now() < hoverStartT) {
        nextFrame = requestAnimationFrame(onFrame);
        return;
      }

      if (scrollLeft !== scrollX || scrollTop !== scrollY) {
        scrollX = scrollLeft;
        scrollY = scrollTop;
        nextFrame = requestAnimationFrame(onFrame);
        return;
      }

      if (x - rect.left < 128) {
        labelTextRef.current?.setAttribute('data-align', 'left');
      } else if (x - rect.left > rect.width - 128) {
        labelTextRef.current?.setAttribute('data-align', 'right');
      } else {
        labelTextRef.current?.removeAttribute('data-align');
      }

      if (!hasMoved && !isExternalDrag) {
        const cache = memoCacheRef.current;

        // Span Hover
        const rowMin = getRowFromY(scrollTop) - HOVER_OVERSCAN;
        const rowMax = getRowFromY(scrollTop + rect.height) + HOVER_OVERSCAN;
        for (const span of spansRef.current) {
          const isHovered =
            span.row >= rowMin &&
            span.row <= rowMax &&
            t >= span.startTime &&
            t <= span.endTime;
          if (span.isHovered === isHovered) continue;
          span.isHovered = isHovered;
          cache.set(span.span.spanId, {});
        }

        // Event Hover
        const eventSpreadPx = 12;
        const eventSpreadMs = eventSpreadPx / scale;
        for (const event of eventsRef.current) {
          const isHovered =
            t >= event.timestamp - eventSpreadMs &&
            t <= event.timestamp + eventSpreadMs;
          if (event.isHovered === isHovered) continue;
          event.isHovered = isHovered;
          const $event = event.ref?.current;
          if (!$event) continue;
          $event.setAttribute('data-hovered', String(isHovered));
        }

        dispatch({
          type: 'forceRender',
        });
      }
    };
    nextFrame = requestAnimationFrame(onFrame);

    const onPointerEnter = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      hasEnteredRef.current = true;
    };
    const onPointerLeave = (): void => {
      if (!hasEnteredRef.current) return;
      hasEnteredRef.current = false;
      removeHover();
    };

    const onMouseMove = ({ clientX }: MouseEvent): void => {
      x = clientX;
      xRef.current = x;
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button === 2) {
        isRightClick = true;
        event.preventDefault();
      } else if (event.button !== 0) {
        return;
      } else {
        isRightClick = false;
      }
      if (timelineRef.current?.contains(event.target as HTMLElement)) {
        xStart = x;
        isDragging = true;
      } else {
        isExternalDrag = true;
        requestAnimationFrame(removeHover);
      }
    };
    const onMouseUp = (event: Event): void => {
      isExternalDrag = false;

      if (!isDragging) return;
      isDragging = false;

      if (!hasMoved) return;
      hasMoved = false;
      setSelectionStyle('display', '');
      setSelectionStyle('left', '');
      setSelectionStyle('right', '');
      setSelectionStyle('width', '');

      event.preventDefault();
      event.stopImmediatePropagation();

      if (isRightClick) {
        isRightClick = false;
        return;
      }

      if (!rectRef.current) updateRect();
      const rect = rectRef.current;
      if (!rect) return;

      const { scrollLeft } = $timeline;

      const start = Math.max(
        0,
        Math.min(
          (xStart + scrollLeft - rect.left - TIMELINE_PADDING) / scale,
          root.duration
        )
      );
      const end = Math.max(
        0,
        Math.min(
          (x + scrollLeft - rect.left - TIMELINE_PADDING) / scale,
          root.duration
        )
      );

      dispatch({
        type: 'scaleToRange',
        t1: start + root.startTime,
        t2: end + root.startTime,
      });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isDragging) return;
      if (event.key !== 'Escape') return;

      isRightClick = true;
      onMouseUp(event);
    };

    const onWindowScroll = (): void => {
      rectRef.current = undefined;
      trackpadZoomRef.current = undefined;
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };

    const onScroll = (): void => {
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };

    const observer = new ResizeObserver(() => {
      // NOTE: I tried to use the entry from this to immediately set the rect,
      // but for some reason it has different dimensions than the one from
      // .getBoundingClientRect()
      rectRef.current = undefined;
    });
    observer.observe($timeline);

    window.addEventListener('mousemove', onMouseMove);
    $timeline.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onWindowScroll);
    $timeline.addEventListener('scroll', onScroll);
    $timeline.addEventListener('pointerenter', onPointerEnter);
    $timeline.addEventListener('pointerleave', onPointerLeave);

    return () => {
      observer.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      $timeline.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onWindowScroll);
      $timeline.removeEventListener('scroll', onScroll);
      $timeline.removeEventListener('pointerenter', onPointerEnter);
      $timeline.removeEventListener('pointerleave', onPointerLeave);
      cancelAnimationFrame(nextFrame);
      xRef.current = x;
      removeHover();
    };
  }, [
    dispatch,
    root,
    scale,
    setStyle,
    setLabelStyle,
    setSelectionStyle,
    memoCacheRef,
    timelineRef,
    scrollSnapshotRef,
  ]);

  const trackpadZoomRef = useRef<TrackpadZoom>(undefined);
  useTrackpadZoom((delta) => {
    const $timeline = timelineRef.current;
    if (!$timeline) return;

    rectRef.current ??= $timeline.getBoundingClientRect();
    const rect = rectRef.current;
    const anchorX = Math.max(
      0,
      Math.min(
        xRef.current - rect.left - TIMELINE_PADDING,
        rect.width - 2 * TIMELINE_PADDING
      )
    );

    let anchorT = 0;
    let existing = trackpadZoomRef.current;
    if (existing?.anchorX === anchorX) {
      anchorT = existing.anchorT;
    } else {
      anchorT = ($timeline.scrollLeft + anchorX) / scale;
      existing = {
        anchorT,
        anchorX,
      };
      trackpadZoomRef.current = existing;
    }

    dispatch({
      type: 'trackpadScale',
      delta: delta / 64,
      anchorT,
      anchorX,
    });
  });

  return (
    <>
      <div className={styles.cursorMarkerStickyParent}>
        <div
          className={styles.cursorMarkerLabelContainer}
          ref={labelRef}
          style={labelStyle}
        >
          <div className={styles.cursorMarkerLabel} ref={labelTextRef} />
        </div>
      </div>
      <div className={styles.cursorMarkerStickyParent}>
        <div className={styles.cursorMarkerContainer} ref={ref} style={style}>
          <div className={styles.cursorMarker}>
            <div
              className={styles.cursorSelection}
              ref={selectionRef}
              style={selectionStyle}
            />
          </div>
        </div>
      </div>
    </>
  );
}
