/**
 * Shared utilities for analyzing workflow events.
 * Used by run-actions and trace viewer components.
 */

import type { Event, WorkflowRunStatus } from '@workflow/world';

// Time thresholds for Re-enqueue button visibility
const STEP_ACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STEP_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Result of analyzing events for a workflow run
 */
export interface EventAnalysis {
  /** Whether there are pending sleep/wait calls */
  hasPendingSleeps: boolean;
  /** Whether there are pending steps (started but not completed/failed) */
  hasPendingSteps: boolean;
  /** Whether there are pending hooks (created but not disposed) */
  hasPendingHooks: boolean;
  /** Correlation IDs of pending sleeps */
  pendingSleepIds: string[];
  /** Correlation IDs of pending steps */
  pendingStepIds: string[];
  /** Correlation IDs of pending hooks */
  pendingHookIds: string[];
  /** Timestamp of the last step_started or step_retrying event */
  lastStepActivityAt: Date | null;
  /** Timestamp of the last step completion (step_completed or step_failed) */
  lastStepCompletionAt: Date | null;
}

/**
 * Analyze events to determine pending sleeps, steps, and hooks.
 */
export function analyzeEvents(events: Event[] | undefined): EventAnalysis {
  if (!events || events.length === 0) {
    return {
      hasPendingSleeps: false,
      hasPendingSteps: false,
      hasPendingHooks: false,
      pendingSleepIds: [],
      pendingStepIds: [],
      pendingHookIds: [],
      lastStepActivityAt: null,
      lastStepCompletionAt: null,
    };
  }

  // Group events by correlation ID for each type
  const waitCreated = new Map<string, Event>();
  const waitCompleted = new Set<string>();
  const stepStarted = new Map<string, Event>();
  const stepCompleted = new Set<string>();
  const hookCreated = new Map<string, Event>();
  const hookDisposed = new Set<string>();

  let lastStepActivityAt: Date | null = null;
  let lastStepCompletionAt: Date | null = null;

  for (const event of events) {
    const correlationId = event.correlationId;
    if (!correlationId) continue;

    switch (event.eventType) {
      // Sleeps/Waits
      case 'wait_created':
        waitCreated.set(correlationId, event);
        break;
      case 'wait_completed':
        waitCompleted.add(correlationId);
        break;

      // Steps
      case 'step_started':
        stepStarted.set(correlationId, event);
        if (
          !lastStepActivityAt ||
          new Date(event.createdAt) > lastStepActivityAt
        ) {
          lastStepActivityAt = new Date(event.createdAt);
        }
        break;
      case 'step_retrying':
        if (
          !lastStepActivityAt ||
          new Date(event.createdAt) > lastStepActivityAt
        ) {
          lastStepActivityAt = new Date(event.createdAt);
        }
        break;
      case 'step_completed':
      case 'step_failed':
        stepCompleted.add(correlationId);
        if (
          !lastStepCompletionAt ||
          new Date(event.createdAt) > lastStepCompletionAt
        ) {
          lastStepCompletionAt = new Date(event.createdAt);
        }
        break;

      // Hooks
      case 'hook_created':
        hookCreated.set(correlationId, event);
        break;
      case 'hook_disposed':
        hookDisposed.add(correlationId);
        break;
    }
  }

  // Find pending items (created but not completed)
  const pendingSleepIds = Array.from(waitCreated.keys()).filter(
    (id) => !waitCompleted.has(id)
  );
  const pendingStepIds = Array.from(stepStarted.keys()).filter(
    (id) => !stepCompleted.has(id)
  );
  const pendingHookIds = Array.from(hookCreated.keys()).filter(
    (id) => !hookDisposed.has(id)
  );

  return {
    hasPendingSleeps: pendingSleepIds.length > 0,
    hasPendingSteps: pendingStepIds.length > 0,
    hasPendingHooks: pendingHookIds.length > 0,
    pendingSleepIds,
    pendingStepIds,
    pendingHookIds,
    lastStepActivityAt,
    lastStepCompletionAt,
  };
}

/**
 * Check if a workflow run status is terminal (completed, failed, or cancelled)
 */
export function isTerminalStatus(
  status: WorkflowRunStatus | undefined
): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

/**
 * Determine if the Re-enqueue button should be shown without the debug flag.
 *
 * The Re-enqueue button is shown when the workflow appears to be stuck:
 * - The workflow is not in a terminal state
 * - There are no pending sleeps (which would show the Wake up button instead)
 * - There are no pending hooks (which are waiting for external input)
 * - Either:
 *   - The last step_started or step_retrying event was >30 minutes ago, OR
 *   - There have been no pending steps for >5 minutes (all steps completed/failed)
 */
export function shouldShowReenqueueButton(
  events: Event[] | undefined,
  status: WorkflowRunStatus | undefined
): boolean {
  // Never show if in terminal state
  if (isTerminalStatus(status)) {
    return false;
  }

  const analysis = analyzeEvents(events);

  // Don't show if there are pending sleeps (Wake up button handles this)
  if (analysis.hasPendingSleeps) {
    return false;
  }

  // Don't show if there are pending hooks (waiting for external input)
  if (analysis.hasPendingHooks) {
    return false;
  }

  const now = Date.now();

  // Check if last step activity was >30 minutes ago
  if (analysis.lastStepActivityAt) {
    const timeSinceLastActivity = now - analysis.lastStepActivityAt.getTime();
    if (timeSinceLastActivity > STEP_ACTIVITY_TIMEOUT_MS) {
      return true;
    }
  }

  // Check if there are no pending steps and last completion was >5 minutes ago
  if (!analysis.hasPendingSteps && analysis.lastStepCompletionAt) {
    const timeSinceLastCompletion =
      now - analysis.lastStepCompletionAt.getTime();
    if (timeSinceLastCompletion > STEP_IDLE_TIMEOUT_MS) {
      return true;
    }
  }

  // If there's no step activity at all but the run is not terminal,
  // and we've been waiting for a while, show the button
  if (
    !analysis.lastStepActivityAt &&
    !analysis.hasPendingSteps &&
    !analysis.hasPendingSleeps &&
    !analysis.hasPendingHooks
  ) {
    // This case handles runs that haven't started any steps yet
    // but aren't in a terminal state - they might be stuck
    return true;
  }

  return false;
}

/**
 * Check if there are pending sleeps from an events list.
 * This is a convenience function for backwards compatibility.
 */
export function hasPendingSleepsFromEvents(
  events: Event[] | undefined
): boolean {
  return analyzeEvents(events).hasPendingSleeps;
}

/**
 * Check if there are pending steps from an events list.
 */
export function hasPendingStepsFromEvents(
  events: Event[] | undefined
): boolean {
  return analyzeEvents(events).hasPendingSteps;
}

/**
 * Check if there are pending hooks from an events list.
 */
export function hasPendingHooksFromEvents(
  events: Event[] | undefined
): boolean {
  return analyzeEvents(events).hasPendingHooks;
}
