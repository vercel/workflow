/**
 * Functions for constructing OpenTelemetry spans from workflow entities
 */

import { parseStepName, parseWorkflowName } from '@workflow/utils/parse-name';
import type { Event, WorkflowRun } from '@workflow/world';
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
  'run_failed',
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
export function waitToSpan(events: Event[], maxEndTime: Date): Span | null {
  const wait = waitEventsToWaitEntity(events);
  if (!wait) {
    return null;
  }
  const startTime = wait.createdAt;
  const endTime = wait.completedAt ?? maxEndTime;
  const start = dateToOtelTime(startTime);
  const end = dateToOtelTime(endTime);
  const duration = calculateDuration(startTime, endTime);
  const spanEvents = convertEventsToSpanEvents(events, false);
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
      data: wait, // wait is a plain object built from events, no non-cloneable types
    },
    links: [],
    events: spanEvents,
    duration,
    startTime: start,
    endTime: end,
  };
}

export const stepEventsToStepEntity = (
  events: Event[]
): {
  stepId: string;
  runId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  specVersion?: number;
} | null => {
  const createdEvent = events.find(
    (event) => event.eventType === 'step_created'
  );

  // V1 runs don't emit step_created events. Fall back to the earliest event
  // in the group so we can still build a step span.
  const anchorEvent = createdEvent ?? events[0];
  if (!anchorEvent) {
    return null;
  }

  // Walk events in order to derive status, attempt count, and timestamps.
  // Handles both step_retrying and consecutive step_started as retry signals.
  let status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' =
    'pending';
  let attempt = 0;
  let startedAt: Date | undefined;
  let completedAt: Date | undefined;

  for (const e of events) {
    switch (e.eventType) {
      case 'step_started':
        status = 'running';
        attempt += 1;
        if (!startedAt) startedAt = e.createdAt;
        completedAt = undefined;
        break;
      case 'step_completed':
        status = 'completed';
        completedAt = e.createdAt;
        break;
      case 'step_failed':
        status = 'failed';
        completedAt = e.createdAt;
        break;
      case 'step_retrying':
        status = 'pending';
        completedAt = undefined;
        break;
    }
  }

  // Ensure at least attempt 1 if we never saw step_started
  if (attempt === 0) attempt = 1;

  const lastEvent = events[events.length - 1];
  return {
    stepId: anchorEvent.correlationId ?? '',
    runId: anchorEvent.runId,
    stepName: createdEvent?.eventData?.stepName ?? '',
    status,
    attempt,
    createdAt: anchorEvent.createdAt,
    updatedAt: lastEvent?.createdAt ?? anchorEvent.createdAt,
    startedAt,
    completedAt,
    specVersion: anchorEvent.specVersion,
  };
};

/**
 * Converts step events to an OpenTelemetry Span
 */
export function stepToSpan(stepEvents: Event[], maxEndTime: Date): Span | null {
  const step = stepEventsToStepEntity(stepEvents);
  if (!step) {
    return null;
  }
  const parsedName = parseStepName(String(step.stepName));

  const attributes = {
    resource: 'step' as const,
    data: step,
  };

  const resource = 'step';
  const endTime = new Date(step.completedAt ?? maxEndTime);

  // Include ALL correlated events on the span so the sidebar detail view
  // can display them. The timeline uses the `showVerticalLine` flag to
  // determine which events appear as markers.
  const events = convertEventsToSpanEvents(stepEvents, false);

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
  token?: string;
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
    token: createdEvent.eventData?.token,
    createdAt: createdEvent.createdAt,
    receivedCount: receivedEvents.length,
    lastReceivedAt: lastReceivedEvent?.createdAt || undefined,
    disposedAt: disposedEvents.at(-1)?.createdAt || undefined,
  };
};

/**
 * Converts a workflow Hook to an OpenTelemetry Span
 */
export function hookToSpan(hookEvents: Event[], maxEndTime: Date): Span | null {
  const hook = hookEventsToHookEntity(hookEvents);
  if (!hook) {
    return null;
  }

  // Convert hook-related events to span events
  const events = convertEventsToSpanEvents(hookEvents, false);

  const endTime = hook.disposedAt || maxEndTime;

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

  // Only embed identification fields — not the full object with
  // input/output/error which may contain non-cloneable types.
  const { input: _i, output: _o, error: _e, ...runIdentity } = run;
  const attributes = {
    resource: 'run' as const,
    data: runIdentity,
  };

  // Use createdAt as span start time, with activeStartTime for when execution began
  const spanStartTime = new Date(run.createdAt);
  const activeStartTime = run.startedAt ? new Date(run.startedAt) : undefined;
  const endTime = run.completedAt ?? now;

  // Convert run-level events to span events
  const events = convertEventsToSpanEvents(runEvents, false);

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
