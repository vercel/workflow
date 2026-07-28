/**
 * Semaphore — at most N concurrent executions across all runs and machines.
 *
 * THE PATTERN:
 *   1. A coordination workflow per semaphore key owns the permit count and
 *      reads a single event channel (acquire / release) in a loop — one
 *      consumer means strict FIFO and no lost messages.
 *   2. Waiters request a permit with a fresh reply hook, then suspend until
 *      the coordinator grants it. Zero compute while waiting.
 *   3. Releases return capacity; the coordinator grants the next waiter.
 *   4. Everything self-heals: senders lazily (re)start the coordinator, and
 *      waiters re-request if a grant doesn't arrive in time.
 *
 * USEFUL WHEN:
 *   - "At most 3 concurrent syncs against this third-party API" across all
 *     workflow runs, deployments, and machines.
 *   - Serializing access to a resource that can't take concurrent writers
 *     (withLock = semaphore of 1).
 *   - Bounding fan-out concurrency beyond a single parent run.
 *
 * CAVEATS / TO ADAPT:
 *   - withPermit() must be called from a workflow function (it creates
 *     hooks and uses durable sleep).
 *   - All callers for a key should pass the same maxConcurrent — the value
 *     used by whichever caller starts the coordinator wins.
 *   - ACQUIRE_RETRY_TIMEOUT bounds one whole acquire attempt — the request
 *     to the coordinator plus the wait for a grant — so it should exceed
 *     your longest typical hold time. Waiters re-request after it elapses
 *     (they don't lose their place in a harmful way — they rejoin the
 *     queue).
 *   - The coordinator recycles after RECYCLE_AFTER_GRANTS once idle so its
 *     event log stays bounded.
 *
 * DOCS: https://workflow-sdk.dev/patterns/semaphore
 */
import { createHook, defineHook, sleep } from 'workflow';
import { resumeHook, start } from 'workflow/api';

type SemaphoreEvent =
  | { type: 'acquire'; grantToken: string }
  | { type: 'release' };

// Single event channel per semaphore key. One consumer (the coordinator)
// reads it in a loop, so messages are processed in order and never lost to
// racing consumers.
export const semaphoreEvents = defineHook<SemaphoreEvent>();

function semaphoreToken(key: string) {
  return `semaphore:${key}`;
}

// How long one acquire attempt may take — the request to the coordinator
// plus the wait for a grant — before re-requesting. Must exceed the longest
// time a permit is typically held; see the pattern docs.
const ACQUIRE_RETRY_TIMEOUT = '60s';
const MAX_ACQUIRE_ATTEMPTS = 10;
// Recycle the coordinator run after this many grants (once idle) so its
// event log stays bounded. Senders transparently restart it.
const RECYCLE_AFTER_GRANTS = 500;
// How hard a sender tries to reach the coordinator. The delays double from
// 250ms up to MAX_SEND_BACKOFF_MS, so these give a cold coordinator ~30s to
// boot and claim its token before the sender gives up.
const SEND_ATTEMPTS = 10;
const MAX_SEND_BACKOFF_MS = 4000;

// COORDINATOR — owns the permit count for one semaphore key. Started
// lazily by sendSemaphoreEvent(); exits when idle after enough traffic.
export async function semaphoreCoordinator(key: string, maxConcurrent: number) {
  'use workflow';

  const events = semaphoreEvents.create({ token: semaphoreToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  let inFlight = 0;
  let grants = 0;
  const waiting: string[] = [];

  for (;;) {
    const ev = await events;

    if (ev.type === 'acquire') {
      waiting.push(ev.grantToken);
    } else {
      inFlight = Math.max(0, inFlight - 1);
    }

    // Grant as many queued waiters as capacity allows, FIFO.
    while (inFlight < maxConcurrent && waiting.length > 0) {
      const grantToken = waiting.shift() as string;
      const granted = await grantPermit(grantToken);
      // A failed grant means the waiter timed out and disposed its hook —
      // skip it without consuming capacity.
      if (granted) {
        inFlight++;
        grants++;
      }
    }

    // Recycle only when nothing is held or queued — a fresh run starts
    // from zero state, which is only correct at quiescence.
    if (
      grants >= RECYCLE_AFTER_GRANTS &&
      inFlight === 0 &&
      waiting.length === 0
    ) {
      return { grants };
    }
  }
}

async function grantPermit(grantToken: string): Promise<boolean> {
  'use step';
  try {
    await resumeHook(grantToken, { granted: true });
    return true;
  } catch {
    return false;
  }
}

// Deliver an event to the coordinator, starting it if it isn't running.
// The double-start race is harmless: the loser run detects the conflict
// via getConflict() and returns { dedupedTo } without doing any work.
//
// Two details matter when many senders hit a cold key at once:
//   - Start the coordinator AT MOST ONCE per send. start() resolves as soon
//     as the run is enqueued, but the token isn't claimed until that run
//     actually executes its first instruction. Starting again on every
//     failed resume just because the claim hasn't landed yet turns N
//     concurrent senders into N x attempts throwaway runs.
//   - Back off exponentially. A cold start is a whole workflow run booting;
//     on a busy queue that can take seconds, not milliseconds.
async function sendSemaphoreEvent(
  key: string,
  maxConcurrent: number,
  event: SemaphoreEvent
): Promise<void> {
  'use step';
  let startedOne = false;
  let backoffMs = 250;
  for (let i = 0; i < SEND_ATTEMPTS; i++) {
    try {
      await semaphoreEvents.resume(semaphoreToken(key), event);
      return;
    } catch {
      // No coordinator owns the token yet — it isn't running, was just
      // recycled, or is still booting.
    }
    if (!startedOne) {
      startedOne = true;
      try {
        await start(semaphoreCoordinator, [key, maxConcurrent]);
      } catch {
        // Another sender raced us to start it. Fine — retry the resume.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_SEND_BACKOFF_MS);
  }
  throw new Error(`Could not reach semaphore coordinator for "${key}"`);
}

/**
 * Run `fn` while holding one of `maxConcurrent` permits for `key`,
 * across ALL workflow runs and machines. Call from a workflow function.
 *
 * Self-healing: if the grant doesn't arrive within ACQUIRE_RETRY_TIMEOUT
 * (e.g. the coordinator recycled mid-request), the waiter disposes its
 * reply hook and re-requests with a fresh one.
 */
export async function withPermit<T>(
  key: string,
  maxConcurrent: number,
  fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const grant = createHook<{ granted: true }>();
    // Start the retry timer BEFORE the request step, not after. Durable
    // correlation IDs are handed out in call order, so a sleep() created
    // after an await inherits step-completion order — which isn't stable
    // across replays when several holders run concurrently. Allocating it
    // up-front, next to the hook, keeps the order deterministic. The
    // timeout budget then covers the request too, which is what you want
    // anyway: it bounds the whole acquire, not just the grant wait.
    const retryTimer = sleep(ACQUIRE_RETRY_TIMEOUT);

    await sendSemaphoreEvent(key, maxConcurrent, {
      type: 'acquire',
      grantToken: grant.token,
    });

    const granted = await Promise.race([
      grant.then(() => true as const),
      retryTimer.then(() => false as const),
    ]);

    if (!granted) {
      // Stop the coordinator from granting our stale token later — a
      // disposed hook makes that grant fail, so capacity isn't leaked.
      grant.dispose();
      continue;
    }

    try {
      return await fn();
    } finally {
      await sendSemaphoreEvent(key, maxConcurrent, { type: 'release' });
    }
  }
  throw new Error(`Failed to acquire semaphore "${key}"`);
}

/** Mutex — a semaphore with a single permit. */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  return withPermit(key, 1, fn);
}
