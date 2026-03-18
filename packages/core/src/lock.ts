import {
  createLimitsNotImplementedError,
  type LimitDefinition,
  type LimitKey,
  type LimitLease,
} from '@workflow/world';
import { STEP_LOCK, WORKFLOW_LOCK } from './symbols.js';

export { LIMITS_NOT_IMPLEMENTED_MESSAGE } from '@workflow/world';

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
  extends Pick<LimitLease, 'leaseId' | 'key' | 'holderId' | 'expiresAt'> {
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

  const stepLock = (globalThis as any)[STEP_LOCK] as
    | ((options: LockOptions) => Promise<LockHandle>)
    | undefined;

  if (stepLock) {
    return stepLock(options);
  }

  throw createLimitsNotImplementedError();
}
