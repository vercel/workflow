/**
 * Color utilities for workflow traces
 */

import type { Step, WorkflowRun } from '@workflow/world';
import styles from '../trace-viewer/trace-viewer.module.css';
import type { SpanNode, SpanNodeEvent } from '../trace-viewer/types';

/**
 * Get the CSS class name for a workflow entity based on its status
 */
function getStatusClassName(
  status: Step['status'] | WorkflowRun['status'],
  isStripped = false
): string {
  if (isStripped && status === 'pending') {
    return styles.spanPendingStriped;
  }

  switch (status) {
    case 'running':
      return styles.spanRunning;
    case 'pending':
      return styles.spanPending;
    case 'completed':
      return styles.spanCompleted;
    case 'cancelled':
      return styles.spanCancelled;
    case 'failed':
      return styles.spanFailed;
    default:
      return '';
  }
}

/**
 * Check if a step name indicates it's a sleep step
 */
function isSleepStep(stepName: string): boolean {
  return String(stepName).toLowerCase().endsWith('sleep');
}

/**
 * Get custom CSS class name for a span based on its attributes
 * This is called dynamically by the trace viewer to style spans
 */
export const getCustomSpanClassName = (span: SpanNode): string => {
  const attributes = span.span.attributes;
  const resource = attributes?.resource;

  if (resource === 'step') {
    const stepData = attributes.data as Step;
    const stepName = stepData?.stepName;

    // DEPRECATED: Check if it's a sleep step
    if (stepName && isSleepStep(stepName)) {
      return styles.spanSleep;
    }

    // Regular step - use status colors
    const isStripped = stepData?.status === 'pending';
    return getStatusClassName(stepData?.status, isStripped);
  }

  if (resource === 'run') {
    const runData = attributes.data as WorkflowRun;
    return getStatusClassName(runData?.status, false);
  }

  if (resource === 'hook') {
    return styles.spanHook;
  }

  if (resource === 'sleep') {
    return styles.spanSleep;
  }

  // Default: no custom class
  return '';
};

/**
 * Get custom CSS class name for a span event based on its type
 * This is called dynamically by the trace viewer to style event markers
 */
export const getCustomSpanEventClassName = (
  spanEvent: SpanNodeEvent
): string => {
  const eventName = spanEvent.event.name;

  // Failure events - Red
  if (eventName === 'step_failed' || eventName === 'workflow_failed') {
    return styles.eventFailed;
  }

  // Retry events - Orange/Yellow
  if (eventName === 'step_retrying') {
    return styles.eventRetrying;
  }

  // Webhook-related events - Purple
  if (
    eventName === 'hook_created' ||
    eventName === 'hook_received' ||
    eventName === 'hook_disposed'
  ) {
    return styles.eventHook;
  }

  // Default - Blue
  return styles.eventDefault;
};
