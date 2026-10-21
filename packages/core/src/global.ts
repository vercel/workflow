import { WorkflowRuntimeError } from '@workflow/errors';
import { pluralize } from '@workflow/utils';
import type { AttributeChange } from '@workflow/world';
import type { Serializable } from './schemas.js';

export interface StepInvocationQueueItem {
  type: 'step';
  correlationId: string;
  stepName: string;
  args: Serializable[];
  closureVars?: Record<string, Serializable>;
  thisVal?: Serializable;
  hasCreatedEvent?: boolean;
  /**
   * Inline step ownership, derived from the step's LATEST `step_started`
   * during replay: the queue message ID stamped by the invocation running
   * the step inline, or undefined when the latest start was unstamped (a
   * retry attempt driven by a queued step message, or an older runtime).
   * Latest start wins: an unstamped bare start clears a previous stamp; an
   * owner-recovery re-stamped start restores it.
   */
  ownerMessageId?: string;
  /**
   * `createdAt` (ms) of the step's latest observed `step_started`. Anchors
   * the ownership lease: `leaseRemaining = lastStartedAt + lease − now`.
   */
  lastStartedAt?: number;
  /**
   * Whether a `step_retrying` was observed for this step. From that point
   * the step is queue-owned (the delayed retry handoff or replay requeue),
   * so inline ownership is permanently lapsed for this correlation ID.
   */
  sawRetrying?: boolean;
}

export interface HookInvocationQueueItem {
  type: 'hook';
  correlationId: string;
  token: string;
  /** Earliest time the token can be reused after the run ends. */
  tokenRetentionUntil?: Date;
  /** `createHook({ experimental_force })`: take the token over if held. */
  force?: boolean;
  metadata?: Serializable;
  hasCreatedEvent?: boolean;
  /** Whether the workflow is awaiting `hook.getConflict()` for this hook */
  hasConflictAwaiter?: boolean;
  disposed?: boolean;
  isWebhook?: boolean;
  isSystem?: boolean;
  abortRequested?: boolean;
  abortReason?: unknown;
}

export interface WaitInvocationQueueItem {
  type: 'wait';
  correlationId: string;
  resumeAt: Date;
  hasCreatedEvent?: boolean;
}

/**
 * One `experimental_lock()` scope. Stays queued from the call until its `lock_released`
 * is in the log: pending while it waits for a slot, held after
 * `lock_acquired`, and flagged `released` once workflow code releases it so
 * the next suspension writes the `lock_released`.
 */
export interface LockInvocationQueueItem {
  type: 'lock';
  correlationId: string;
  key: string;
  concurrency: number;
  leaseTtlMs?: number;
  /** A `lock_created` for this scope is in the log (it has waited). */
  hasCreatedEvent?: boolean;
  /** A `lock_acquired` for this scope is in the log. */
  acquired?: boolean;
  /** Workflow code released the slot; `lock_released` is owed. */
  released?: boolean;
}

export interface AttributeInvocationQueueItem {
  type: 'attribute';
  correlationId: string;
  changes: AttributeChange[];
  allowReservedAttributes?: true;
}

export type QueueItem =
  | StepInvocationQueueItem
  | HookInvocationQueueItem
  | WaitInvocationQueueItem
  | LockInvocationQueueItem
  | AttributeInvocationQueueItem;

/**
 * An error that is thrown when one or more operations (steps/hooks/etc.) are called but do
 * not yet have corresponding entries in the event log. The workflow
 * dispatcher will catch this error and push the operations
 * onto the queue.
 */
export class WorkflowSuspension extends Error {
  items: QueueItem[];
  /** @deprecated Use `items` instead. */
  steps: QueueItem[];
  globalThis: typeof globalThis;
  stepCount: number;
  hookCount: number;
  waitCount: number;
  attributeCount: number;
  hookDisposedCount: number;
  abortCount: number;
  /** Lock scopes still waiting for a slot. */
  lockCount: number;
  /** Lock scopes whose release is not recorded yet. */
  lockReleaseCount: number;
  /**
   * Correlation ids of the open hooks that workflow code was waiting on a
   * payload for when the VM went idle, i.e. the hooks whose `hook_received`
   * could change what this suspension leads to. A hook absent from the set has
   * no waiting consumer, so a payload landing for it is buffered and inert
   * until the first `await`. `undefined` when the suspension was built without
   * the workflow context that tracks awaiters, which callers must read as
   * "every open hook is observed". See `runtime/out-of-band-observation.ts`.
   */
  observedHookIds?: ReadonlySet<string>;

  constructor(itemsInput: Map<string, QueueItem>, global: typeof globalThis) {
    // Convert Map to array for iteration and storage
    const items = [...itemsInput.values()];

    // Single-pass counting for efficiency
    let stepCount = 0;
    let hookCount = 0;
    let waitCount = 0;
    let attributeCount = 0;
    let hookDisposedCount = 0;
    let abortCount = 0;
    let lockCount = 0;
    let lockReleaseCount = 0;
    for (const item of items) {
      if (item.type === 'step') stepCount++;
      else if (item.type === 'hook') {
        if (item.disposed) hookDisposedCount++;
        else if (item.abortRequested) abortCount++;
        else hookCount++;
      } else if (item.type === 'wait') waitCount++;
      else if (item.type === 'attribute') attributeCount++;
      else if (item.type === 'lock') {
        if (item.released) lockReleaseCount++;
        else if (!item.acquired) lockCount++;
      }
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
    if (attributeCount > 0) {
      parts.push(
        `${attributeCount} ${pluralize('attribute write', 'attribute writes', attributeCount)}`
      );
    }
    if (hookDisposedCount > 0) {
      parts.push(
        `${hookDisposedCount} hook ${pluralize('disposal', 'disposals', hookDisposedCount)}`
      );
    }
    if (lockCount > 0) {
      parts.push(`${lockCount} ${pluralize('lock', 'locks', lockCount)}`);
    }
    if (lockReleaseCount > 0) {
      parts.push(
        `${lockReleaseCount} lock ${pluralize('release', 'releases', lockReleaseCount)}`
      );
    }

    // Determine verb (has/have) and action (run/created/received)
    const totalCount =
      stepCount +
      hookCount +
      waitCount +
      attributeCount +
      hookDisposedCount +
      lockCount +
      lockReleaseCount;
    const hasOrHave = pluralize('has', 'have', totalCount);
    // Pick action verb: use "processed" when mixed types are present
    const typeCount =
      (stepCount > 0 ? 1 : 0) +
      (hookCount > 0 ? 1 : 0) +
      (waitCount > 0 ? 1 : 0) +
      (attributeCount > 0 ? 1 : 0) +
      (hookDisposedCount > 0 ? 1 : 0) +
      (lockCount > 0 ? 1 : 0) +
      (lockReleaseCount > 0 ? 1 : 0);
    let action: string;
    if (typeCount > 1) {
      action = 'processed';
    } else if (stepCount > 0) {
      action = 'run';
    } else if (hookCount > 0) {
      action = 'created';
    } else if (waitCount > 0) {
      action = 'created';
    } else if (attributeCount > 0) {
      action = 'written';
    } else if (hookDisposedCount > 0) {
      action = 'processed';
    } else if (lockCount > 0) {
      action = 'acquired';
    } else if (lockReleaseCount > 0) {
      action = 'processed';
    } else {
      action = 'received';
    }

    const description =
      parts.length > 0
        ? `${parts.join(' and ')} ${hasOrHave} not been ${action} yet`
        : '0 steps have not been run yet'; // Default case for empty array
    super(description);
    this.name = 'WorkflowSuspension';
    this.items = items;
    this.steps = items;
    this.globalThis = global;
    this.stepCount = stepCount;
    this.hookCount = hookCount;
    this.waitCount = waitCount;
    this.attributeCount = attributeCount;
    this.hookDisposedCount = hookDisposedCount;
    this.abortCount = abortCount;
    this.lockCount = lockCount;
    this.lockReleaseCount = lockReleaseCount;
  }

  static is(value: unknown): value is WorkflowSuspension {
    return value instanceof WorkflowSuspension;
  }
}

export function ENOTSUP(): never {
  throw new WorkflowRuntimeError(
    'This API is not available inside a workflow function. Workflow functions run in a deterministic VM; move the call to a step function for full Node.js access.'
  );
}
