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
  /**
   * The time when the span became active/started executing (optional).
   * If provided and different from startTime, the portion between startTime
   * and activeStartTime will be rendered as a "queued" period with different styling.
   */
  activeStartTime?: [number, number];
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
