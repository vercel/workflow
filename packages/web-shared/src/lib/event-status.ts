/**
 * Shared status-dot color mapping for workflow events.
 *
 * Used by the run detail page's events views (the Events tab and the
 * detail panel's Events section) so both surfaces communicate event state
 * with one consistent, meaningful color scale. Colors are always paired
 * with the event type text, so state is never communicated by color alone.
 */

/** Returns a CSS color using Geist design tokens for an event status dot. */
export function getEventStatusDotColor(eventType: string): string {
  // Failed → red
  if (
    eventType === 'step_failed' ||
    eventType === 'run_failed' ||
    eventType === 'workflow_failed'
  ) {
    return 'var(--ds-red-700)';
  }
  // Cancelled / retrying → amber
  if (eventType === 'run_cancelled' || eventType === 'step_retrying') {
    return 'var(--ds-amber-700)';
  }
  // Attribute changes → teal
  if (eventType === 'attr_set') {
    return 'var(--ds-teal-900)';
  }
  // Completed / succeeded → green
  if (
    eventType === 'step_completed' ||
    eventType === 'run_completed' ||
    eventType === 'workflow_completed' ||
    eventType === 'hook_disposed' ||
    eventType === 'wait_completed'
  ) {
    return 'var(--ds-green-700)';
  }
  // Started / running → blue
  if (
    eventType === 'step_started' ||
    eventType === 'run_started' ||
    eventType === 'workflow_started' ||
    eventType === 'hook_received'
  ) {
    return 'var(--ds-blue-700)';
  }
  // Created / pending → gray
  return 'var(--ds-gray-600)';
}
