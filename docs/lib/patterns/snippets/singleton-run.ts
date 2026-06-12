/**
 * Source snippets for the Singleton Run registry entry.
 *
 * At most one live run per key: `getOrStart()` checks for an existing run
 * by probing a deterministic "liveness" hook token, and only starts a new
 * run when none is alive. The same hook doubles as a mailbox — any process
 * can send messages to the singleton with `sendToSingleton()`.
 */

const SINGLETON_RUN_BODY = `import { defineHook } from "workflow";
import { getHookByToken, start } from "workflow/api";

// Liveness marker + mailbox for each singleton. Creating it (with the
// deterministic token below) is what makes a run discoverable by key.
export const singletonMailbox = defineHook<unknown>();

export function singletonToken(key: string) {
  return \`singleton:\${key}\`;
}

/**
 * Find the live run for \`key\`, or start one via \`startRun\` if none
 * exists. Callable anywhere server-side.
 *
 * The workflow you start MUST create the mailbox as its first act:
 *
 *   const mailbox = singletonMailbox.create({ token: singletonToken(key) });
 *
 * That registration is also the mutual exclusion: if two getOrStart calls
 * race and both start a run, the second run's create() hits
 * HookConflictError and that run exits — only one survives.
 */
export async function getOrStart(
  key: string,
  startRun: () => Promise<{ runId: string }>,
): Promise<{ runId: string; started: boolean }> {
  const existing = await getHookByToken(singletonToken(key)).catch(() => null);
  if (existing) {
    return { runId: existing.runId, started: false };
  }
  const run = await startRun();
  return { runId: run.runId, started: true };
}

/** Send a message to the live singleton for \`key\` (throws if none). */
export async function sendToSingleton(
  key: string,
  message: unknown,
): Promise<void> {
  await singletonMailbox.resume(singletonToken(key), message);
}

// ── Example singleton ──────────────────────────────────────────────────
// One live session per user. The mailbox drives the run: each message is
// processed in arrival order; a "stop" message ends the run.

type SessionMessage =
  | { type: "task"; payload: string }
  | { type: "stop" };

export async function userSession(userId: string) {
  "use workflow";

  // First act: claim the singleton slot. A concurrent duplicate run dies
  // here with HookConflictError before doing any work.
  const mailbox = singletonMailbox.create({
    token: singletonToken(\`user-session:\${userId}\`),
  });

  let processed = 0;
  for (;;) {
    const message = (await mailbox) as SessionMessage;
    if (message.type === "stop") break;
    await handleTask(userId, message.payload);
    processed++;
  }

  return { userId, processed };
}

async function handleTask(userId: string, payload: string): Promise<void> {
  "use step";
  await fetch(\`https://api.example.com/users/\${userId}/tasks\`, {
    method: "POST",
    body: JSON.stringify({ payload }),
  });
}
`;

export const singletonRunWorkflowSource = SINGLETON_RUN_BODY;

export const singletonRunWorkflowInstallSource = `/**
 * Singleton Run — at most one live workflow run per key.
 *
 * THE PATTERN:
 *   1. The singleton workflow's first act is creating a hook with a
 *      deterministic token derived from its key. That hook is both a
 *      liveness marker and a mailbox.
 *   2. getOrStart(key, startRun) probes the token with getHookByToken():
 *      hit → return the existing run; miss → start a fresh one.
 *   3. The hook token is also the mutex: if two callers race and both
 *      start a run, the duplicate dies on HookConflictError when it tries
 *      to create the same token — exactly one run survives.
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
 *   - The losing run of a start race exits with HookConflictError — that
 *     error in the run list is expected noise, not a failure to fix.
 *   - A caller that got the loser's runId can re-probe getOrStart() to
 *     find the winner.
 *   - End the run somehow (a stop message, an idle timeout via the
 *     Debounce timer trick, or a max-messages recycle) — see Upgrading
 *     Workflows for long-lived loop hygiene.
 *
 * DOCS: https://workflow-sdk.dev/patterns/singleton-run
 */
${SINGLETON_RUN_BODY}`;

export const singletonRunUsageSource = `import { start } from "workflow/api";
import {
  getOrStart,
  sendToSingleton,
  userSession,
} from "@/app/workflows/singleton-run-workflow";

// POST /api/sessions/[userId]/tasks — feed work to the user's single
// live session, starting it on first use.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const { task } = await request.json();
  const key = \`user-session:\${userId}\`;

  const { runId, started } = await getOrStart(key, () =>
    start(userSession, [userId]),
  );

  await sendToSingleton(key, { type: "task", payload: task });

  return Response.json({ runId, started });
}
`;
