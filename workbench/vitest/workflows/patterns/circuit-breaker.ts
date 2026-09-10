/**
 * Circuit Breaker — stop hammering a failing dependency, cluster-wide.
 *
 * THE PATTERN:
 *   1. A coordination workflow per breaker key holds the classic state
 *      machine: closed (calls flow, count consecutive failures) → open
 *      (calls rejected instantly) → half-open (one probe at a time).
 *   2. The coordinator's loop only ever awaits its event channel, so
 *      "may I proceed?" checks are answered instantly in every state.
 *      Deadlines (the open-state cooldown, and the half-open probe's own
 *      reporting deadline) arrive as messages from tiny timer child
 *      workflows — stale timers carry an old ID and are ignored.
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
 *   - Set PROBE_TIMEOUT_MS above your slowest call through the breaker.
 *   - Recycling resets the failure count, and any check in flight when the
 *     coordinator exits gets no answer — it fails open after CHECK_TIMEOUT.
 *     Recycling only happens while closed, where the verdict would have
 *     been "allowed" anyway, so the cost is a slow check, not a wrong one.
 *   - Catch CircuitOpenError in the caller and decide: skip, queue for
 *     later, or rethrow as a RetryableError with a retryAfter.
 *
 * DOCS: https://workflow-sdk.dev/patterns/circuit-breaker
 */
import { createHook, defineHook, sleep } from 'workflow';
import { resumeHook, start } from 'workflow/api';

type BreakerEvent =
  | { type: 'check'; replyToken: string }
  | { type: 'report'; ok: boolean }
  | { type: 'timer'; timerId: number };

type BreakerState = 'closed' | 'open' | 'half-open';

export const breakerEvents = defineHook<BreakerEvent>();

function breakerToken(key: string) {
  return `circuit-breaker:${key}`;
}

// Open the circuit after this many consecutive failures.
const FAILURE_THRESHOLD = 5;
// How long the circuit stays open before allowing a half-open probe.
const COOLDOWN_MS = 30_000;
// How long a half-open probe has to report back before the coordinator
// gives up on it and reopens the circuit. Reports are best-effort (see
// sendBreakerEvent), and a probe whose report is lost — or whose run dies
// mid-call — would otherwise hold the single half-open slot forever, so
// every later check is rejected and no cooldown is pending to rescue it.
// Set this ABOVE your slowest call through the breaker: too low and a
// healthy-but-slow probe is written off, costing another cooldown before
// the next attempt. Too low degrades recovery speed; it never wedges.
const PROBE_TIMEOUT_MS = 60_000;
// If the coordinator can't be reached, fail OPEN (allow the call) — the
// breaker is an optimization, not a correctness gate. Flip if you prefer.
const CHECK_TIMEOUT = '10s';
// Recycle the coordinator after this many events once the circuit is
// closed and quiet. Note: a recycle resets the failure count.
const RECYCLE_AFTER_EVENTS = 2000;
// How hard a sender tries to reach the coordinator. The delays double from
// 250ms up to MAX_SEND_BACKOFF_MS, giving a cold coordinator ~6s to boot and
// claim its token. Keep the total under CHECK_TIMEOUT: the send is awaited
// before the verdict race, so a longer budget would stretch the fail-open
// path past the deadline this pattern promises. Breaker bookkeeping must
// never break the caller — or stall it.
const SEND_ATTEMPTS = 5;
const MAX_SEND_BACKOFF_MS = 2000;

// COORDINATOR — the breaker state machine for one key. The main loop only
// ever awaits the event channel, so checks are answered instantly in every
// state; the open-state cooldown arrives as a timer message from a child
// workflow instead of blocking the loop.
export async function breakerCoordinator(key: string) {
  'use workflow';

  const events = breakerEvents.create({ token: breakerToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  let state: BreakerState = 'closed';
  let consecutiveFailures = 0;
  let probeOutstanding = false;
  let timerSeq = 0;
  let eventCount = 0;

  for (;;) {
    const ev = await events;
    eventCount++;

    if (ev.type === 'check') {
      let allowed: boolean;
      if (state === 'closed') {
        allowed = true;
      } else if (state === 'open') {
        allowed = false;
      } else {
        // half-open: let exactly one probe through at a time, and give that
        // probe a deadline. Its report is best-effort, so without a deadline
        // a lost report holds the slot forever — see PROBE_TIMEOUT_MS.
        allowed = !probeOutstanding;
        if (allowed) {
          probeOutstanding = true;
          timerSeq++;
          await spawnBreakerTimer(key, PROBE_TIMEOUT_MS, timerSeq);
        }
      }
      await replyToCheck(ev.replyToken, allowed, state);
    } else if (ev.type === 'report') {
      if (ev.ok) {
        consecutiveFailures = 0;
        if (state === 'half-open') {
          // The probe made it back — close up and retire its deadline.
          state = 'closed';
          probeOutstanding = false;
          timerSeq++;
        }
      } else {
        consecutiveFailures++;
        if (state === 'half-open') {
          // Probe failed — back to open, restart the cooldown.
          state = 'open';
          probeOutstanding = false;
          timerSeq++;
          await spawnBreakerTimer(key, COOLDOWN_MS, timerSeq);
        } else if (
          state === 'closed' &&
          consecutiveFailures >= FAILURE_THRESHOLD
        ) {
          state = 'open';
          timerSeq++;
          await spawnBreakerTimer(key, COOLDOWN_MS, timerSeq);
        }
      }
    } else if (ev.timerId === timerSeq) {
      if (state === 'open') {
        // Cooldown elapsed — allow a single probe.
        state = 'half-open';
        probeOutstanding = false;
      } else if (state === 'half-open' && probeOutstanding) {
        // The probe we admitted never reported — its call may still be
        // running, or its report was dropped. Assume the worst, reopen,
        // and serve another cooldown rather than rejecting forever.
        state = 'open';
        probeOutstanding = false;
        timerSeq++;
        await spawnBreakerTimer(key, COOLDOWN_MS, timerSeq);
      }
    }
    // Stale timer messages (timerId !== timerSeq) are ignored. Every
    // transition that invalidates a pending deadline bumps timerSeq, so at
    // most one timer is ever live.

    if (
      eventCount >= RECYCLE_AFTER_EVENTS &&
      state === 'closed' &&
      !probeOutstanding
    ) {
      return { events: eventCount };
    }
  }
}

// A deadline as a message: a tiny child run sleeps, then pings the channel.
// Used for both the open-state cooldown and the half-open probe deadline —
// what the message means is decided by the state it arrives in.
export async function breakerTimer(
  key: string,
  delayMs: number,
  timerId: number
) {
  'use workflow';
  await sleep(`${delayMs}ms`);
  await sendBreakerEvent(key, { type: 'timer', timerId });
}

async function spawnBreakerTimer(
  key: string,
  delayMs: number,
  timerId: number
): Promise<void> {
  'use step';
  await start(breakerTimer, [key, delayMs, timerId]);
}

async function replyToCheck(
  replyToken: string,
  allowed: boolean,
  state: BreakerState
): Promise<void> {
  'use step';
  try {
    await resumeHook(replyToken, { allowed, state });
  } catch {
    // Caller timed out and moved on — nothing to do.
  }
}

// Two details matter when many callers hit a cold key at once:
//   - Start the coordinator AT MOST ONCE per send. start() resolves as soon
//     as the run is enqueued, but the token isn't claimed until that run
//     actually executes its first instruction. Starting again on every
//     failed resume just because the claim hasn't landed yet turns N
//     concurrent callers into N x attempts throwaway runs.
//   - Back off exponentially. A cold start is a whole workflow run booting;
//     on a busy queue that can take seconds, not milliseconds.
async function sendBreakerEvent(
  key: string,
  event: BreakerEvent
): Promise<void> {
  'use step';
  let startedOne = false;
  let backoffMs = 250;
  for (let i = 0; i < SEND_ATTEMPTS; i++) {
    try {
      await breakerEvents.resume(breakerToken(key), event);
      return;
    } catch {
      // No coordinator owns the token yet — it isn't running, was just
      // recycled, or is still booting.
    }
    if (!startedOne) {
      startedOne = true;
      try {
        await start(breakerCoordinator, [key]);
      } catch {
        // Another sender raced us to start it — retry the resume.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_SEND_BACKOFF_MS);
  }
  // Don't throw — breaker bookkeeping must never break the caller.
}

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit breaker "${key}" is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Run `fn` behind the `key` circuit breaker. Throws CircuitOpenError
 * without calling `fn` while the circuit is open. Call from a workflow
 * function. Successes and failures are reported back to the breaker.
 */
export async function withBreaker<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const reply = createHook<{ allowed: boolean; state: BreakerState }>();
  // Start the timeout BEFORE the check step, not after. Durable correlation
  // IDs are handed out in call order, so a sleep() created after an await
  // inherits step-completion order — which isn't stable across replays when
  // several calls run concurrently in one workflow. Allocating it up-front,
  // next to the hook, keeps the order deterministic. The budget then covers
  // the check step too, which is what you want anyway: it bounds the whole
  // admission decision, not just the wait for the verdict.
  const checkTimeout = sleep(CHECK_TIMEOUT);

  await sendBreakerEvent(key, { type: 'check', replyToken: reply.token });

  const verdict = await Promise.race([
    reply.then((v) => ({ ...v, timedOut: false })),
    // Fail open if the coordinator is unreachable — see CHECK_TIMEOUT note.
    checkTimeout.then(() => ({
      allowed: true,
      state: 'closed' as const,
      timedOut: true,
    })),
  ]);

  if (verdict.timedOut) {
    // Release the reply token: nobody is reading it any more, and a late
    // answer resuming a dead hook would just log a failure on the
    // coordinator's side. This does NOT undo a half-open grant — the
    // coordinator marks the probe outstanding before it replies, so by the
    // time we time out the slot may already be ours. We still run and
    // report below, and PROBE_TIMEOUT_MS covers the case where that report
    // never lands.
    reply.dispose();
  }

  if (!verdict.allowed) {
    throw new CircuitOpenError(key);
  }

  try {
    const result = await fn();
    await sendBreakerEvent(key, { type: 'report', ok: true });
    return result;
  } catch (error) {
    await sendBreakerEvent(key, { type: 'report', ok: false });
    throw error;
  }
}
