/**
 * Source snippets for the Circuit Breaker registry entry.
 *
 * Distributed circuit breaker: stop hammering a failing dependency,
 * cluster-wide. A coordination workflow holds the breaker state machine
 * (closed → open → half-open) and answers "may I proceed?" checks from any
 * workflow run. The cooldown is injected as a timer message, so the
 * coordinator always answers checks instantly — even while open.
 */

const CIRCUIT_BREAKER_BODY = `import { createHook, defineHook, sleep } from "workflow";
import { resumeHook, start } from "workflow/api";

type BreakerEvent =
  | { type: "check"; replyToken: string }
  | { type: "report"; ok: boolean }
  | { type: "timer"; timerId: number };

type BreakerState = "closed" | "open" | "half-open";

export const breakerEvents = defineHook<BreakerEvent>();

function breakerToken(key: string) {
  return \`circuit-breaker:\${key}\`;
}

// Open the circuit after this many consecutive failures.
const FAILURE_THRESHOLD = 5;
// How long the circuit stays open before allowing a half-open probe.
const COOLDOWN_MS = 30_000;
// If the coordinator can't be reached, fail OPEN (allow the call) — the
// breaker is an optimization, not a correctness gate. Flip if you prefer.
const CHECK_TIMEOUT = "10s";
// Recycle the coordinator after this many events once the circuit is
// closed and quiet. Note: a recycle resets the failure count.
const RECYCLE_AFTER_EVENTS = 2000;

// COORDINATOR — the breaker state machine for one key. The main loop only
// ever awaits the event channel, so checks are answered instantly in every
// state; the open-state cooldown arrives as a timer message from a child
// workflow instead of blocking the loop.
export async function breakerCoordinator(key: string) {
  "use workflow";

  const events = breakerEvents.create({ token: breakerToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  let state: BreakerState = "closed";
  let consecutiveFailures = 0;
  let probeOutstanding = false;
  let timerSeq = 0;
  let eventCount = 0;

  for (;;) {
    const ev = await events;
    eventCount++;

    if (ev.type === "check") {
      let allowed: boolean;
      if (state === "closed") {
        allowed = true;
      } else if (state === "open") {
        allowed = false;
      } else {
        // half-open: let exactly one probe through at a time.
        allowed = !probeOutstanding;
        if (allowed) probeOutstanding = true;
      }
      await replyToCheck(ev.replyToken, allowed, state);
    } else if (ev.type === "report") {
      if (ev.ok) {
        consecutiveFailures = 0;
        if (state === "half-open") {
          state = "closed";
          probeOutstanding = false;
        }
      } else {
        consecutiveFailures++;
        if (state === "half-open") {
          // Probe failed — back to open, restart the cooldown.
          state = "open";
          probeOutstanding = false;
          timerSeq++;
          await spawnCooldownTimer(key, COOLDOWN_MS, timerSeq);
        } else if (state === "closed" && consecutiveFailures >= FAILURE_THRESHOLD) {
          state = "open";
          timerSeq++;
          await spawnCooldownTimer(key, COOLDOWN_MS, timerSeq);
        }
      }
    } else if (ev.timerId === timerSeq && state === "open") {
      // Current cooldown elapsed — allow a single probe.
      state = "half-open";
      probeOutstanding = false;
    }
    // Stale timer messages (timerId !== timerSeq) are ignored.

    if (
      eventCount >= RECYCLE_AFTER_EVENTS &&
      state === "closed" &&
      !probeOutstanding
    ) {
      return { events: eventCount };
    }
  }
}

// Cooldown as a message: a tiny child run sleeps, then pings the channel.
export async function breakerCooldownTimer(
  key: string,
  cooldownMs: number,
  timerId: number,
) {
  "use workflow";
  await sleep(\`\${cooldownMs}ms\`);
  await sendBreakerEvent(key, { type: "timer", timerId });
}

async function spawnCooldownTimer(
  key: string,
  cooldownMs: number,
  timerId: number,
): Promise<void> {
  "use step";
  await start(breakerCooldownTimer, [key, cooldownMs, timerId]);
}

async function replyToCheck(
  replyToken: string,
  allowed: boolean,
  state: BreakerState,
): Promise<void> {
  "use step";
  try {
    await resumeHook(replyToken, { allowed, state });
  } catch {
    // Caller timed out and moved on — nothing to do.
  }
}

async function sendBreakerEvent(
  key: string,
  event: BreakerEvent,
): Promise<void> {
  "use step";
  for (let i = 0; i < 3; i++) {
    try {
      await breakerEvents.resume(breakerToken(key), event);
      return;
    } catch {
      // Coordinator not running (or just recycled) — start it and retry.
    }
    try {
      await start(breakerCoordinator, [key]);
    } catch {
      // Another sender raced us to start it — retry the resume.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Don't throw — breaker bookkeeping must never break the caller.
}

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(\`Circuit breaker "\${key}" is open\`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Run \`fn\` behind the \`key\` circuit breaker. Throws CircuitOpenError
 * without calling \`fn\` while the circuit is open. Call from a workflow
 * function. Successes and failures are reported back to the breaker.
 */
export async function withBreaker<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const reply = createHook<{ allowed: boolean; state: BreakerState }>();
  await sendBreakerEvent(key, { type: "check", replyToken: reply.token });

  const verdict = await Promise.race([
    reply.then((v) => ({ ...v, timedOut: false })),
    // Fail open if the coordinator is unreachable — see CHECK_TIMEOUT note.
    sleep(CHECK_TIMEOUT).then(() => ({
      allowed: true,
      state: "closed" as const,
      timedOut: true,
    })),
  ]);

  if (verdict.timedOut) {
    // Make the stale reply token un-resumable so a late coordinator answer
    // can't mark a half-open probe as outstanding forever.
    reply.dispose();
  }

  if (!verdict.allowed) {
    throw new CircuitOpenError(key);
  }

  try {
    const result = await fn();
    await sendBreakerEvent(key, { type: "report", ok: true });
    return result;
  } catch (error) {
    await sendBreakerEvent(key, { type: "report", ok: false });
    throw error;
  }
}
`;

export const circuitBreakerWorkflowSource = CIRCUIT_BREAKER_BODY;

export const circuitBreakerWorkflowInstallSource = `/**
 * Circuit Breaker — stop hammering a failing dependency, cluster-wide.
 *
 * THE PATTERN:
 *   1. A coordination workflow per breaker key holds the classic state
 *      machine: closed (calls flow, count consecutive failures) → open
 *      (calls rejected instantly) → half-open (one probe at a time).
 *   2. The coordinator's loop only ever awaits its event channel, so
 *      "may I proceed?" checks are answered instantly in every state. The
 *      open-state cooldown arrives as a message from a tiny timer child
 *      workflow — stale timers carry an old ID and are ignored.
 *   3. withBreaker(key, fn) checks, runs, and reports in one call.
 *      It throws CircuitOpenError instead of calling fn while open.
 *
 * USEFUL WHEN:
 *   - A flaky downstream service should get breathing room instead of a
 *     retry storm from hundreds of concurrent runs.
 *   - You want failures in one workflow's calls to protect every other
 *     workflow calling the same dependency.
 *
 * CAVEATS / TO ADAPT:
 *   - withBreaker() must be called from a workflow function.
 *   - If the coordinator is unreachable the breaker FAILS OPEN (the call
 *     proceeds). Flip the CHECK_TIMEOUT fallback if you prefer fail-closed.
 *   - Tune FAILURE_THRESHOLD and COOLDOWN_MS; the threshold counts
 *     consecutive failures, not a rolling window.
 *   - Recycling resets the failure count (it only happens while closed
 *     and quiet, so the impact is bounded).
 *   - Catch CircuitOpenError in the caller and decide: skip, queue for
 *     later, or rethrow as a RetryableError with a retryAfter.
 *
 * DOCS: https://workflow-sdk.dev/patterns/circuit-breaker
 */
${CIRCUIT_BREAKER_BODY}`;

export const circuitBreakerUsageSource = `import { RetryableError } from "workflow";
import {
  CircuitOpenError,
  withBreaker,
} from "@/app/workflows/circuit-breaker-workflow";

export async function notifyUser(userId: string, message: string) {
  "use workflow";

  try {
    // Every run shares the same breaker — five consecutive failures
    // anywhere open the circuit for everyone.
    return await withBreaker("notifications-api", () =>
      sendNotification(userId, message),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      // Let the runtime reschedule this step after the cooldown instead
      // of counting it as a real failure.
      throw new RetryableError("Notifications API circuit open", {
        retryAfter: "1m",
      });
    }
    throw error;
  }
}

async function sendNotification(userId: string, message: string) {
  "use step";
  const res = await fetch("https://api.notifications.example.com/send", {
    method: "POST",
    body: JSON.stringify({ userId, message }),
  });
  if (!res.ok) throw new Error(\`Notify failed: \${res.status}\`);
  return res.json();
}
`;
