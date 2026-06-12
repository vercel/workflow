/**
 * Singleton Run — at most one live workflow run per key.
 *
 * THE PATTERN:
 *   1. The singleton workflow's first act is creating a hook with a
 *      deterministic token derived from its key. That hook is both a
 *      liveness marker and a mailbox.
 *   2. getOrStart(key, startRun) probes the token with getHookByToken():
 *      hit → return the existing run; miss → start a fresh one.
 *   3. The hook token is also the mutex: if two callers race and both
 *      start a run, the duplicate detects the conflict via getConflict()
 *      and returns { dedupedTo: winnerRunId } — exactly one run survives.
 *   4. sendToSingleton(key, message) lets any process feed the run.
 *
 * USEFUL WHEN:
 *   - "One live session/sync/consumer per user|tenant|resource" — dedupe
 *     workflow starts by key instead of bookkeeping in your database.
 *   - Resume-or-start: reconnect to in-flight work idempotently.
 *   - An actor-style mailbox loop fed from API routes or webhooks.
 *
 * CAVEATS / TO ADAPT:
 *   - Replace userSession / handleTask with your singleton's real work.
 *   - The losing run of a start race returns { dedupedTo } cleanly. A
 *     caller that got the loser's runId can read that return value or
 *     re-probe getOrStart() to find the winner.
 *   - End the run somehow (a stop message, an idle timeout via the
 *     Debounce timer trick, or a max-messages recycle) — see Upgrading
 *     Workflows for long-lived loop hygiene.
 *
 * DOCS: https://workflow-sdk.dev/patterns/singleton-run
 */
import { defineHook } from 'workflow';
import { getHookByToken } from 'workflow/api';

// Liveness marker + mailbox for each singleton. Creating it (with the
// deterministic token below) is what makes a run discoverable by key.
export const singletonMailbox = defineHook<unknown>();

export function singletonToken(key: string) {
  return `singleton:${key}`;
}

/**
 * Find the live run for `key`, or start one via `startRun` if none
 * exists. Callable anywhere server-side.
 *
 * The workflow you start MUST create the mailbox as its first act:
 *
 *   const mailbox = singletonMailbox.create({ token: singletonToken(key) });
 *
 * That registration is also the mutual exclusion: if two getOrStart calls
 * race and both start a run, the duplicate detects the conflict via
 * `mailbox.getConflict()` and returns `{ dedupedTo }` cleanly — only
 * one run survives, and the loser's return value points at the winner.
 */
export async function getOrStart(
  key: string,
  startRun: () => Promise<{ runId: string }>
): Promise<{ runId: string; started: boolean }> {
  const existing = await getHookByToken(singletonToken(key)).catch(() => null);
  if (existing) {
    return { runId: existing.runId, started: false };
  }
  const run = await startRun();
  return { runId: run.runId, started: true };
}

/** Send a message to the live singleton for `key` (throws if none). */
export async function sendToSingleton(
  key: string,
  message: unknown
): Promise<void> {
  await singletonMailbox.resume(singletonToken(key), message);
}

// ── Example singleton ──────────────────────────────────────────────────
// One live session per user. The mailbox drives the run: each message is
// processed in arrival order; a "stop" message ends the run.

type SessionMessage = { type: 'task'; payload: string } | { type: 'stop' };

export async function userSession(userId: string) {
  'use workflow';

  // First act: claim the singleton slot. If another run already owns the
  // token (a lost start race), exit cleanly pointing at the winner.
  const mailbox = singletonMailbox.create({
    token: singletonToken(`user-session:${userId}`),
  });
  const conflict = await mailbox.getConflict();
  if (conflict) {
    return { userId, dedupedTo: conflict.runId };
  }

  let processed = 0;
  for (;;) {
    const message = (await mailbox) as SessionMessage;
    if (message.type === 'stop') break;
    await handleTask(userId, message.payload);
    processed++;
  }

  return { userId, processed };
}

// Demo task handler — replace this step body with your real work, e.g.:
//
//   await fetch(`https://api.your-domain.com/users/${userId}/tasks`, {
//     method: "POST",
//     body: JSON.stringify({ payload }),
//   });
async function handleTask(userId: string, payload: string): Promise<void> {
  'use step';
  console.log(`[singleton-run] user ${userId}: handled task "${payload}"`);
}
