/**
 * Types and constants for constructing OpenTelemetry-style traces from workflow data
 */

import type { Hook, Step, WorkflowRun } from '@workflow/world';

/**
 * Map workflow status to deterministic resource codes for consistent coloring
 * Each resource code will get a unique color index in order
 */
const STATUS_RESOURCE_MAP: Record<string, string> = {
  pending: 'workflow.status.0-pending',
  running: 'workflow.status.1-running',
  completed: 'workflow.status.2-completed',
  paused: 'workflow.status.3-paused',
  sleep: 'workflow.status.4-sleep',
  failed: 'workflow.status.5-failed',
  cancelled: 'workflow.status.6-cancelled',
};

/**
 * Library information for all workflow spans
 */
export const WORKFLOW_LIBRARY = {
  name: 'vercel-workflow',
  version: '0.1',
};

/**
 * Converts a workflow Step status to an OpenTelemetry status code
 * @see https://opentelemetry.io/docs/specs/otel/trace/api/#set-status
 */
export function getResourceStatus(status: Step['status']): { code: number } {
  let code = 0;
  switch (status) {
    case 'completed':
      code = 1; // OK
      break;
    case 'failed':
      code = 2; // ERROR
      break;
    case 'pending':
    case 'running':
    case 'cancelled':
    default:
      code = 0; // UNSET
  }

  return { code };
}

/**
 * Get the appropriate resource code based on the workflow entity
 */
export function getResourceCode(resource: Step | WorkflowRun | Hook): string {
  const name = 'stepId' in resource ? resource.stepName : '';
  if (name.toLowerCase() === 'sleep') {
    return STATUS_RESOURCE_MAP.sleep;
  }
  if ('hookId' in resource) {
    return 'workflow.hook';
  }
  return getStatusResource(resource.status);
}

/**
 * Map a status to its resource code
 */
export function getStatusResource(
  status: Step['status'] | WorkflowRun['status']
): string {
  if (status === 'pending') return STATUS_RESOURCE_MAP.pending;
  if (status === 'running') return STATUS_RESOURCE_MAP.running;
  if (status === 'completed') return STATUS_RESOURCE_MAP.completed;
  if (status === 'paused') return STATUS_RESOURCE_MAP.paused;
  if (status === 'failed') return STATUS_RESOURCE_MAP.failed;
  if (status === 'cancelled') return STATUS_RESOURCE_MAP.cancelled;
  return STATUS_RESOURCE_MAP.pending;
}
