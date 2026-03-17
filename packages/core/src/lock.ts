import {
  createLimitsNotImplementedError,
  type LimitDefinition,
  type LimitKey,
  type LimitLease,
} from '@workflow/world';

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
  release(): Promise<void>;
  heartbeat(ttlMs?: number): Promise<void>;
}

/**
 * Reserved workflow API for future concurrency and rate limiting.
 *
 * This placeholder intentionally throws until the runtime and world
 * implementations gain real support.
 */
export async function lock(_options: LockOptions): Promise<LockHandle> {
  throw createLimitsNotImplementedError();
}
