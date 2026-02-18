'use client';

import { clsx } from 'clsx';
import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { MiniMap } from './components/map';
import { CursorMarker, EventMarkers, Markers } from './components/markers';
import { SpanNodes } from './components/node';
import { SearchBar } from './components/search';
import { SpanDetailPanel } from './components/span-detail-panel';
import { ZoomButton } from './components/zoom-button';
import { TraceViewerContextProvider, useTraceViewer } from './context';
import styles from './trace-viewer.module.css';
import type { GetQuickLinks, Trace } from './types';
import {
  MAP_HEIGHT,
  MARKER_HEIGHT,
  MARKER_NOTCH_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING,
  SEARCH_GAP,
  SEARCH_HEIGHT,
  TIMELINE_PADDING,
} from './util/constants';
import { parseTrace } from './util/tree';
import { useStreamingSpans } from './util/use-streaming-spans';

interface TraceViewerProps {
  trace?: Trace;
  className?: string;
  scrollLock?: boolean;
  height?: string | number;
  withPanel?: boolean;
  getQuickLinks?: GetQuickLinks;
  highlightedSpans?: string[];
  /** Render all spans immediately (no progressive streaming). */
  eagerRender?: boolean;
  /** Whether the trace is live (for continuous tick updates). */
  isLive?: boolean;
}

export function TraceViewerProvider({
  getQuickLinks,
  children,
}: Pick<TraceViewerProps, 'getQuickLinks'> & {
  children: ReactNode;
}): ReactNode {
  return (
    <TraceViewerContextProvider getQuickLinks={getQuickLinks}>
      {children}
    </TraceViewerContextProvider>
  );
}

interface LastClickRef {
  x: number;
  y: number;
  t: number;
  spanId: string;
}

const skeletonTrace: Trace = {
  traceId: 'skeleton',
  spans: [
    {
      parentSpanId: '',
      spanId: 'root',
      name: 'root span',
      kind: 1,
      resource: 'vercel.runtime',
      startTime: [5000, 0],
      endTime: [6000, 0],
      duration: [1000, 0],
      library: {
        name: 'vercel-site',
      },
      status: {
        code: 1,
      },
      attributes: {
        'vercel.ownerId': 'team_abc',
      },
      traceFlags: 1,
      events: [],
      links: [],
    },
  ],
  resources: [
    {
      name: 'vercel.runtime',
      attributes: {},
    },
  ],
  rootSpanId: 'root',
};

export function TraceViewerTimeline({
  trace = skeletonTrace,
  className = '',
  scrollLock = false,
  height,
  withPanel = false,
  highlightedSpans,
  eagerRender = false,
  isLive = false,
}: Omit<TraceViewerProps, 'getQuickLinks'>): ReactNode {
  const isSkeleton = trace === skeletonTrace;
  const { state, dispatch } = useTraceViewer();
  const { timelineRef, scrollSnapshotRef } = state;
  const memoCache = state.memoCacheRef.current;
  const hideSearchBar = (highlightedSpans?.length ?? 0) > 0;

  const hasInitializedRef = useRef(false);
  const prevSpanKeyRef = useRef('');
  const prevRootRef = useRef<ReturnType<typeof parseTrace>['root'] | null>(
    null
  );
  const prevSpanMapRef = useRef<ReturnType<typeof parseTrace>['map']>({});
  const prevSizeRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const { root: newRoot, map: newSpanMap } = parseTrace(trace);
    const isInitial = !hasInitializedRef.current;
    hasInitializedRef.current = true;

    // Build a structural key from span IDs + lightweight event signatures.
    // When only timing changes (same spans and boundary events), we can skip the
    // worker restart. When events change (step completed, etc.) we need a
    // full update because the VisibleSpan objects rendered by React hold
    // copies of the events from the worker — in-place mutation won't reach them.
    const spanKey = Object.keys(newSpanMap)
      .sort()
      .map((id) => {
        const events = newSpanMap[id].events;
        const count = events?.length ?? 0;
        const first = count ? events?.[0] : undefined;
        const last = count ? events?.[count - 1] : undefined;
        const eventSignature = `${first?.event.name ?? 'none'}@${first?.timestamp ?? 0}|${last?.event.name ?? 'none'}@${last?.timestamp ?? 0}`;
        return `${id}:${count}:${eventSignature}`;
      })
      .join(',');

    if (
      !isInitial &&
      spanKey === prevSpanKeyRef.current &&
      prevRootRef.current
    ) {
      // Same span set, same event counts — only timing changed.
      // Mutate in-place so the worker effect (which depends on root/spanMap
      // references) does NOT restart.
      const oldRoot = prevRootRef.current;
      const oldSpanMap = prevSpanMapRef.current;
      let didChange = false;

      if (
        oldRoot.endTime !== newRoot.endTime ||
        oldRoot.duration !== newRoot.duration
      ) {
        oldRoot.endTime = newRoot.endTime;
        oldRoot.duration = newRoot.duration;
        didChange = true;
      }

      for (const [id, newNode] of Object.entries(newSpanMap)) {
        const oldNode = oldSpanMap[id];
        if (oldNode) {
          if (
            oldNode.endTime !== newNode.endTime ||
            oldNode.duration !== newNode.duration
          ) {
            oldNode.endTime = newNode.endTime;
            oldNode.duration = newNode.duration;
            didChange = true;
          }
          Object.assign(oldNode.span, newNode.span);
        }
      }

      if (!didChange) {
        return;
      }

      // Trigger re-render (scale/markers) without restarting the worker.
      // useLiveTick handles continuous scale recalculation for live runs.
      dispatch({ type: 'forceRender' });
      return;
    }

    // Structure changed or initial load — full dispatch (worker computes new rows)
    prevSpanKeyRef.current = spanKey;
    prevRootRef.current = newRoot;
    prevSpanMapRef.current = newSpanMap;
    dispatch({
      type: isInitial ? 'setRoot' : 'updateRoot',
      root: newRoot,
      spanMap: newSpanMap,
      resources: trace.resources || [],
    });
  }, [dispatch, trace]);

  const { rows, spans, events, scale } = useStreamingSpans(
    highlightedSpans,
    eagerRender
  );

  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const $el = ref.current;
    if (!$el) return;

    const onResize = (): void => {
      const padding = 2 * TIMELINE_PADDING;
      const rect = $el.getBoundingClientRect();
      const nextWidth = rect.width - padding;
      const nextHeight = rect.height;
      const prevSize = prevSizeRef.current;

      if (
        prevSize &&
        prevSize.width === nextWidth &&
        prevSize.height === nextHeight
      ) {
        return;
      }
      prevSizeRef.current = { width: nextWidth, height: nextHeight };

      dispatch({
        type: 'setSize',
        width: nextWidth,
        height: nextHeight,
      });
    };

    onResize();

    const observer = new ResizeObserver(onResize);
    observer.observe($el);
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [dispatch]);

  const lastClickRef = useRef<LastClickRef>({
    t: 0,
    x: -1,
    y: -1,
    spanId: '',
  });
  const onClick: MouseEventHandler = useCallback(
    (event) => {
      // NOTE(wits): We manually implement double-click logic here so that we can support double
      // clicking a span even if the first click moves the span that the user is clicking on due
      // to the panel opening. If we used a regular double click listener we would need to delay
      // the opening of the panel artificially. This implementation allows us to always be
      // FAST while also avoiding a FRUSTRATING situation.
      const prev = lastClickRef.current;
      const t = Date.now();
      const { clientX: x, clientY: y } = event;
      const d = Math.sqrt((x - prev.x) ** 2 + (y - prev.y) ** 2);
      // double click
      if (t - prev.t <= 500 && d <= 8) {
        event.stopPropagation();
        event.preventDefault();
        if (!prev.spanId) {
          dispatch({
            type: 'resetScale',
          });
          return;
        }
        dispatch({
          type: 'select',
          id: prev.spanId,
        });
        dispatch({
          type: 'scaleToNode',
          id: prev.spanId,
        });
        return;
      }
      const target = event.target as HTMLElement;
      if (!target.closest(`.${String(styles.timeline)}`)) return;
      const $button = target.closest<HTMLButtonElement>('[data-span-id]');
      const spanId = $button?.dataset.spanId || '';
      lastClickRef.current = {
        x,
        y,
        t,
        spanId,
      };
      if (!spanId) return;
      dispatch({
        type: 'toggleSelection',
        id: spanId,
      });
      event.stopPropagation();
    },
    [dispatch]
  );

  // Zoom helper — apply the scroll snapshot once after a zoom operation so
  // the anchor point stays at the same screen position, then clear it.
  // Without clearing, live runs (where scale changes every frame via
  // detectBaseScale) would continuously reset scrollLeft and prevent the
  // user from scrolling horizontally.
  useLayoutEffect(() => {
    const $timeline = timelineRef.current;
    if (!$timeline) return;

    const snapshot = scrollSnapshotRef.current;
    if (snapshot) {
      $timeline.scrollLeft = snapshot.anchorT * scale - snapshot.anchorX;
      scrollSnapshotRef.current = undefined;
    }
  }, [scrollSnapshotRef, timelineRef, scale]);

  // Selection helper
  useEffect(() => {
    const spanId = state.selected?.span.spanId;
    if (!spanId) return;

    const timeout = setTimeout(() => {
      const $timeline = state.timelineRef.current;
      const $span = $timeline?.querySelector(`[data-span-id="${spanId}"]`);
      if (!$timeline || !$span) return;

      const viewRect = $timeline.getBoundingClientRect();
      const spanRect = $span.getBoundingClientRect();

      // If the selected span is narrower than the timeline, scroll it into view
      if (
        spanRect.width < viewRect.width &&
        (spanRect.left < viewRect.left ||
          spanRect.right > viewRect.right ||
          spanRect.top < viewRect.top ||
          spanRect.bottom > viewRect.bottom)
      ) {
        $span.scrollIntoView({
          block: 'nearest',
          inline: 'center',
          behavior: 'smooth',
        });
      }
    }, 500);

    return () => {
      clearTimeout(timeout);
    };
  }, [state.selected, state.timelineRef]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dispatch({
          type: 'escape',
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dispatch]);

  // Scroll locking
  useEffect(() => {
    if (!scrollLock) return;

    const $html = document.documentElement;
    const $body = document.body;

    $html.style.overflow = 'clip';
    $body.style.overflow = 'clip';

    const onScroll = (event?: Event): void => {
      if (event?.cancelable) {
        event.preventDefault();
      } else {
        window.scrollTo({
          left: 0,
          top: 0,
          behavior: 'instant',
        });
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, {
      passive: false,
    });

    return () => {
      $html.style.overflow = '';
      $body.style.overflow = '';
      window.removeEventListener('scroll', onScroll);
    };
  }, [scrollLock]);

  const timelineHeight = Math.max(
    state.timelineHeight - state.scrollbarWidth,
    MARKER_HEIGHT +
      ROW_PADDING +
      rows.length * (ROW_HEIGHT + ROW_PADDING) -
      ROW_PADDING +
      // When there are enough spans to be near the bottom edge, add some extra padding
      // to avoid overlapping with the zoom buttons, etc.
      84
  );

  const inert = Boolean(state.isMobile && state.selected);

  return (
    <div
      className={clsx(
        styles.traceViewer,
        isSkeleton && styles.skeleton,
        className
      )}
      onClickCapture={onClick}
      ref={ref}
      style={
        {
          height,
          '--timeline-padding': `${TIMELINE_PADDING}px`,
          '--row-height': `${ROW_HEIGHT}px`,
          '--row-padding': `${ROW_PADDING}px`,
          '--search-height': `${!hideSearchBar ? SEARCH_HEIGHT : 0}px`,
          '--search-gap': `${!hideSearchBar ? SEARCH_GAP : 2}px`,
          '--map-height': `${MAP_HEIGHT}px`,
          '--timeline-width': `${state.timelineWidth}px`,
          '--timeline-height': `${state.timelineHeight}px`,
          '--timeline-scroll-width': `${Math.round(state.root.duration * state.scale)}px`,
          '--panel-width': `${state.panelWidth}px`,
          '--panel-height': `${state.panelHeight}px`,
          '--height': `${state.height}px`,
          '--scrollbar-width': `${state.scrollbarWidth}px`,
          '--marker-height': `${MARKER_HEIGHT}px`,
          '--marker-notch-height': `${MARKER_NOTCH_HEIGHT}px`,
        } as CSSProperties
      }
    >
      {!hideSearchBar ? <SearchBar /> : null}
      <MiniMap rows={rows} scale={scale} timelineRef={timelineRef} />
      <div className={clsx(styles.traceViewerContent, inert && styles.inert)}>
        <div className={styles.timeline} ref={timelineRef}>
          <div
            style={{
              position: 'relative',
              width: state.timelineWidth,
              height: state.timelineHeight - TIMELINE_PADDING * 2,
              padding: TIMELINE_PADDING,
              paddingBottom: 0,
            }}
          >
            <div
              className={styles.traceNode}
              style={{
                width: state.root.duration * scale || undefined,
                height: timelineHeight - TIMELINE_PADDING * 2,
              }}
            >
              <Markers scale={scale} isLive={isLive} />
              <EventMarkers events={events} root={state.root} scale={scale} />
              <CursorMarker
                dispatch={dispatch}
                events={events}
                memoCacheRef={state.memoCacheRef}
                root={state.root}
                scale={scale}
                scrollSnapshotRef={scrollSnapshotRef}
                spans={spans}
                timelineRef={timelineRef}
              />
              <SpanNodes
                cacheKey={memoCache.get('')}
                cache={memoCache}
                customSpanClassNameFunc={state.customSpanClassNameFunc}
                customSpanEventClassNameFunc={
                  state.customSpanEventClassNameFunc
                }
                isLive={isLive}
                root={state.root}
                scale={scale}
                scrollSnapshotRef={scrollSnapshotRef}
                spans={spans}
              />
            </div>
          </div>
        </div>
        <div className={styles.zoomButtonTraceViewer}>
          <ZoomButton />
        </div>
      </div>
      {withPanel ? (
        <div
          className={clsx(
            styles.spanDetailPanelTraceViewer,
            !state.selected && styles.hidden,
            state.isMobile && styles.mobile
          )}
        >
          <SpanDetailPanel attached />
        </div>
      ) : null}
    </div>
  );
}

export function TraceViewerPanel({
  className = '',
  children = null,
}: {
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const { state } = useTraceViewer();

  if (!state.selected) {
    return children;
  }

  return (
    <div
      className={clsx(styles.spanDetailPanelTraceViewer, className)}
      style={
        {
          position: 'relative',
          '--search-height': '0',
          '--search-gap': '0',
          '--map-height': '0',
          '--panel-width': `100%`,
          '--panel-height': `100%`,
          '--height': `100%`,
          '--scrollbar-width': `${state.scrollbarWidth}px`,
        } as CSSProperties
      }
    >
      <SpanDetailPanel />
    </div>
  );
}

export function TraceViewer(props: TraceViewerProps): ReactNode {
  return (
    <TraceViewerContextProvider getQuickLinks={props.getQuickLinks} withPanel>
      <TraceViewerTimeline withPanel {...props} />
    </TraceViewerContextProvider>
  );
}
