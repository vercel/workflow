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
export function waitToSpan(correlationId: string, events: Event[]): Span {
  const startEvent = events.find((event) => event.eventType === 'wait_created');
  const endEvent = events.find((event) => event.eventType === 'wait_completed');
  const startTime = startEvent?.createdAt;
  const start = dateToOtelTime(startTime);

  // If wait is not completed, use "now" for dynamic animation
  const end = endEvent ? dateToOtelTime(endEvent.createdAt) : 'now';
  const duration = endEvent
    ? calculateDuration(startTime, endEvent.createdAt)
    : 'now';

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
export function stepToSpan(step: Step, stepEvents: Event[]): Span {
  const parsedName = parseStepName(String(step.stepName));

  // Simplified attributes: only store resource type and full data
  const attributes = {
    resource: 'step' as const,
    data: step,
  };

  const resource = 'step';

  // If step is not completed, use "now" for dynamic animation
  const endTime = step.completedAt ? dateToOtelTime(step.completedAt) : 'now';
  const duration = step.completedAt
    ? calculateDuration(step.startedAt, step.completedAt)
    : 'now';

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
    endTime,
    duration,
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

  const lastHookReceivedEvent = hookEvents
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .find((event) => event.eventType === 'hook_received');

  // If hook has not been received yet, use "now" for dynamic animation
  const endTime = lastHookReceivedEvent
    ? dateToOtelTime(lastHookReceivedEvent.createdAt)
    : 'now';
  const duration = lastHookReceivedEvent
    ? calculateDuration(hook.createdAt, lastHookReceivedEvent.createdAt)
    : 'now';

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
    endTime,
    duration,
  };
}

/**
 * Creates a root span for the workflow run
 */
export function runToSpan(run: WorkflowRun, runEvents: Event[]): Span {
  // Simplified attributes: only store resource type and full data
  const attributes = {
    resource: 'run' as const,
    data: run,
  };

  const startDate = run.startedAt ?? run.createdAt;

  // If run is not completed, use "now" for dynamic animation
  const endTime = run.completedAt ? dateToOtelTime(run.completedAt) : 'now';
  const duration = run.completedAt
    ? calculateDuration(startDate, run.completedAt)
    : 'now';

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
    endTime,
    duration,
  };
}
