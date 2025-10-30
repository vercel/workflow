import type { Dispatch, MutableRefObject, ReactNode, Reducer } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type {
  GetQuickLinks,
  MemoCache,
  MemoCacheKey,
  QuickLink,
  Resource,
  RootNode,
  ScrollSnapshot,
  SpanNode,
  VisibleSpanEvent,
} from './types';
import {
  MAP_HEIGHT,
  MARKER_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING,
  SEARCH_GAP,
  SEARCH_HEIGHT,
  TIMELINE_PADDING,
} from './util/constants';
import { detectScrollbarWidth } from './util/scrollbar-width';

export interface TraceViewerState {
  /**
   * The root node for the tree
   */
  root: RootNode;
  /**
   * A map of spanId to span nodes
   */
  spanMap: Record<string, SpanNode>;
  /**
   * A map of resource name to resource
   */
  resourceMap: Record<string, Resource['attributes']>;
  /**
   * The current (debounced) search input value
   */
  filter: string;
  /**
   * The span that is currently focused and visible in the panel
   */
  selected: SpanNode | null;
  /**
   * The initial scale of the trace. At this scale the entire trace is visible
   */
  baseScale: number;
  /**
   * The multiplier of the base scale to get the current scale
   */
  scaleRatio: number;
  /**
   * The scale of 1ms in pixels
   */
  scale: number;
  /**
   * The width of the entire trace viewer in pixels
   */
  width: number;
  /**
   * The height of the entire trace viewer in pixels
   */
  height: number;
  /**
   * The width of the timeline view in pixels
   */
  timelineWidth: number;
  /**
   * The height of the timeline view in pixels
   */
  timelineHeight: number;
  /**
   * The width of the side panel in pixels
   */
  panelWidth: number;
  /**
   * The height of the side panel in pixels
   */
  panelHeight: number;
  /**
   * The width of scrollbars on this device
   */
  scrollbarWidth: number;
  /**
   * A ref for the timeline element
   */
  timelineRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * A ref for updating timeline scroll position immediately after a scale operation
   */
  scrollSnapshotRef: MutableRefObject<ScrollSnapshot | undefined>;
  /**
   * A reference for the last time each node was mutated. Used for more efficent control
   * of what React re-renders and when.
   */
  memoCacheRef: MutableRefObject<MemoCache>;
  /**
   * A constant, wrapped version of the getQuickLinks property with caching
   */
  getQuickLinks: GetQuickLinks;
  /**
   * Whether the panel is being rendered attached to the timeline
   */
  withPanel: boolean;
  /**
   * Whether the trace viewer is small enough that it should be in mobile mode
   */
  isMobile: boolean;
  /**
   * Panel to render instead of the default span detail panel. The panel
   * should use the context to get the selected span and other state.
   */
  customPanelComponent: ReactNode | null;
  /**
   * A function to provide custom class names for spans.
   */
  customSpanClassNameFunc?: (span: SpanNode) => string;
  /**
   * A function to provide custom class names for span events.
   */
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
}

export type TraceViewerAction =
  | {
      type: 'setRoot';
      root: RootNode;
      spanMap: Record<string, SpanNode>;
      resources: Resource[];
    }
  | {
      type: 'setSize';
      width: number;
      height: number;
    }
  | {
      type: 'setPanelWidth';
      width: number;
    }
  | {
      type: 'setFilter';
      filter: string;
    }
  | {
      type: 'deselect';
    }
  | {
      type: 'select';
      id: string;
    }
  | {
      type: 'escape';
    }
  | {
      type: 'toggleSelection';
      id: string;
    }
  | {
      type: 'detectBaseScale';
    }
  | {
      type: 'setScale';
      scale: number;
    }
  | {
      type: 'resetScale';
    }
  | {
      type: 'scaleToNode';
      id: string;
    }
  | {
      type: 'scaleToRange';
      t1: number;
      t2: number;
    }
  | {
      type: 'adjustScaleRatio';
      direction: -1 | 0 | 1;
    }
  | {
      type: 'trackpadScale';
      delta: number;
      anchorT: number;
      anchorX: number;
    }
  | {
      type: 'minScale';
    }
  | {
      type: 'setScrollSnapshot';
      /**
       * The time that will remain the same location after scaling
       */
      anchorT: number;
      /**
       * The anchor point relative to the timeline's left position
       */
      anchorX: number;
    }
  | {
      type: 'setWithPanel';
      withPanel: boolean;
    }
  | {
      type: 'forceRender';
    };

export interface TraceViewerContextProps {
  state: TraceViewerState;
  dispatch: Dispatch<TraceViewerAction>;
}

export const initialState: TraceViewerState = {
  root: {
    startTime: 0,
    endTime: 1,
    duration: 1,
    depth: 0,
    children: [],
  },
  spanMap: {},
  resourceMap: {},
  filter: '',
  selected: null,
  baseScale: 1,
  scaleRatio: 1,
  scale: 1,
  width: 640,
  height: 480,
  timelineWidth: 640,
  timelineHeight: 480,
  panelWidth: 380,
  panelHeight: 480,
  scrollbarWidth: 0,
  timelineRef: { current: null },
  scrollSnapshotRef: { current: undefined },
  memoCacheRef: { current: new Map() },
  getQuickLinks: () => [],
  withPanel: false,
  isMobile: false,
  customPanelComponent: null,
};

const getMinScale = (state: TraceViewerState): number => {
  return (
    (state.width -
      state.scrollbarWidth -
      Number(Boolean(state.selected && state.withPanel)) * state.panelWidth) /
    state.root.duration
  );
};

export const TraceViewerContext = createContext<TraceViewerContextProps>({
  state: initialState,
  dispatch: () => {
    // noop
  },
});
TraceViewerContext.displayName = 'TraceViewerContext';

const reducer: Reducer<TraceViewerState, TraceViewerAction> = (
  state,
  action
) => {
  switch (action.type) {
    case 'setRoot':
      state.scrollSnapshotRef.current = undefined;
      state.memoCacheRef.current.clear();
      return reducer(
        {
          ...state,
          root: action.root,
          spanMap: action.spanMap,
          resourceMap: Object.fromEntries(
            action.resources.map(({ name, attributes }) => [name, attributes])
          ),
        },
        {
          type: 'detectBaseScale',
        }
      );
    case 'setSize': {
      const lowerHeight =
        action.height - MAP_HEIGHT - SEARCH_HEIGHT - 3 * SEARCH_GAP;

      const isMobile = state.withPanel && action.width <= 768;

      let newState = {
        ...state,
        width: action.width,
        height: action.height,
        timelineWidth:
          action.width -
          Number(Boolean(state.selected && state.withPanel && !isMobile)) *
            state.panelWidth,
        timelineHeight: lowerHeight,
        panelHeight: lowerHeight,
        isMobile,
      };

      if (newState.width !== state.width) {
        newState = reducer(newState, {
          type: 'detectBaseScale',
        });
      }

      return newState;
    }
    case 'setPanelWidth': {
      const panelWidth = Math.max(
        240,
        Math.min(action.width, state.width - 240)
      );
      return {
        ...state,
        timelineWidth: state.width - panelWidth,
        panelWidth,
      };
    }
    case 'setFilter':
      return {
        ...state,
        filter: action.filter,
      };
    case 'deselect':
      return reducer(
        {
          ...state,
          selected: null,
          timelineWidth: state.width,
        },
        {
          type: 'minScale',
        }
      );
    case 'select': {
      const node = state.spanMap[action.id];
      if (!node) {
        return state;
      }

      return {
        ...state,
        selected: node,
        timelineWidth:
          state.width -
          (state.withPanel && !state.isMobile ? state.panelWidth : 0),
      };
    }
    case 'escape': {
      if (state.selected) {
        return reducer(state, {
          type: 'deselect',
        });
      }
      return reducer(state, {
        type: 'resetScale',
      });
    }
    case 'toggleSelection': {
      let newState = state;
      if (state.selected) {
        newState = reducer(newState, {
          type: 'deselect',
        });
      }
      if (state.selected?.span.spanId === action.id) {
        return newState;
      }
      return reducer(newState, {
        type: 'select',
        id: action.id,
      });
    }
    case 'detectBaseScale': {
      const baseScale =
        (state.width - state.scrollbarWidth) / state.root.duration;

      return {
        ...state,
        baseScale,
        scale: baseScale * state.scaleRatio,
      };
    }
    case 'setScale':
      return {
        ...state,
        scaleRatio: action.scale,
        scale: state.baseScale * action.scale,
      };
    case 'resetScale':
      return reducer(state, {
        type: 'scaleToRange',
        t1: state.root.startTime,
        t2: state.root.endTime,
      });
    case 'scaleToNode': {
      const node = state.spanMap[action.id];
      if (!node) {
        return state;
      }
      return reducer(
        reducer(state, {
          type: 'setScale',
          scale:
            (state.width -
              state.scrollbarWidth -
              (state.withPanel && !state.isMobile ? state.panelWidth : 0)) /
            node.duration /
            state.baseScale,
        }),
        {
          type: 'setScrollSnapshot',
          anchorT: node.startTime - state.root.startTime,
          anchorX: 0,
        }
      );
    }
    case 'scaleToRange': {
      const duration = Math.abs(action.t1 - action.t2);

      return reducer(
        reducer(state, {
          type: 'setScale',
          scale:
            (state.width -
              state.scrollbarWidth -
              (state.selected && state.withPanel ? state.panelWidth : 0)) /
            duration /
            state.baseScale,
        }),
        {
          type: 'setScrollSnapshot',
          anchorT: Math.min(action.t1, action.t2) - state.root.startTime,
          anchorX: 0,
        }
      );
    }
    case 'adjustScaleRatio': {
      let { scaleRatio } = state;
      switch (action.direction) {
        case -1:
          scaleRatio *= 0.8;
          break;
        case 1:
          scaleRatio *= 1.25;
          break;
        default:
          scaleRatio = 1;
          break;
      }

      const $timeline = state.timelineRef.current;
      if (!$timeline) {
        console.warn('timelineRef is null');
        return state;
      }

      const { clientWidth, scrollLeft } = $timeline;

      return reducer(
        reducer(
          {
            ...state,
            scaleRatio,
            scale: state.baseScale * scaleRatio,
          },
          {
            type: 'minScale',
          }
        ),
        {
          type: 'setScrollSnapshot',
          anchorT: (scrollLeft + clientWidth * 0.5) / state.scale,
          anchorX: clientWidth * 0.5,
        }
      );
    }
    case 'trackpadScale': {
      const minScaleRatio = getMinScale(state) / state.baseScale;
      const scaleRatio = Math.max(
        minScaleRatio,
        state.scaleRatio *
          (1 +
            0.2 * Math.sign(action.delta) * Math.sqrt(Math.abs(action.delta)))
      );

      return reducer(
        {
          ...state,
          scaleRatio,
          scale: state.baseScale * scaleRatio,
        },
        {
          type: 'setScrollSnapshot',
          anchorT: action.anchorT,
          anchorX: action.anchorX,
        }
      );
    }
    case 'minScale': {
      const minScale = getMinScale(state);
      if (state.scale >= minScale) return state;
      return {
        ...state,
        scale: minScale,
        scaleRatio: minScale / state.baseScale,
      };
    }
    case 'setScrollSnapshot': {
      const $timeline = state.timelineRef.current;
      if (!$timeline) return state;

      const { anchorT, anchorX } = action;

      const scrollLeft = anchorT * state.scale - anchorX;
      const { scrollTop } = $timeline;
      const startRow =
        (scrollTop - MARKER_HEIGHT - TIMELINE_PADDING) /
        (ROW_HEIGHT + ROW_PADDING);
      const endRow =
        startRow + Math.ceil(state.timelineHeight / (ROW_HEIGHT + ROW_PADDING));

      state.scrollSnapshotRef.current = {
        anchorT,
        anchorX,
        scrollLeft,
        scrollTop,
        startTime: state.root.startTime + scrollLeft / state.scale,
        endTime:
          state.root.startTime +
          (scrollLeft + state.timelineWidth) / state.scale,
        startRow,
        endRow,
        scale: state.scale,
      };

      return state;
    }
    case 'setWithPanel': {
      if (state.withPanel === action.withPanel) return state;
      return {
        ...state,
        withPanel: action.withPanel,
      };
    }
    case 'forceRender':
      state.memoCacheRef.current.set('', {});
      return {
        ...state,
      };
  }
};

export function TraceViewerContextProvider({
  getQuickLinks,
  withPanel = false,
  children,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
  customPanelComponent = null,
}: {
  getQuickLinks?: GetQuickLinks;
  withPanel?: boolean;
  children: ReactNode;
  customSpanClassNameFunc?: (span: SpanNode) => string;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
  customPanelComponent?: ReactNode;
}): ReactNode {
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef<ScrollSnapshot>(undefined);
  const getQuickLinksRef = useRef(getQuickLinks);
  getQuickLinksRef.current = getQuickLinks;
  const memoCacheRef = useRef(new Map<string, MemoCacheKey>());
  const quickLinksCache = useRef(new Map<string, QuickLink[]>());
  const [state, dispatch] = useReducer(reducer, initialState, (initial) => {
    return {
      ...initial,
      scrollbarWidth: detectScrollbarWidth(),
      timelineRef,
      scrollSnapshotRef,
      customSpanClassNameFunc,
      customSpanEventClassNameFunc,
      customPanelComponent,
      memoCacheRef,
      withPanel,
      getQuickLinks: (span) => {
        const cacheKey = span.spanId;
        const existing = quickLinksCache.current.get(cacheKey);
        if (existing) return existing;

        const value = getQuickLinksRef.current?.(span) || [];
        quickLinksCache.current.set(cacheKey, value);
        return value;
      },
    };
  });

  useEffect(
    () =>
      dispatch({
        type: 'setWithPanel',
        withPanel,
      }),
    [withPanel]
  );

  const value: TraceViewerContextProps = useMemo(
    () => ({ state, dispatch }),
    [state, dispatch]
  );

  return (
    <TraceViewerContext.Provider value={value}>
      {children}
    </TraceViewerContext.Provider>
  );
}

export const useTraceViewer = (): TraceViewerContextProps =>
  useContext(TraceViewerContext);
