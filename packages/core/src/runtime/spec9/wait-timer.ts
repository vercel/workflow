import { globalSingleton } from '@workflow/utils';
import type { WorkflowInvokePayload } from '@workflow/world';
import { getWaitContinuationDispatch } from '../wait-continuation.js';

type WaitContinuation = NonNullable<WorkflowInvokePayload['waitContinuation']>;

/**
 * The timer message of a spec 9 wait, `seconds` before it is due.
 *
 * A wait longer than one queue delay (`getWaitContinuationDispatch`) is
 * reached in hops. Every hop but the last is an intermediate hop: it carries
 * the wait's deadline (`waitContinuation.resumeAtMs`), which tells the World
 * not to serialize or coalesce it (`isIntermediateWaitHop` in
 * `@workflow/world`), and its delivery only sends the next hop (see
 * `continueWaitHop` in `delivery.ts`). The last hop, due with the wait,
 * carries no deadline and is an ordinary orchestrator message: if the queue
 * coalesces it into a running delivery of the run, that delivery's re-run
 * finds the wait due and completes it.
 *
 * The timers a delivery arms for the chains it owns, a timer delivery's
 * re-arm, and the intermediate hops carry no idempotency key: each is sent
 * once per owner, and a key spent by an early delivery would drop the
 * re-arm. Only the near-due safety net's re-arms carry one
 * ({@link nearDueTimerIdempotencyKey}).
 */
export function waitTimerMessage(params: {
  correlationId: string;
  resumeAtMs: number;
  /** Seconds until the wait is due, as the caller rounds them. */
  seconds: number;
  nowMs: number;
  attempt?: number;
}): { waitContinuation: WaitContinuation; delaySeconds: number } {
  const { correlationId, resumeAtMs, seconds, nowMs, attempt = 0 } = params;
  const { delaySeconds } = getWaitContinuationDispatch(
    seconds,
    correlationId,
    nowMs,
    attempt
  );
  return {
    delaySeconds,
    waitContinuation: {
      correlationId,
      attempt,
      ...(delaySeconds < seconds ? { resumeAtMs } : {}),
    },
  };
}

/**
 * The idempotency key of a near-due re-arm: the timer a suspending delivery
 * that may hold a coalesced timer sends for an open wait due within the
 * near-due window, whatever chain the wait is in (`armNearDueTimers` in
 * `delivery.ts`, and the QuickJS engine's exit sweep).
 *
 * Without a key every such delivery sent one timer for every near-due wait,
 * and nothing deduplicated them: a fan-out whose waits came due one
 * delivery at a time sent a timer per wait per delivery. The key collapses
 * the re-arms of one wait, for one `resumeAt`, sent within the same second
 * of the sender's clock, into one message on every World (world-vercel
 * keeps a key for a day, world-local while its message lives, world-postgres
 * while its job exists).
 *
 * The second is part of the key so that a re-arm can itself be re-armed: a
 * re-arm reaches the queue with a delay of at least a second, so the
 * delivery it may be coalesced into early, a little before its wait is due,
 * sends its own re-arm in a later second, under a fresh key. A key of the
 * wait alone would be spent by the first re-arm, and the second one dropped.
 * The wait's `resumeAt` keeps the key apart from any other deadline the
 * same correlation id could have.
 *
 * The timer a wait's own chain arms carries no key (see
 * {@link waitTimerMessage}): a re-arm is sent by the delivery the queue may
 * have coalesced that timer into, while that timer is still being
 * delivered, and the same key would drop the re-arm against it.
 */
export function nearDueTimerIdempotencyKey(params: {
  correlationId: string;
  resumeAtMs: number;
  nowMs: number;
}): string {
  const { correlationId, resumeAtMs, nowMs } = params;
  return `wait:${correlationId}:${resumeAtMs}:${Math.floor(nowMs / 1000)}`;
}

/** How many near-due re-arm keys {@link sendNearDueTimerOnce} remembers. */
export const SENT_NEAR_DUE_TIMER_KEYS_LIMIT = 10_000;

// On `globalThis` (see `globalSingleton`): every bundled copy of this module
// in the process shares the keys it sent.
const sentNearDueTimerKeys = globalSingleton(
  '@workflow/core//sentNearDueTimerKeys',
  1,
  () => ({ keys: new Set<string>() })
);

/**
 * Sends a near-due re-arm (`send`) unless this process already sent one
 * under `key` ({@link nearDueTimerIdempotencyKey}), and says whether it
 * sent. Every coalesced re-run of a busy run's delivery arms every near-due
 * wait, and the queue would drop each repeat by its key anyway: this skips
 * the send itself, which a suspending delivery otherwise makes once per
 * near-due wait. A failed send is forgotten, so a later delivery retries it.
 * Bounded to the {@link SENT_NEAR_DUE_TIMER_KEYS_LIMIT} newest keys.
 */
export async function sendNearDueTimerOnce(
  key: string,
  send: () => Promise<void>
): Promise<boolean> {
  const { keys } = sentNearDueTimerKeys;
  if (keys.has(key)) return false;
  keys.add(key);
  try {
    await send();
  } catch (error) {
    keys.delete(key);
    throw error;
  }
  while (keys.size > SENT_NEAR_DUE_TIMER_KEYS_LIMIT) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) break;
    keys.delete(oldest);
  }
  return true;
}
