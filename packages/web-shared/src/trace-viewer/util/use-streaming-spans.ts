import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { getSpanClassName } from '../components/node';
import { useTraceViewer } from '../context';
import type {
  VisibleSpan,
  VisibleSpanEvent,
  WorkerRequest,
  WorkerResponse,
} from '../types';
import {
  MARKER_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING,
  TIMELINE_PADDING,
} from './constants';
import { adjustSpanVisibility } from './tree';

type UpdateFilter = (filter: string) => void;

interface QueuedSpan {
  /** The distance from this span to the viewport */
  d: number;
  /** The span that's waiting to be rendered */
  span: VisibleSpan;
}

function emptyArrayInit<T>(): T[] {
  return [];
}

export const useStreamingSpans = (
  highlightedSpans?: string[]
): {
  rows: VisibleSpan[][];
  spans: VisibleSpan[];
  events: VisibleSpanEvent[];
  scale: number;
} => {
  const { state, dispatch } = useTraceViewer();
  const {
    root,
    filter: ctxFilter,
    scale,
    timelineRef,
    timelineWidth,
    spanMap,
    scrollSnapshotRef,
    selected,
    memoCacheRef,
    customSpanClassNameFunc,
  } = state;
  const timelineHeight = useStableValue(state.timelineHeight);
  const counterRef = useRef(0);
  const [rows, setRows] = useState<VisibleSpan[][]>(emptyArrayInit);
  const [visibleSpans, setVisibleSpans] =
    useState<VisibleSpan[]>(emptyArrayInit);
  const [visibleEvents, setVisibleEvents] =
    useState<VisibleSpanEvent[]>(emptyArrayInit);
  const [resultScale, setResultScale] = useState(-1);

  const updateFilterRef = useRef<UpdateFilter>(undefined);
  useEffect(() => updateFilterRef.current?.(ctxFilter), [ctxFilter]);

  useEffect(() => {
    if (!highlightedSpans?.length) return;

    for (const row of rows) {
      for (const node of row) {
        const isHighlighted = highlightedSpans.includes(node.span.spanId);
        if (node.isHighlighted === isHighlighted) continue;
        node.isHighlighted = isHighlighted;
        memoCacheRef.current.set(node.span.spanId, {});
      }
    }
    dispatch({
      type: 'forceRender',
    });
  }, [rows, highlightedSpans, dispatch, memoCacheRef]);

  useEffect(() => {
    if (!root.startTime) return;

    const worker = new Worker(new URL('../worker', import.meta.url));
    let requestId = ++counterRef.current;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as WorkerResponse;

      switch (data.type) {
        case 'setRowsResult': {
          if (data.isEnd) {
            for (const row of data.rows) {
              for (const node of row) {
                // Ensure that we remap to the original span to reduce memory overhead
                // and confusion down the line
                node.span = spanMap[node.span.spanId]?.span ?? node.span;
              }
            }
          }
          setRows(data.rows);
          break;
        }
        case 'updateHighlight': {
          if (data?.requestId !== requestId) return;
          const { matches } = data;
          setRows((previous) => {
            for (const row of previous) {
              for (const node of row) {
                const isHighlighted = matches.has(node.span.spanId);
                if (node.isHighlighted === isHighlighted) continue;
                node.isHighlighted = isHighlighted;
                memoCacheRef.current.set(node.span.spanId, {});
              }
            }
            return previous;
          });
          dispatch({
            type: 'forceRender',
          });
          break;
        }
        default:
          break;
      }
    };
    worker.addEventListener('message', onMessage);

    const message: WorkerRequest = {
      requestId,
      type: 'calculateSpanPositions',
      root,
    };
    worker.postMessage(message);

    updateFilterRef.current = (_filter) => {
      const filter = _filter.trim().toLocaleLowerCase();
      if (!filter) {
        setRows((previous) =>
          previous.map((row) =>
            row.map((node) => {
              node.isHighlighted = undefined;
              return {
                ...node,
              };
            })
          )
        );
        return;
      }

      requestId = ++counterRef.current;
      const filterMessage: WorkerRequest = {
        type: 'filterSpans',
        requestId,
        root,
        filter,
      };
      worker.postMessage(filterMessage);
    };

    return () => {
      worker.terminate();
    };
  }, [root, spanMap, dispatch, memoCacheRef]);

  useEffect(() => {
    if (!rows.length) return;

    const $timeline = timelineRef.current;
    let snapshot = scrollSnapshotRef.current;
    let hasScrolled = false;
    let isDone = false;
    let maxD = 0;
    let currentD = 0;
    const overscan = Math.max(500, timelineWidth * 0.5);
    const queue = new Array<QueuedSpan[] | null>(rows.length).fill(null);

    const buildQueue = (): void => {
      isDone = true;

      const lastRow = Math.min(
        1 + currentD + Math.ceil(snapshot?.endRow ?? Number.POSITIVE_INFINITY),
        rows.length
      );
      for (let i = lastRow; i--; ) {
        if (queue[i]) continue;
        const rowDelta = getRowDelta(i);
        if (Math.abs(rowDelta) > currentD) {
          isDone = false;
          if (rowDelta > 0) {
            continue;
          } else {
            break;
          }
        }

        const queueRow: QueuedSpan[] = [];
        const row = rows[i];
        if (!row) continue;

        for (const span of row) {
          if (!adjustSpanVisibility(span, scale)) continue;

          const d = getDistance(span);
          maxD = Math.max(d, maxD);

          queueRow.push({
            d,
            span,
          });
        }

        queue[i] = queueRow;
      }
    };

    /**
     * This returns the signed distance between the row and the targeted rows
     */
    const getRowDelta = (row: number): number => {
      if (!snapshot) return 0;

      if (row < snapshot.startRow) {
        return row - snapshot.startRow;
      } else if (row > snapshot.endRow) {
        return row - snapshot.endRow;
      }

      return 0;
    };

    const getDistance = (span: VisibleSpan): number => {
      if (!snapshot) return 0;

      let xDistance = 0;
      if (span.endTime < snapshot.startTime) {
        xDistance = snapshot.startTime - span.endTime;
      } else if (span.startTime > snapshot.endTime) {
        xDistance = span.startTime - snapshot.endTime;
      }

      const yDistance = Math.abs(getRowDelta(span.row));

      if (!xDistance && !yDistance) return 0;

      return Math.sqrt(
        (xDistance / scale) ** 2 + (yDistance * ROW_HEIGHT + ROW_PADDING) ** 2
      );
    };

    const updateSnapshot = (): void => {
      if (!$timeline) return;

      const { scrollLeft, scrollTop } = $timeline;
      const anchorX = 0;
      const anchorT = scrollLeft / scale;
      const startRow =
        (scrollTop - MARKER_HEIGHT - TIMELINE_PADDING) /
        (ROW_HEIGHT + ROW_PADDING);
      const endRow =
        startRow + Math.ceil(timelineHeight / (ROW_HEIGHT + ROW_PADDING));

      snapshot = {
        anchorT,
        anchorX,
        scrollLeft,
        scrollTop,
        startTime: root.startTime + scrollLeft / scale,
        endTime: root.startTime + (scrollLeft + timelineWidth) / scale,
        startRow,
        endRow,
        scale,
      };
      scrollSnapshotRef.current = snapshot;

      for (let i = queue.length; i--; ) {
        queue[i] = null;
      }
    };

    let nextFrame = 0;
    const onFrame = (): void => {
      if (hasScrolled || !snapshot) {
        hasScrolled = false;
        updateSnapshot();
      }
      buildQueue();
      const visible: VisibleSpan[] = [];
      const events: VisibleSpanEvent[] = [];
      for (const row of queue) {
        if (!row) continue;

        for (const { d, span } of row) {
          if (d > currentD) continue;
          visible.push(span);
          if (span.events) {
            events.push(...span.events);
          }
        }
      }

      if (currentD < overscan && (!isDone || currentD < maxD)) {
        currentD = Math.min(overscan, currentD + 100);
        nextFrame = requestAnimationFrame(onFrame);
      }

      setVisibleSpans(visible);
      setVisibleEvents(events);
      setResultScale(scale);
    };
    onFrame();

    let ignoreT = Date.now();
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        ignoreT = Date.now();
      }
    };
    $timeline?.addEventListener('wheel', onWheel);

    const onScroll = (): void => {
      if (Date.now() - ignoreT <= 50) return;

      hasScrolled = true;
      cancelAnimationFrame(nextFrame);
      nextFrame = requestAnimationFrame(onFrame);
    };
    $timeline?.addEventListener('scroll', onScroll);

    return () => {
      cancelAnimationFrame(nextFrame);
      $timeline?.removeEventListener('wheel', onWheel);
      $timeline?.removeEventListener('scroll', onScroll);
    };
  }, [
    rows,
    root,
    scale,
    scrollSnapshotRef,
    timelineRef,
    timelineWidth,
    timelineHeight,
  ]);

  useEffect(() => {
    if (!selected) return;

    let span: VisibleSpan | undefined;
    for (const x of visibleSpans) {
      if (x.span.spanId === selected.span.spanId) {
        span = x;
        break;
      }
    }

    const $span = span?.ref?.current;
    if (!span || !$span) return;

    span.isSelected = true;
    // Get both the base span className and custom class name
    const baseClassName = getSpanClassName(span, scale);
    const customClassName = customSpanClassNameFunc
      ? customSpanClassNameFunc(span)
      : '';
    $span.className = clsx(baseClassName, customClassName);

    return () => {
      span.isSelected = false;
      const baseClassName = getSpanClassName(span, scale);
      const customClassName = customSpanClassNameFunc
        ? customSpanClassNameFunc(span)
        : '';
      $span.className = clsx(baseClassName, customClassName);
    };
  }, [visibleSpans, scale, selected, customSpanClassNameFunc]);

  return {
    rows,
    spans: visibleSpans,
    events: visibleEvents,
    scale: resultScale,
  };
};

/**
 * This hook keeps returning the same value until the current value
 * has been stable for a few frames in a row
 */
function useStableValue<T>(value: T): T {
  const [cached, setCached] = useState(value);

  useEffect(() => {
    if (cached === value) return;

    let frameCount = 0;
    let nextFrame = 0;
    const onFrame = (): void => {
      if (++frameCount <= 3) {
        nextFrame = requestAnimationFrame(onFrame);
        return;
      }

      setCached(value);
    };
    onFrame();

    return () => {
      cancelAnimationFrame(nextFrame);
    };
  }, [cached, value]);

  return cached;
}
