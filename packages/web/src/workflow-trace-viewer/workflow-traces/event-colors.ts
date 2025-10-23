/**
 * Color utilities for workflow event markers
 */

import type { Event } from '@workflow/world';

export interface EventColorPalette {
  /** Color of the diamond/marker itself */
  color: string;
  /** Background color for hover info popup */
  background: string;
  /** Border color for hover info popup */
  border: string;
  /** Text color for event name in hover popup */
  text: string;
  /** Secondary text color for timestamp in hover popup */
  secondary: string;
}

/**
 * Get the color palette for an event based on its type
 * - Red for failures (step_failed, workflow_failed)
 * - Orange/yellow for retries (step_retrying)
 * - Purple for webhook-related events
 * - Blue otherwise (default)
 */
export function getEventColor(
  eventType: Event['eventType']
): EventColorPalette {
  // Failures - Red
  if (eventType === 'step_failed' || eventType === 'workflow_failed') {
    return {
      color: 'var(--ds-red-600)',
      background: 'var(--ds-red-100)',
      border: 'var(--ds-red-500)',
      text: 'var(--ds-red-900)',
      secondary: 'var(--ds-red-700)',
    };
  }

  // Retries - Orange/Yellow
  if (eventType === 'step_retrying') {
    return {
      color: 'var(--ds-amber-600)',
      background: 'var(--ds-amber-100)',
      border: 'var(--ds-amber-500)',
      text: 'var(--ds-amber-900)',
      secondary: 'var(--ds-amber-700)',
    };
  }

  // Webhook-related - Purple
  if (
    eventType === 'hook_created' ||
    eventType === 'hook_received' ||
    eventType === 'hook_disposed'
  ) {
    return {
      color: 'var(--ds-purple-600)',
      background: 'var(--ds-purple-100)',
      border: 'var(--ds-purple-500)',
      text: 'var(--ds-purple-900)',
      secondary: 'var(--ds-purple-700)',
    };
  }

  // Default - Blue
  return {
    color: 'var(--ds-blue-600)',
    background: 'var(--ds-blue-100)',
    border: 'var(--ds-blue-500)',
    text: 'var(--ds-blue-900)',
    secondary: 'var(--ds-blue-700)',
  };
}

/**
 * Determine whether to show a vertical line for an event
 * - Show vertical lines for hook-related events
 * - Hide vertical lines for all other workflow events by default
 */
export function shouldShowVerticalLine(eventType: Event['eventType']): boolean {
  // Show vertical lines for hook-related events
  if (
    eventType === 'hook_created' ||
    eventType === 'hook_received' ||
    eventType === 'hook_disposed'
  ) {
    return true;
  }

  // Hide vertical lines for all other workflow events
  return false;
}
