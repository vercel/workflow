import type { Span } from '../components/trace-viewer/types';
import type { TraceWithMeta } from './trace-builder';

export const WORKFLOW_SPAN_TIMING_ATTRIBUTE = 'workflowTiming';

export type WorkflowTimingTimeValue = Date | number | string;

export interface WorkflowQueuedTiming {
  /** Whether timing data is currently being fetched for this span. */
  isLoading?: boolean;
  /** Vercel request id for the function invocation that produced this timing. */
  requestId?: string;
  /** Timestamp for the start of the function invocation. */
  invocationStartedAt?: WorkflowTimingTimeValue;
  /** Timestamp for the first Workflow API request made by this invocation. */
  firstWorkflowRequestStartedAt?: WorkflowTimingTimeValue;
  /** Milliseconds from invocation start to the first Workflow API request. */
  firstWorkflowRequestStartOffsetMs?: number;
  /** Fluid VM cold-start duration, when the invocation was cold. */
  coldStartDurationMs?: number;
  /** Function start type reported by Fluid, e.g. "cold". */
  functionStartType?: string;
  /**
   * Time spent before the first Workflow API request that is not accounted for
   * by VM cold start, usually module imports and user initialization.
   */
  moduleInitDurationMs?: number;
  /** Duration of the first Workflow API request. */
  workflowOverheadDurationMs?: number;
  /** Alias for workflowOverheadDurationMs used by logs request metrics. */
  firstWorkflowRequestDurationMs?: number;
  /** Total queued/pre-execution duration, when known directly. */
  queuedDurationMs?: number;
}

export interface WorkflowSpanTimingAttempt extends WorkflowQueuedTiming {
  attempt?: number;
  label?: string;
}

export interface WorkflowSpanTiming extends WorkflowQueuedTiming {
  attempts?: WorkflowSpanTimingAttempt[];
}

export type WorkflowSpanTimingMap = Record<
  string,
  WorkflowSpanTiming | undefined
>;

export interface DerivedWorkflowTimingBreakdown {
  requestId?: string;
  label?: string;
  attempt?: number;
  functionStartType?: string;
  coldStartDurationMs?: number;
  moduleInitDurationMs?: number;
  workflowOverheadDurationMs?: number;
  firstWorkflowRequestStartOffsetMs?: number;
  queuedDurationMs?: number;
}

function finiteDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function timeValueToMs(value: WorkflowTimingTimeValue | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function durationBetween(
  start: WorkflowTimingTimeValue | undefined,
  end: WorkflowTimingTimeValue | undefined
) {
  const startMs = timeValueToMs(start);
  const endMs = timeValueToMs(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) {
    return undefined;
  }
  return endMs - startMs;
}

function isColdStart(
  functionStartType: string | undefined,
  coldStartDurationMs: number | undefined
) {
  return (
    coldStartDurationMs !== undefined &&
    (coldStartDurationMs > 0 || functionStartType?.toLowerCase() === 'cold')
  );
}

export function deriveWorkflowTimingBreakdown(
  timing: WorkflowQueuedTiming | undefined
): DerivedWorkflowTimingBreakdown | null {
  if (!timing) {
    return null;
  }

  const workflowOverheadDurationMs =
    finiteDuration(timing.workflowOverheadDurationMs) ??
    finiteDuration(timing.firstWorkflowRequestDurationMs);
  const queuedDurationMs = finiteDuration(timing.queuedDurationMs);
  const firstWorkflowRequestStartOffsetMs =
    finiteDuration(timing.firstWorkflowRequestStartOffsetMs) ??
    durationBetween(
      timing.invocationStartedAt,
      timing.firstWorkflowRequestStartedAt
    ) ??
    (queuedDurationMs !== undefined && workflowOverheadDurationMs !== undefined
      ? Math.max(0, queuedDurationMs - workflowOverheadDurationMs)
      : undefined);

  const coldStartDurationCandidate = finiteDuration(timing.coldStartDurationMs);
  const coldStartDurationMs = isColdStart(
    timing.functionStartType,
    coldStartDurationCandidate
  )
    ? coldStartDurationCandidate
    : undefined;

  const moduleInitDurationMs =
    finiteDuration(timing.moduleInitDurationMs) ??
    (firstWorkflowRequestStartOffsetMs !== undefined
      ? Math.max(
          0,
          firstWorkflowRequestStartOffsetMs - (coldStartDurationMs ?? 0)
        )
      : undefined);

  const derivedQueuedDurationMs =
    queuedDurationMs ??
    (firstWorkflowRequestStartOffsetMs !== undefined &&
    workflowOverheadDurationMs !== undefined
      ? firstWorkflowRequestStartOffsetMs + workflowOverheadDurationMs
      : firstWorkflowRequestStartOffsetMs);

  const hasAnyTiming =
    coldStartDurationMs !== undefined ||
    moduleInitDurationMs !== undefined ||
    workflowOverheadDurationMs !== undefined ||
    firstWorkflowRequestStartOffsetMs !== undefined ||
    derivedQueuedDurationMs !== undefined;

  if (!hasAnyTiming) {
    return null;
  }

  return {
    requestId: timing.requestId,
    functionStartType: timing.functionStartType,
    coldStartDurationMs,
    moduleInitDurationMs,
    workflowOverheadDurationMs,
    firstWorkflowRequestStartOffsetMs,
    queuedDurationMs: derivedQueuedDurationMs,
  };
}

export function getWorkflowSpanTiming(
  attributes: Record<string, unknown> | undefined
): WorkflowSpanTiming | undefined {
  const value = attributes?.[WORKFLOW_SPAN_TIMING_ATTRIBUTE];
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as WorkflowSpanTiming;
}

export function withWorkflowSpanTimings(
  trace: TraceWithMeta,
  spanTimings: WorkflowSpanTimingMap | undefined
): TraceWithMeta {
  if (!spanTimings) {
    return trace;
  }

  let changed = false;
  const spans: Span[] = trace.spans.map((span) => {
    const timing = spanTimings[span.spanId];
    if (!timing) {
      return span;
    }

    changed = true;
    return {
      ...span,
      attributes: {
        ...span.attributes,
        [WORKFLOW_SPAN_TIMING_ATTRIBUTE]: timing,
      },
    };
  });

  return changed ? { ...trace, spans } : trace;
}
