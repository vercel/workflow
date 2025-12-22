/**
 * Functions for constructing OpenTelemetry spans from workflow entities
 */

import { parseStepName, parseWorkflowName } from '@workflow/core/parse-name';
import type { Event, Step, WorkflowRun } from '@workflow/world';
import type { Span, SpanEvent } from '../trace-viewer/types';
import { shouldShowVerticalLine } from './event-colors';
import { calculateDuration, dateToOtelTime } from './trace-time-utils';

export const WORKFLOW_LIBRARY = {
  name: 'workflow-development-kit',
  version: '4.0.0',
};

/**
 * Event types that should be displayed as visual markers in the trace viewer
 */
const MARKER_EVENT_TYPES: Set<Event['eventType']> = new Set([
  'hook_created',
  'hook_received',
  'hook_disposed',
  'step_started',
  'step_retrying',
  'step_failed',
  'workflow_failed',
  'wait_created',
  'wait_completed',
]);

/**
 * Convert workflow events to span events
 * Only includes events that should be displayed as markers
 */
export function convertEventsToSpanEvents(
  events: Event[],
  filterTypes = true
): SpanEvent[] {
  return events
    .filter((event) =>
      filterTypes ? MARKER_EVENT_TYPES.has(event.eventType) : true
    )
    .map((event) => ({
      name: event.eventType,
      timestamp: dateToOtelTime(event.createdAt),
      attributes: {
        eventId: event.eventId,
        correlationId: event.correlationId,
        eventData: 'eventData' in event ? event.eventData : undefined,
      },
      // Control whether to show vertical line in timeline
      showVerticalLine: shouldShowVerticalLine(event.eventType),
    }));
}

export const waitEventsToWaitEntity = (
  events: Event[]
): {
  waitId: string;
  runId: string;
  createdAt: Date;
  resumeAt: Date;
  completedAt?: Date;
} | null => {
  const startEvent = events.find((event) => event.eventType === 'wait_created');
  if (!startEvent) {
    return null;
  }
  const completedEvent = events.find(
    (event) => event.eventType === 'wait_completed'
  );
  return {
    waitId: startEvent.correlationId,
    runId: startEvent.runId,
    createdAt: startEvent.createdAt,
    resumeAt: startEvent.eventData?.resumeAt,
    completedAt: completedEvent?.createdAt,
  };
};

/**
 * Converts a workflow Wait to an OpenTelemetry Span
 */
export function waitToSpan(
  events: Event[],
  run: WorkflowRun,
  nowTime: Date
): Span | null {
  const wait = waitEventsToWaitEntity(events);
  if (!wait) {
    return null;
  }
  const viewerEndTime = new Date(run.completedAt || nowTime) ?? nowTime;
  const startTime = wait?.createdAt ?? nowTime;
  const endTime = wait?.completedAt ?? viewerEndTime;
  const start = dateToOtelTime(startTime);
  const end = dateToOtelTime(endTime);
  const duration = calculateDuration(startTime, endTime);
  const spanEvents = convertEventsToSpanEvents(events);
  return {
    spanId: wait.waitId,
    name: 'sleep',
    kind: 1, // INTERNAL span kind
    resource: 'sleep',
    library: WORKFLOW_LIBRARY,
    status: { code: 0 },
    traceFlags: 1,
    attributes: {
      resource: 'sleep' as const,
      data: wait,
    },
    links: [],
    events: spanEvents,
    duration,
    startTime: start,
    endTime: end,
  };
}

/**
 * Converts a workflow Step to an OpenTelemetry Span
 */
export function stepToSpan(
  step: Step,
  stepEvents: Event[],
  nowTime?: Date
): Span {
  const now = nowTime ?? new Date();
  const parsedName = parseStepName(String(step.stepName));

  // Simplified attributes: only store resource type and full data
  const attributes = {
    resource: 'step' as const,
    data: step,
  };

  const resource = 'step';
  const endTime = new Date(step.completedAt ?? now);

  // Convert step-related events to span events (for markers like hook_created, step_retrying, etc.)
  // This determines which events are displayed as markers. In the detail view,
  // we'll show all events that correlate with the selected resource.
  const events = convertEventsToSpanEvents(stepEvents);

  // Use createdAt as span start time, with activeStartTime for when execution began
  // This allows visualization of the "queued" period before execution
  const spanStartTime = new Date(step.createdAt);
  let activeStartTime = step.startedAt ? new Date(step.startedAt) : undefined;
  const firstStartEvent = stepEvents.find(
    (event) => event.eventType === 'step_started'
  );
  if (firstStartEvent) {
    // `step.startedAt` is the server-side creation timestamp, and `event.createdAt` is
    // the client-side creation timestamp. For now, to align the event marker with the
    // line we show for step.startedAt, we overwrite here to always use client-side time.
    activeStartTime = new Date(firstStartEvent.createdAt);
  }

  return {
    spanId: String(step.stepId),
    name: parsedName?.shortName ?? '',
    kind: 1, // INTERNAL span kind
    resource,
    library: WORKFLOW_LIBRARY,
    status: { code: 0 },
    traceFlags: 1,
    attributes,
    links: [],
    events,
    startTime: dateToOtelTime(spanStartTime),
    endTime: dateToOtelTime(endTime),
    duration: calculateDuration(spanStartTime, endTime),
    // Only set activeStartTime if it differs from startTime (i.e., there was a queued period)
    activeStartTime:
      activeStartTime && activeStartTime.getTime() > spanStartTime.getTime()
        ? dateToOtelTime(activeStartTime)
        : undefined,
  };
}

export const hookEventsToHookEntity = (
  events: Event[]
): {
  hookId: string;
  runId: string;
  createdAt: Date;
  receivedCount: number;
  lastReceivedAt?: Date;
  disposedAt?: Date;
} | null => {
  const createdEvent = events.find(
    (event) => event.eventType === 'hook_created'
  );
  if (!createdEvent) {
    return null;
  }
  const receivedEvents = events.filter(
    (event) => event.eventType === 'hook_received'
  );
  const disposedEvents = events.filter(
    (event) => event.eventType === 'hook_disposed'
  );
  const lastReceivedEvent = receivedEvents.at(-1);
  return {
    hookId: createdEvent.correlationId,
    runId: createdEvent.runId,
    createdAt: createdEvent.createdAt,
    receivedCount: receivedEvents.length,
    lastReceivedAt: lastReceivedEvent?.createdAt || undefined,
    disposedAt: disposedEvents.at(-1)?.createdAt || undefined,
  };
};

/**
 * Converts a workflow Hook to an OpenTelemetry Span
 */
export function hookToSpan(
  hookEvents: Event[],
  run: WorkflowRun,
  nowTime: Date
): Span | null {
  const hook = hookEventsToHookEntity(hookEvents);
  if (!hook) {
    return null;
  }

  // Convert hook-related events to span events
  const events = convertEventsToSpanEvents(hookEvents);

  // We display hooks as a minimum span size of 10 seconds, just to ensure
  // it's clickable even if there is no
  const viewerEndTime = new Date(run.completedAt || nowTime) ?? nowTime;
  const endTime = hook.disposedAt || viewerEndTime;

  return {
    spanId: String(hook.hookId),
    name: String(hook.hookId),
    kind: 1, // INTERNAL span kind
    resource: 'hook',
    library: WORKFLOW_LIBRARY,
    status: { code: 1 },
    traceFlags: 1,
    attributes: {
      resource: 'hook' as const,
      data: hook,
    },
    links: [],
    events,
    startTime: dateToOtelTime(hook.createdAt),
    endTime: dateToOtelTime(endTime),
    duration: calculateDuration(hook.createdAt, endTime),
  };
}

/**
 * Creates a root span for the workflow run
 */
export function runToSpan(
  run: WorkflowRun,
  runEvents: Event[],
  nowTime?: Date
): Span {
  const now = nowTime ?? new Date();

  // Simplified attributes: only store resource type and full data
  const attributes = {
    resource: 'run' as const,
    data: run,
  };

  // Use createdAt as span start time, with activeStartTime for when execution began
  const spanStartTime = new Date(run.createdAt);
  const activeStartTime = run.startedAt ? new Date(run.startedAt) : undefined;
  const endTime = run.completedAt ?? now;

  // Convert run-level events to span events
  const events = convertEventsToSpanEvents(runEvents);

  return {
    spanId: String(run.runId),
    name: String(parseWorkflowName(run.workflowName)?.shortName ?? '?'),
    kind: 1, // INTERNAL span kind
    resource: 'run',
    library: WORKFLOW_LIBRARY,
    status: { code: 0 },
    traceFlags: 1,
    attributes,
    links: [],
    events,
    startTime: dateToOtelTime(spanStartTime),
    endTime: dateToOtelTime(endTime),
    duration: calculateDuration(spanStartTime, endTime),
    // Only set activeStartTime if it differs from startTime (i.e., there was a queued period)
    activeStartTime:
      activeStartTime && activeStartTime.getTime() > spanStartTime.getTime()
        ? dateToOtelTime(activeStartTime)
        : undefined,
  };
}
