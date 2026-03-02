import type { SpanNode, SpanNodeEvent } from '../types';
import type { ResourceType } from './span-strategies';

// ──────────────────────────────────────────────────────────────────────────
// Segment types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Visual status of a segment within a span bar.
 *
 * - queued:     Waiting to start (hatched pattern)
 * - running:    Actively executing (solid blue)
 * - failed:     Attempt that ended in failure (soft red)
 * - retrying:   Waiting between retry attempts (hatched pattern)
 * - succeeded:  Final successful attempt (soft green)
 * - waiting:    Passive waiting, e.g. hook waiting for payload (hatched pattern)
 * - sleeping:   Sleep in progress (soft amber)
 * - received:   Hook received a payload (soft blue)
 */
export type SegmentStatus =
  | 'queued'
  | 'running'
  | 'failed'
  | 'retrying'
  | 'succeeded'
  | 'waiting'
  | 'sleeping'
  | 'received';

export interface Segment {
  /** Fraction of span width where this segment starts (0–1) */
  startFraction: number;
  /** Fraction of span width where this segment ends (0–1) */
  endFraction: number;
  /** Visual status controlling color/pattern */
  status: SegmentStatus;
}

/**
 * A boundary between two segments, representing an event that caused
 * a transition. Rendered as a hoverable divider with a tooltip.
 */
export interface SegmentBoundary {
  /** Fractional position along the span (0–1) */
  fraction: number;
  /** Display label for the tooltip (e.g. "step_started") */
  label: string;
  /** Formatted timestamp relative to span start */
  offsetMs: number;
}

// ──────────────────────────────────────────────────────────────────────────
// CSS class mapping (segment status → module CSS class name)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Maps a SegmentStatus to the CSS module class name to use.
 * These class names must exist in trace-viewer.module.css.
 */
export const SEGMENT_CLASS_MAP: Record<SegmentStatus, string> = {
  queued: 'segQueued',
  running: 'segRunning',
  failed: 'segFailed',
  retrying: 'segRetrying',
  succeeded: 'segSucceeded',
  waiting: 'segWaiting',
  sleeping: 'segSleeping',
  received: 'segReceived',
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function timeToFraction(
  time: number,
  spanStart: number,
  spanDuration: number
): number {
  if (spanDuration <= 0) return 0;
  return clampFraction((time - spanStart) / spanDuration);
}

/**
 * Sort events by timestamp ascending.
 */
function sortedEvents(events: SpanNodeEvent[]): SpanNodeEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

// ──────────────────────────────────────────────────────────────────────────
// Step segments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute segments for a step span.
 *
 * Timeline: [queued] → [attempt₁ (fail)] → [retry wait] → [attempt₂ (fail)] → ... → [attemptₙ (success)]
 *
 * Events used: step_started, step_retrying, step_failed, step_completed
 * The final segment is 'succeeded' if no trailing step_retrying/step_failed.
 */
function computeStepSegments(node: SpanNode): Segment[] {
  const events = node.events ? sortedEvents(node.events) : [];
  const { startTime, duration } = node;
  const segments: Segment[] = [];

  if (duration <= 0) return segments;

  // Build a timeline of event boundaries
  interface EventMark {
    time: number;
    type: string;
  }
  const marks: EventMark[] = events
    .filter((e) =>
      [
        'step_started',
        'step_retrying',
        'step_failed',
        'step_completed',
      ].includes(e.event.name)
    )
    .map((e) => ({ time: e.timestamp, type: e.event.name }));

  if (marks.length === 0) {
    // No events — show entire span as running
    segments.push({ startFraction: 0, endFraction: 1, status: 'running' });
    return segments;
  }

  // Queued period: from span start to first event
  const firstMark = marks[0];
  const firstFraction = timeToFraction(firstMark.time, startTime, duration);
  if (firstFraction > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: firstFraction,
      status: 'queued',
    });
  }

  // Walk through events to build attempt/retry segments
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const markFraction = timeToFraction(mark.time, startTime, duration);
    const nextMark = marks[i + 1];
    const nextFraction = nextMark
      ? timeToFraction(nextMark.time, startTime, duration)
      : 1;

    if (mark.type === 'step_started') {
      // This is the start of an execution attempt.
      // It runs until the next event (step_retrying or step_failed) or end of span.
      const isLastMark = i === marks.length - 1;
      if (isLastMark) {
        // Last event is step_started — this attempt is either still running or succeeded
        segments.push({
          startFraction: markFraction,
          endFraction: 1,
          status: 'succeeded',
        });
      } else {
        // Attempt runs until the next event
        const nextType = nextMark.type;
        const attemptStatus: SegmentStatus =
          nextType === 'step_retrying' || nextType === 'step_failed'
            ? 'failed'
            : nextType === 'step_completed'
              ? 'succeeded'
              : 'running';
        segments.push({
          startFraction: markFraction,
          endFraction: nextFraction,
          status: attemptStatus,
        });
      }
    } else if (mark.type === 'step_retrying') {
      // Retry wait: from this event to the next step_started (or end)
      segments.push({
        startFraction: markFraction,
        endFraction: nextFraction,
        status: 'retrying',
      });
    } else if (mark.type === 'step_failed') {
      // Terminal failure: from this event to the end
      if (markFraction < 0.999) {
        segments.push({
          startFraction: markFraction,
          endFraction: 1,
          status: 'failed',
        });
      }
    } else if (mark.type === 'step_completed') {
      // Terminal success: do nothing here since the preceding step_started
      // segment already terminates at this marker.
    }
  }

  return segments;
}

// ──────────────────────────────────────────────────────────────────────────
// Hook segments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute segments for a hook span.
 *
 * Timeline: [waiting] → [received] → [disposed]
 */
function computeHookSegments(node: SpanNode): Segment[] {
  const events = node.events ? sortedEvents(node.events) : [];
  const { startTime, duration } = node;
  const segments: Segment[] = [];

  if (duration <= 0) return segments;

  const receivedEvent = events.find((e) => e.event.name === 'hook_received');
  const disposedEvent = events.find((e) => e.event.name === 'hook_disposed');

  if (!receivedEvent && !disposedEvent) {
    // Still waiting
    segments.push({ startFraction: 0, endFraction: 1, status: 'waiting' });
    return segments;
  }

  const receivedFraction = receivedEvent
    ? timeToFraction(receivedEvent.timestamp, startTime, duration)
    : null;
  const disposedFraction = disposedEvent
    ? timeToFraction(disposedEvent.timestamp, startTime, duration)
    : null;

  // Waiting period (before received)
  if (receivedFraction !== null && receivedFraction > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: receivedFraction,
      status: 'waiting',
    });
  } else if (receivedFraction === null && disposedFraction !== null) {
    // Disposed without receiving — waiting the whole time
    segments.push({
      startFraction: 0,
      endFraction: disposedFraction,
      status: 'waiting',
    });
  }

  // Received period
  if (receivedFraction !== null) {
    const end = disposedFraction ?? 1;
    segments.push({
      startFraction: receivedFraction,
      endFraction: end,
      status: 'received',
    });
  }

  // Post-disposed (if there's remaining span after disposal)
  if (disposedFraction !== null && disposedFraction < 0.999) {
    segments.push({
      startFraction: disposedFraction,
      endFraction: 1,
      status: 'succeeded',
    });
  }

  return segments;
}

// ──────────────────────────────────────────────────────────────────────────
// Sleep segments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute segments for a sleep span.
 *
 * Timeline: [sleeping] → [completed]
 */
function computeSleepSegments(node: SpanNode): Segment[] {
  const events = node.events ? sortedEvents(node.events) : [];
  const { startTime, duration } = node;
  const segments: Segment[] = [];

  if (duration <= 0) return segments;

  const completedEvent = events.find((e) => e.event.name === 'wait_completed');

  if (!completedEvent) {
    // Still sleeping
    segments.push({ startFraction: 0, endFraction: 1, status: 'sleeping' });
    return segments;
  }

  const completedFraction = timeToFraction(
    completedEvent.timestamp,
    startTime,
    duration
  );

  if (completedFraction > 0.001) {
    segments.push({
      startFraction: 0,
      endFraction: completedFraction,
      status: 'sleeping',
    });
  }

  segments.push({
    startFraction: completedFraction,
    endFraction: 1,
    status: 'succeeded',
  });

  return segments;
}

// ──────────────────────────────────────────────────────────────────────────
// Run segments
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute segments for a run span.
 *
 * Timeline: [queued] → [running] → [completed/failed]
 *
 * The queued period is derived from activeStartTime (run.startedAt).
 * A synthetic run_started event is injected at that timestamp so
 * the boundary is hoverable in the trace viewer.
 */
function computeRunSegments(node: SpanNode): Segment[] {
  const events = node.events ? sortedEvents(node.events) : [];
  const { startTime, duration, activeStartTime } = node;
  const segments: Segment[] = [];

  if (duration <= 0) return segments;

  const failedEvent = events.find((e) => e.event.name === 'run_failed');
  const completedEvent = events.find((e) => e.event.name === 'run_completed');

  // Queued period (from span start to activeStartTime)
  let cursor = 0;
  if (activeStartTime && activeStartTime > startTime) {
    const queuedFraction = timeToFraction(activeStartTime, startTime, duration);
    if (queuedFraction > 0.001) {
      segments.push({
        startFraction: 0,
        endFraction: queuedFraction,
        status: 'queued',
      });
      cursor = queuedFraction;
    }
  }

  if (failedEvent) {
    const failedFraction = timeToFraction(
      failedEvent.timestamp,
      startTime,
      duration
    );
    // Running until failure
    if (failedFraction > cursor + 0.001) {
      segments.push({
        startFraction: cursor,
        endFraction: failedFraction,
        status: 'running',
      });
    }
    segments.push({
      startFraction: failedFraction,
      endFraction: 1,
      status: 'failed',
    });
  } else if (completedEvent) {
    const completedFraction = timeToFraction(
      completedEvent.timestamp,
      startTime,
      duration
    );
    if (completedFraction > cursor + 0.001) {
      segments.push({
        startFraction: cursor,
        endFraction: completedFraction,
        status: 'running',
      });
    }
    segments.push({
      startFraction: completedFraction,
      endFraction: 1,
      status: 'succeeded',
    });
  } else {
    // Running to completion
    segments.push({
      startFraction: cursor,
      endFraction: 1,
      status: 'running',
    });
  }

  return segments;
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

export interface SegmentResult {
  segments: Segment[];
  boundaries: SegmentBoundary[];
}

// ──────────────────────────────────────────────────────────────────────────
// Boundary computation
// ──────────────────────────────────────────────────────────────────────────

/** Event names to human-readable labels */
const EVENT_LABELS: Record<string, string> = {
  step_started: 'Started',
  step_retrying: 'Retrying',
  step_failed: 'Failed',
  hook_created: 'Created',
  hook_received: 'Received',
  hook_disposed: 'Resolved',
  wait_created: 'Sleep started',
  wait_completed: 'Sleep completed',
  run_completed: 'Completed',
  run_failed: 'Run failed',
  step_completed: 'Completed',
};

/**
 * Extract boundaries from a span's events. Each boundary sits at the
 * fractional position of a relevant event within the span duration.
 * Only includes events that are used as segment boundaries (not at the
 * very start or very end of the span, to avoid edge clutter).
 */
function computeBoundaries(
  node: SpanNode,
  relevantEventNames: string[]
): SegmentBoundary[] {
  const events = node.events ? sortedEvents(node.events) : [];
  const { startTime, duration } = node;

  if (duration <= 0) return [];

  const boundaries: SegmentBoundary[] = [];
  for (const e of events) {
    if (!relevantEventNames.includes(e.event.name)) continue;

    const fraction = timeToFraction(e.timestamp, startTime, duration);
    // Skip boundaries at the very edges (< 1% or > 99%) to avoid clutter
    if (fraction < 0.01 || fraction > 0.99) continue;

    boundaries.push({
      fraction,
      label: EVENT_LABELS[e.event.name] ?? e.event.name,
      offsetMs: e.timestamp - startTime,
    });
  }

  return boundaries;
}

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute the event-based segments and boundaries for a span based on its resource type.
 * Returns empty arrays for 'default' (generic OTEL) spans.
 */
export function computeSegments(
  resourceType: ResourceType,
  node: SpanNode
): SegmentResult {
  switch (resourceType) {
    case 'step':
      return {
        segments: computeStepSegments(node),
        boundaries: computeBoundaries(node, [
          'step_started',
          'step_retrying',
          'step_failed',
          'step_completed',
        ]),
      };
    case 'hook':
      return {
        segments: computeHookSegments(node),
        boundaries: computeBoundaries(node, [
          'hook_created',
          'hook_received',
          'hook_disposed',
        ]),
      };
    case 'sleep':
      return {
        segments: computeSleepSegments(node),
        boundaries: computeBoundaries(node, ['wait_created', 'wait_completed']),
      };
    case 'run':
      return {
        segments: computeRunSegments(node),
        boundaries: computeBoundaries(node, ['run_completed', 'run_failed']),
      };
    default:
      return { segments: [], boundaries: [] };
  }
}
