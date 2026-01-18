import { pluralize } from '@workflow/utils';
import type { Serializable } from './schemas.js';

export interface StepInvocationQueueItem {
  type: 'step';
  correlationId: string;
  stepName: string;
  args: Serializable[];
  closureVars?: Record<string, Serializable>;
  thisVal?: Serializable;
}

export interface HookInvocationQueueItem {
  type: 'hook';
  correlationId: string;
  token: string;
  metadata?: Serializable;
}

export interface WaitInvocationQueueItem {
  type: 'wait';
  correlationId: string;
  resumeAt: Date;
  hasCreatedEvent?: boolean;
}

export type QueueItem =
  | StepInvocationQueueItem
  | HookInvocationQueueItem
  | WaitInvocationQueueItem;

/**
 * An error that is thrown when one or more operations (steps/hooks/etc.) are called but do
 * not yet have corresponding entries in the event log. The workflow
 * dispatcher will catch this error and push the operations
 * onto the queue.
 */
export class WorkflowSuspension extends Error {
  steps: QueueItem[];
  globalThis: typeof globalThis;
  stepCount: number;
  hookCount: number;
  waitCount: number;

  constructor(stepsInput: Map<string, QueueItem>, global: typeof globalThis) {
    // Convert Map to array for iteration and storage
    const steps = [...stepsInput.values()];

    // Single-pass counting for efficiency
    let stepCount = 0;
    let hookCount = 0;
    let waitCount = 0;
    for (const item of steps) {
      if (item.type === 'step') stepCount++;
      else if (item.type === 'hook') hookCount++;
      else if (item.type === 'wait') waitCount++;
    }

    // Build description parts
    const parts: string[] = [];
    if (stepCount > 0) {
      parts.push(`${stepCount} ${pluralize('step', 'steps', stepCount)}`);
    }
    if (hookCount > 0) {
      parts.push(`${hookCount} ${pluralize('hook', 'hooks', hookCount)}`);
    }
    if (waitCount > 0) {
      parts.push(`${waitCount} ${pluralize('wait', 'waits', waitCount)}`);
    }

    // Determine verb (has/have) and action (run/created/received)
    const totalCount = stepCount + hookCount + waitCount;
    const hasOrHave = pluralize('has', 'have', totalCount);
    let action: string;
    if (stepCount > 0) {
      action = 'run';
    } else if (hookCount > 0) {
      action = 'created';
    } else if (waitCount > 0) {
      action = 'created';
    } else {
      action = 'received';
    }

    const description =
      parts.length > 0
        ? `${parts.join(' and ')} ${hasOrHave} not been ${action} yet`
        : '0 steps have not been run yet'; // Default case for empty array
    super(description);
    this.name = 'WorkflowSuspension';
    this.steps = steps;
    this.globalThis = global;
    this.stepCount = stepCount;
    this.hookCount = hookCount;
    this.waitCount = waitCount;
  }

  static is(value: unknown): value is WorkflowSuspension {
    return value instanceof WorkflowSuspension;
  }
}

export function ENOTSUP(): never {
  throw new Error('Not supported in workflow functions');
}
