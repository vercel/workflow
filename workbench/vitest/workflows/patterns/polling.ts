/**
 * Polling — wait for an external condition with backoff and a deadline.
 *
 * THE PATTERN:
 *   1. A check step probes the external system. { done: false } schedules
 *      another poll; { done: true } resolves the wait; a throw is retried
 *      as a normal step failure.
 *   2. sleep() between polls is durable — a day-long wait costs nothing
 *      and survives restarts, deploys, and crashes.
 *   3. Exponential backoff (INITIAL → MAX) keeps fast things fast and slow
 *      things cheap. The DEADLINE bounds the total wait.
 *
 * USEFUL WHEN:
 *   - Waiting for a deployment, export, or batch job to finish.
 *   - Waiting for a human-speed process (KYC review, domain verification).
 *   - The system you're waiting on has no webhook (if it does, prefer the
 *     Webhooks pattern and skip polling entirely).
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace checkCondition's body with your real probe and result shape.
 *   - Tune the interval constants to the expected time-to-ready.
 *   - Want to act on timeout instead of failing? Catch PollTimeoutError in
 *     the caller, or return a { timedOut: true } result instead of throwing.
 *   - Combine with the Timeouts pattern to race the poll against other
 *     signals (e.g. a cancellation hook).
 *
 * DOCS: https://workflow-sdk.dev/patterns/polling
 */
import { sleep } from 'workflow';

// Tune these to the system you're polling.
const INITIAL_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_FACTOR = 2;
// Give up after this long overall.
const DEADLINE_MS = 24 * 60 * 60 * 1000;

export class PollTimeoutError extends Error {
  constructor(target: string) {
    super(`Timed out waiting for "${target}"`);
    this.name = 'PollTimeoutError';
  }
}

// WORKFLOW — poll until checkCondition() reports done, with exponential
// backoff between attempts. Each sleep is durable: zero compute while
// waiting, survives restarts and deploys.
export async function waitForCondition(target: string) {
  'use workflow';

  const startedAt = Date.now();
  let interval = INITIAL_INTERVAL_MS;

  for (;;) {
    const result = await checkCondition(target);
    if (result.done) {
      return { target, waitedMs: Date.now() - startedAt, value: result.value };
    }

    if (Date.now() - startedAt + interval > DEADLINE_MS) {
      throw new PollTimeoutError(target);
    }

    await sleep(`${interval}ms`);
    interval = Math.min(interval * BACKOFF_FACTOR, MAX_INTERVAL_MS);
  }
}

// DEMO state — the demo condition becomes ready on the 3rd check, so the
// pattern runs (and finishes) out of the box.
const demoChecks = new Map<string, number>();

// THE CHECK — replace this step body with your real probe: a deployment's
// status endpoint, a KYC verdict, an export job, a DNS record, etc.
// Throwing here is retried as a normal step failure; returning
// { done: false } schedules the next poll.
async function checkCondition(
  target: string
): Promise<{ done: boolean; value?: unknown }> {
  'use step';

  // A real probe looks like:
  //   const res = await fetch(`https://api.your-service.com/status/${target}`);
  //   if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  //   const body = (await res.json()) as { state: string };
  //   return body.state === "ready" ? { done: true, value: body } : { done: false };

  const checks = (demoChecks.get(target) ?? 0) + 1;
  demoChecks.set(target, checks);
  return checks >= 3
    ? { done: true, value: { state: 'ready', checks } }
    : { done: false };
}
