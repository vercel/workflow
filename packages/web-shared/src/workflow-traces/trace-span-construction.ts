/**
 * Functions for constructing OpenTelemetry spans from workflow entities
 */

import { parseStepName, parseWorkflowName } from '@workflow/core/parse-name';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
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

/**
 * Converts a workflow Wait to an OpenTelemetry Span
 */
export function waitToSpan(
  correlationId: string,
  events: Event[],
  nowTime?: Date
): Span {
  const startEvent = events.find((event) => event.eventType === 'wait_created');
  const endEvent = events.find((event) => event.eventType === 'wait_completed');
  const startTime = startEvent?.createdAt ?? nowTime;
  const endTime = endEvent?.createdAt ?? nowTime;
  const start = dateToOtelTime(startTime);
  const end = dateToOtelTime(endTime);
  const duration = calculateDuration(startTime, endTime);
  const spanEvents = convertEventsToSpanEvents(events);
  return {
    spanId: correlationId,
    name: 'sleep',
    kind: 1, // INTERNAL span kind
    resource: 'sleep',
    library: WORKFLOW_LIBRARY,
    status: { code: 0 },
    traceFlags: 1,
    attributes: {
      resource: 'sleep' as const,
      data: {
        correlationId,
      },
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
  const endTime = step.completedAt ?? now;

  // Convert step-related events to span events (for markers like hook_created, step_retrying, etc.)
  // This determines which events are displayed as markers. In the detail view,
  // we'll show all events that correlate with the selected resource.
  const events = convertEventsToSpanEvents(stepEvents);

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
    startTime: dateToOtelTime(step.startedAt),
    endTime: dateToOtelTime(endTime),
    duration: calculateDuration(step.startedAt, endTime),
  };
}

/**
 * Converts a workflow Hook to an OpenTelemetry Span
 */
export function hookToSpan(hook: Hook, hookEvents: Event[]): Span {
  // Simplified attributes: only store resource type and full data
  const attributes = {
    resource: 'hook' as const,
    data: hook,
  };

  // TODO: Determine proper end time for hooks
  // If there are hook_received events, use the createdAt of the last hook_received event.
  // Otherwise, set the end time to 1 second after the hook was created.
  const lastHookReceivedEvent = hookEvents.find(
    (event) => event.eventType === 'hook_received'
  );

  const endTime = lastHookReceivedEvent
    ? dateToOtelTime(lastHookReceivedEvent.createdAt)
    : dateToOtelTime(
        new Date(Math.max(hook.createdAt.getTime() + 10_000, Date.now()))
      );

  // Convert hook-related events to span events
  const events = convertEventsToSpanEvents(hookEvents);

  return {
    spanId: String(hook.hookId),
    name: String(hook.hookId),
    kind: 1, // INTERNAL span kind
    resource: 'hook',
    library: WORKFLOW_LIBRARY,
    status: { code: 1 },
    traceFlags: 1,
    attributes,
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

  const startDate = run.startedAt ?? run.createdAt;
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
    startTime: dateToOtelTime(startDate),
    endTime: dateToOtelTime(endTime),
    duration: calculateDuration(startDate, endTime),
  };
}
