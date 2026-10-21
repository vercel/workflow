import { throwNotInWorkflowContext } from './context-errors.js';
import { WORKFLOW_LOCK } from './symbols.js';

/** Options for {@link lock}. */
export interface LockOptions {
  /**
   * How many holders the key admits at once. An integer of at least 1.
   *
   * First writer wins: the value is fixed by the first acquisition of a key
   * the World has no record of, and later acquisitions asking for another
   * value are admitted against the stored one (a warning is logged). A key
   * nobody holds adopts the next acquisition's value.
   */
  concurrency: number;
  /**
   * Opt-in lease, in milliseconds. By default a holder keeps its slot until
   * it releases or its run completes, fails or is cancelled, however long
   * that takes (a lock held across `sleep('7d')` stays held).
   *
   * With a lease, the World may reclaim the slot once it expires even though
   * the holder is still running, and admit another holder: **two holders can
   * then be inside the critical section at once.** Use
   * {@link LockSlot.fencingToken} to let downstream systems reject the stale
   * one.
   */
  leaseTtlMs?: number;
}

/**
 * One held slot of a lock key. Release it with `await using`, `using`, or
 * {@link LockSlot.release}; all three do the same thing, and releasing twice
 * is a no-op. A slot not released by the time its run ends is reclaimed by
 * the World.
 */
export interface LockSlot {
  /** The lock key this slot belongs to. */
  readonly key: string;
  /**
   * A number that strictly increases with every grant of this key. Pass it
   * to systems the critical section writes to, and have them reject a write
   * whose token is lower than one they have already seen: that write comes
   * from a holder that has since lost its slot (an expired lease, or an
   * operator's force-release).
   */
  readonly fencingToken: number;
  /**
   * The key's enforced concurrency, which differs from the requested one when
   * an earlier acquisition fixed another value.
   */
  readonly concurrency: number;
  /** Release the slot. Recorded at the workflow's next suspension. */
  release(): void;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Acquire one slot of a distributed semaphore, suspending the workflow run
 * until a slot is free.
 *
 * ```ts
 * await using slot = await experimental_lock(`stripe:${customerId}`, { concurrency: 5 });
 * await charge(customerId); // a step, gated by the lock
 * ```
 *
 * Note the two `await`s: `await using` only awaits the release at scope exit,
 * so acquisition needs its own.
 *
 * Experimental: the API may change. Stage 1 is not FIFO (waiting runs poll
 * with backoff), and it is supported on the Local and Postgres Worlds, and on
 * Vercel once the backend ships it.
 *
 * Only available in workflow functions. To limit a step's concurrency, wrap
 * its call site. A run waiting for a slot is suspended and costs nothing
 * while it waits: retries add no events to its log.
 *
 * Requires a World that supports locks; on any other `experimental_lock()` throws
 * `LockUnsupportedError` rather than run unbounded.
 */
export async function experimental_lock(
  key: string,
  options: LockOptions
): Promise<LockSlot> {
  // Inside the workflow VM, the lock function is stored on globalThis behind a symbol
  const lockFn = (globalThis as any)[WORKFLOW_LOCK];
  if (!lockFn) {
    throwNotInWorkflowContext(
      'experimental_lock()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/experimental-lock',
      experimental_lock
    );
  }
  return lockFn(key, options);
}
