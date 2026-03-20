import {
  createLimitsNotImplementedError,
  type LimitDefinition,
  type LimitKey,
  type LimitLease,
} from '@workflow/world';
import { contextStorage } from './step/context-storage.js';
import { WORKFLOW_LOCK } from './symbols.js';

export { LIMITS_NOT_IMPLEMENTED_MESSAGE } from '@workflow/world';

export const LOCK_WORKFLOW_ONLY_MESSAGE =
  '`lock()` is only supported in workflow functions. Wrap the step call with `await using` in workflow code.';

/**
 * Reserved first-pass user-facing API for future flow concurrency and rate
 * limiting inside workflow functions.
 */
export interface LockOptions extends LimitDefinition {
  key: LimitKey;
  leaseTtlMs?: number;
}

/**
 * Reserved handle shape for future lock acquisition.
 */
export interface LockHandle
  extends Pick<
    LimitLease,
    'leaseId' | 'key' | 'lockId' | 'runId' | 'lockIndex' | 'expiresAt'
  > {
  dispose(): Promise<void>;
  heartbeat(ttlMs?: number): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Reserved workflow API for future concurrency and rate limiting.
 */
export async function lock(options: LockOptions): Promise<LockHandle> {
  const workflowLock = (globalThis as any)[WORKFLOW_LOCK] as
    | ((options: LockOptions) => Promise<LockHandle>)
    | undefined;

  if (workflowLock) {
    return workflowLock(options);
  }

  if (contextStorage.getStore()) {
    throw new Error(LOCK_WORKFLOW_ONLY_MESSAGE);
  }

  throw createLimitsNotImplementedError();
}
