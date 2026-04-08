import {
  createLimitsNotImplementedError,
  type LimitConcurrency,
  type LimitKey,
  type LimitLease,
  type LimitRate,
} from '@workflow/world';
import { WORKFLOW_HAS_STEP_CONTEXT, WORKFLOW_LOCK } from './symbols.js';

export { LIMITS_NOT_IMPLEMENTED_MESSAGE } from '@workflow/world';

export const LOCK_WORKFLOW_ONLY_MESSAGE =
  '`lock()` is only supported in workflow functions. Wrap the step call with `await using` in workflow code.';

type LockBaseOptions = {
  key: LimitKey;
  leaseTtlMs?: number;
};

type LockConcurrencyOptions = LockBaseOptions & {
  concurrency: LimitConcurrency;
  rate?: never;
};

type LockRateOptions = LockBaseOptions & {
  concurrency?: never;
  rate: LimitRate;
};

type LockConcurrencyAndRateOptions = LockBaseOptions & {
  concurrency: LimitConcurrency;
  rate: LimitRate;
};

export type LockOptions =
  | LockConcurrencyOptions
  | LockRateOptions
  | LockConcurrencyAndRateOptions;

/**
 * Reserved handle shape for future lock acquisition.
 */
export interface LockHandle extends LimitLease {
  dispose(): Promise<void>;
  heartbeat(): Promise<void>;
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

  const hasStepContext = (globalThis as any)[WORKFLOW_HAS_STEP_CONTEXT] as
    | (() => boolean)
    | undefined;
  if (hasStepContext?.()) {
    throw new Error(LOCK_WORKFLOW_ONLY_MESSAGE);
  }

  throw createLimitsNotImplementedError();
}
