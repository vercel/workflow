/**
 * Shared utilities for analyzing workflow events.
 * Used by run-actions and trace viewer components.
 */

import { type Event, isRunCreationEvent } from '@workflow/world';
import { findStartHookCreation } from './start-hook';

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

  // A start Hook has no `hook_created`: the run's creation stands for it.
  const startHook = findStartHookCreation(events);
  if (startHook && !hookCreated.has(startHook.hookId)) {
    const creationEvent = events.find(isRunCreationEvent);
    if (creationEvent) hookCreated.set(startHook.hookId, creationEvent);
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
