import type { MutableRefObject, ReactNode } from 'react';

export type MemoCacheKey = Record<string, never>;
export type MemoCache = Map<string, MemoCacheKey>;

export interface Span {
  name: string;
  kind: number;
  resource: string;
  library: {
    name: string;
    version?: string;
  };
  spanId: string;
  parentSpanId?: string;
  status: {
    code: number;
  };
  traceFlags: number;
  attributes: Record<string, unknown>;
  links: Record<string, unknown>[];
  events: SpanEvent[];
  startTime: [number, number];
  endTime: [number, number];
  duration: [number, number];
}

export interface SpanEvent {
  name: string;
  timestamp: [number, number];
  attributes: Record<string, unknown>;
  /**
   * Optional custom color for this event marker (workflow-specific feature).
   * If provided, this color will be used for the event marker line/diamond.
   */
  color?: string;
  /**
   * Whether to show a vertical line for this event in the timeline (workflow-specific feature).
   * If false, only the diamond marker on the span will be shown.
   * Defaults to true if not specified.
   */
  showVerticalLine?: boolean;
}

export interface Resource {
  name: string;
  attributes: Record<string, string>;
}

export interface Trace {
  traceId: string;
  resources?: Resource[];
  spans: Span[];
  rootSpanId?: string;
}

interface EveryNode {
  startTime: number;
  endTime: number;
  duration: number;
  /**
   * How deep is this node within the tree
   */
  depth: number;
  /**
   * All direct child nodes of this node
   */
  children: SpanNode[];
}

export interface RootNode extends EveryNode {
  /**
   * The depth is always 0 for the root node
   */
  depth: 0;
}

export interface SpanNode extends EveryNode {
  /**
   * This original Span that this node is based on
   */
  span: Span;
  /**
   * The immediate parent of this node
   */
  parent: RootNode | SpanNode;
  /**
   * A generated label to use (overrides the span.name) if present
   */
  label?: string;
  /**
   * OTEL events that are present on this span (e.g. TTFB)
   */
  events?: SpanNodeEvent[];
  /**
   * Whether this span originated in Vercel's infrastructure.
   */
  isVercel: boolean;
  /**
   * Whether this span matches the current search filter
   */
  isHighlighted?: boolean;
  /**
   * Whether this span is a placeholder to hint at where user spans
   * would appear if proper instrumentation were available
   */
  isInstrumentationHint?: boolean;
  /**
   * The index of the resource that this node belongs to (used for color)
   */
  resourceIndex: number;
}

export interface SpanNodeEvent {
  /** A unique key for this event to help with rendering in React */
  key: string;
  /** The timestamp of this event in milliseconds */
  timestamp: number;
  /** The original event model */
  event: SpanEvent;
}

export type TraceNode = RootNode | SpanNode;

export interface VisibleSpan extends SpanNode {
  /**
   * The ref for this span's element in the DOM
   */
  ref?: MutableRefObject<HTMLButtonElement | null>;
  /**
   * The y position of this span (in # of rows)
   */
  row: number;
  /**
   * Whether the CursorMarker is intersecting this span
   */
  isHovered: boolean;
  /**
   * Whether this is the selected span
   */
  isSelected: boolean;
  /**
   * Whether this node is visible (based on its size on screen)
   */
  isVisible: boolean;
  /**
   * Events also need to be able to hold a ref to their element in the DOM
   */
  events?: VisibleSpanEvent[];
}

export interface VisibleSpanEvent extends SpanNodeEvent {
  /**
   * The ref for this span's element in the DOM
   */
  ref?: MutableRefObject<HTMLDivElement | null>;
  /**
   * Whether the CursorMarker is intersecting this span
   */
  isHovered: boolean;
}

export interface ScrollSnapshot {
  anchorT: number;
  anchorX: number;
  scrollLeft: number;
  scrollTop: number;
  startTime: number;
  endTime: number;
  startRow: number;
  endRow: number;
  scale: number;
}

export type WorkerRequest = {
  requestId: number;
} & (
  | {
      type: 'calculateSpanPositions';
      root: RootNode;
    }
  | {
      type: 'filterSpans';
      root: RootNode;
      filter: string;
    }
);

export type WorkerResponse = {
  requestId: number;
} & (
  | {
      type: 'setRowsResult';
      rows: VisibleSpan[][];
      isEnd: boolean;
    }
  | {
      type: 'updateHighlight';
      matches: Set<string>;
    }
);

/**
 * Represents one link to a page related to the selected
 * span in the detail panel.
 */
export interface QuickLink {
  /** Used as a React key and the user-facing name for the link */
  key: string;
  /** Until this Promise is fulfilled, the row will render with a skeleton for the value. */
  value: Promise<QuickLinkValue>;
}

export interface QuickLinkValue {
  /** The visible components for the right side of this link */
  label: ReactNode;
  /** A special suffix to show for this link, defaults to the ExternalLink icon */
  icon?: ReactNode;
  /** The href that this link will open when clicked */
  href: string;
}

export type GetQuickLinks = (node: Span) => QuickLink[];
