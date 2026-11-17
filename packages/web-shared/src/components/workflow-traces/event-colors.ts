/**
 * Marker helpers for workflow events
 */

import { type Event, isHookLifecycleEventType } from '@workflow/world';

/**
 * Determine whether to show a vertical line for an event
 * - Show vertical lines for hook-related events
 * - Hide vertical lines for all other workflow events by default
 */
export function shouldShowVerticalLine(eventType: Event['eventType']): boolean {
  // Show vertical lines for hook-related events
  if (isHookLifecycleEventType(eventType)) {
    return true;
  }

  // Hide vertical lines for all other workflow events
  return false;
}
