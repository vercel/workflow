import { types } from 'node:util';
import type { Serializable } from './schemas.js';

export interface StepInvocationQueueItem {
  type: 'step';
  correlationId: string;
  stepName: string;
  args: Serializable[];
}

export interface HookInvocationQueueItem {
  type: 'hook';
  correlationId: string;
  token: string;
  metadata?: Serializable;
}

export type QueueItem = StepInvocationQueueItem | HookInvocationQueueItem;

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

  constructor(steps: QueueItem[], global: typeof globalThis) {
    const stepCount = steps.filter((s) => s.type === 'step').length;
    const hookCount = steps.filter((s) => s.type === 'hook').length;

    // Build description parts
    const parts: string[] = [];
    if (stepCount > 0) {
      parts.push(`${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`);
    }
    if (hookCount > 0) {
      parts.push(`${hookCount} ${hookCount === 1 ? 'hook' : 'hooks'}`);
    }

    // Determine verb (has/have) and action (run/created/received)
    const totalCount = stepCount + hookCount;
    const hasOrHave = totalCount === 1 ? 'has' : 'have';
    let action: string;
    if (stepCount > 0) {
      action = 'run';
    } else if (hookCount > 0) {
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
  }

  static is(value: unknown): value is WorkflowSuspension {
    return types.isNativeError(value) && value.name === 'WorkflowSuspension';
  }
}

export function ENOTSUP(): never {
  throw new Error('Not supported in workflow functions');
}
