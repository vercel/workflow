/**
 * Source snippets for the Semaphore registry entry.
 *
 * Distributed semaphore: at most N concurrent executions of a critical
 * section across all workflow runs and machines. A coordination workflow
 * holds the permit state and grants waiters in FIFO order via hooks.
 * `withPermit(key, max, fn)` is the consumer API; `withLock(key, fn)` is
 * the mutex special case (max = 1).
 */

const SEMAPHORE_BODY = `import { createHook, defineHook, sleep } from "workflow";
import { resumeHook, start } from "workflow/api";

type SemaphoreEvent =
  | { type: "acquire"; grantToken: string }
  | { type: "release" };

// Single event channel per semaphore key. One consumer (the coordinator)
// reads it in a loop, so messages are processed in order and never lost to
// racing consumers.
export const semaphoreEvents = defineHook<SemaphoreEvent>();

function semaphoreToken(key: string) {
  return \`semaphore:\${key}\`;
}

// How long a waiter waits for a grant before re-requesting. Must exceed
// the longest time a permit is typically held — see the pattern docs.
const ACQUIRE_RETRY_TIMEOUT = "60s";
const MAX_ACQUIRE_ATTEMPTS = 10;
// Recycle the coordinator run after this many grants (once idle) so its
// event log stays bounded. Senders transparently restart it.
const RECYCLE_AFTER_GRANTS = 500;

// COORDINATOR — owns the permit count for one semaphore key. Started
// lazily by sendSemaphoreEvent(); exits when idle after enough traffic.
export async function semaphoreCoordinator(
  key: string,
  maxConcurrent: number,
) {
  "use workflow";

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

    if (ev.type === "acquire") {
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
  "use step";
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
async function sendSemaphoreEvent(
  key: string,
  maxConcurrent: number,
  event: SemaphoreEvent,
): Promise<void> {
  "use step";
  for (let i = 0; i < 3; i++) {
    try {
      await semaphoreEvents.resume(semaphoreToken(key), event);
      return;
    } catch {
      // Coordinator not running (or just recycled) — start it and retry.
    }
    try {
      await start(semaphoreCoordinator, [key, maxConcurrent]);
    } catch {
      // Another sender raced us to start it. Fine — retry the resume.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(\`Could not reach semaphore coordinator for "\${key}"\`);
}

/**
 * Run \`fn\` while holding one of \`maxConcurrent\` permits for \`key\`,
 * across ALL workflow runs and machines. Call from a workflow function.
 *
 * Self-healing: if the grant doesn't arrive within ACQUIRE_RETRY_TIMEOUT
 * (e.g. the coordinator recycled mid-request), the waiter disposes its
 * reply hook and re-requests with a fresh one.
 */
export async function withPermit<T>(
  key: string,
  maxConcurrent: number,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const grant = createHook<{ granted: true }>();
    await sendSemaphoreEvent(key, maxConcurrent, {
      type: "acquire",
      grantToken: grant.token,
    });

    const granted = await Promise.race([
      grant.then(() => true as const),
      sleep(ACQUIRE_RETRY_TIMEOUT).then(() => false as const),
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
      await sendSemaphoreEvent(key, maxConcurrent, { type: "release" });
    }
  }
  throw new Error(\`Failed to acquire semaphore "\${key}"\`);
}

/** Mutex — a semaphore with a single permit. */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withPermit(key, 1, fn);
}
`;

export const semaphoreWorkflowSource = SEMAPHORE_BODY;

export const semaphoreWorkflowInstallSource = `/**
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
 *   - ACQUIRE_RETRY_TIMEOUT should exceed your longest typical hold time;
 *     waiters re-request after it elapses (they don't lose their place in
 *     a harmful way — they rejoin the queue).
 *   - The coordinator recycles after RECYCLE_AFTER_GRANTS once idle so its
 *     event log stays bounded.
 *
 * DOCS: https://workflow-sdk.dev/patterns/semaphore
 */
${SEMAPHORE_BODY}`;

export const semaphoreUsageSource = `import { withLock, withPermit } from "@/app/workflows/semaphore-workflow";

// Inside any workflow function:
export async function syncAllAccounts(accountIds: string[]) {
  "use workflow";

  // At most 3 concurrent CRM syncs across EVERY run of EVERY workflow.
  const results = await Promise.all(
    accountIds.map((id) =>
      withPermit("crm-sync", 3, () => syncAccount(id)),
    ),
  );

  return { synced: results.length };
}

export async function migrateTenant(tenantId: string) {
  "use workflow";

  // Mutex: only one migration may touch a tenant at a time, cluster-wide.
  return withLock(\`tenant-migration:\${tenantId}\`, () =>
    runMigration(tenantId),
  );
}

async function syncAccount(id: string) {
  "use step";
  // ... call the rate-limited third-party API
  return id;
}

async function runMigration(tenantId: string) {
  "use step";
  // ... the migration body
  return { tenantId, done: true };
}
`;
