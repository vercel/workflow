/**
 * Rate Limiter — bound your outbound request rate, cluster-wide.
 *
 * THE PATTERN:
 *   1. A coordination workflow per limiter key grants request slots from a
 *      single event channel, sleeping intervalMs between grants — so the
 *      whole cluster makes at most one request per interval.
 *   2. Callers request a slot with a fresh reply hook and suspend until
 *      granted. Requests queue in the channel in arrival order.
 *   3. Senders lazily (re)start the coordinator; waiters re-request if a
 *      grant doesn't arrive in time. Everything self-heals.
 *
 * USEFUL WHEN:
 *   - An API allows N requests/second and you have many concurrent
 *     workflow runs that all call it.
 *   - You'd rather smooth your traffic than react to 429s (for reactive
 *     handling, see the Handling Rate Limits pattern — they compose well).
 *
 * CAVEATS / TO ADAPT:
 *   - withRateLimit() must be called from a workflow function.
 *   - This is a "smooth" limiter (fixed spacing). For burst allowances,
 *     track a token count in the coordinator and only sleep when it's
 *     exhausted.
 *   - SLOT_RETRY_TIMEOUT bounds how long a caller queues before retrying;
 *     size it to queueDepth × intervalMs for your worst case.
 *   - All callers for a key should pass the same intervalMs — the value
 *     used by whichever caller starts the coordinator wins.
 *
 * DOCS: https://workflow-sdk.dev/patterns/rate-limiter
 */
import { createHook, defineHook, sleep } from 'workflow';
import { resumeHook, start } from 'workflow/api';

// Single event channel per limiter key — one consumer (the coordinator)
// grants slots in arrival order.
export const rateLimiterEvents = defineHook<{ grantToken: string }>();

function limiterToken(key: string) {
  return `rate-limiter:${key}`;
}

// How long a waiter waits for its slot before re-requesting. Should exceed
// the worst expected queue delay: queueDepth × intervalMs.
const SLOT_RETRY_TIMEOUT = '120s';
const MAX_SLOT_ATTEMPTS = 5;
// Recycle the coordinator run after this many grants so its event log
// stays bounded. Senders transparently restart it; queued waiters that get
// dropped by a recycle re-request after SLOT_RETRY_TIMEOUT.
const RECYCLE_AFTER_GRANTS = 1000;

// COORDINATOR — grants one slot, then sleeps intervalMs before granting
// the next. Queued requests buffer in the hook channel, giving you strict
// spacing (max rate = 1000 / intervalMs requests per second).
export async function rateLimiterCoordinator(key: string, intervalMs: number) {
  'use workflow';

  const events = rateLimiterEvents.create({ token: limiterToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  let grants = 0;

  for (;;) {
    const { grantToken } = await events;
    const granted = await grantSlot(grantToken);
    if (granted) {
      grants++;
      // The spacing that enforces the rate. Skipped for dead waiters so a
      // pile of expired requests can't stall the queue.
      await sleep(`${intervalMs}ms`);
    }
    if (grants >= RECYCLE_AFTER_GRANTS) {
      return { grants };
    }
  }
}

async function grantSlot(grantToken: string): Promise<boolean> {
  'use step';
  try {
    await resumeHook(grantToken, { granted: true });
    return true;
  } catch {
    return false;
  }
}

async function sendSlotRequest(
  key: string,
  intervalMs: number,
  grantToken: string
): Promise<void> {
  'use step';
  for (let i = 0; i < 3; i++) {
    try {
      await rateLimiterEvents.resume(limiterToken(key), { grantToken });
      return;
    } catch {
      // Coordinator not running (or just recycled) — start it and retry.
    }
    try {
      await start(rateLimiterCoordinator, [key, intervalMs]);
    } catch {
      // Another sender raced us to start it — retry the resume.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Could not reach rate limiter coordinator for "${key}"`);
}

/**
 * Wait for a request slot on the `key` limiter, then run `fn`. Slots are
 * granted at most once per `intervalMs` across ALL runs and machines.
 * Call from a workflow function.
 */
export async function withRateLimit<T>(
  key: string,
  intervalMs: number,
  fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt++) {
    const grant = createHook<{ granted: true }>();
    await sendSlotRequest(key, intervalMs, grant.token);

    const granted = await Promise.race([
      grant.then(() => true as const),
      sleep(SLOT_RETRY_TIMEOUT).then(() => false as const),
    ]);

    if (!granted) {
      // Make our stale token un-grantable so the coordinator's queue can't
      // burn a slot on a request nobody is waiting for.
      grant.dispose();
      continue;
    }

    return fn();
  }
  throw new Error(`Failed to acquire rate limit slot for "${key}"`);
}
