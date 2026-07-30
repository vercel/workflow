/**
 * Timeouts — bound how long a step, hook, or webhook can take.
 *
 * THE PATTERN:
 *   Promise.race() against sleep() creates a durable deadline:
 *   - HARD TIMEOUT: throw if work doesn't finish — use for SLA enforcement.
 *   - SOFT TIMEOUT: fall back to a cached/default value — use when partial
 *     results are acceptable.
 *   - WEBHOOK + DEADLINE: race an external callback against a long sleep()
 *     so the workflow never waits forever for an event that never arrives.
 *
 *   The Symbol sentinel is TypeScript-safe: it narrows the union without
 *   a discriminant string, and can't accidentally collide with real return
 *   values the way null or "" could.
 *
 * USEFUL WHEN:
 *   - A slow external API should fail fast after N seconds.
 *   - You need "return cached data if fresh data takes too long".
 *   - A webhook approval / payment callback should expire after N days.
 *   - Any "wait for X but not forever" pattern.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Keep only the flavors you need (hard / soft / webhook + deadline).
 *   - Replace processData / fetchSlow / sendApprovalRequest with your steps.
 *   - Tune the sleep duration to match your SLA or UX requirements.
 *   - NOTE: the LOSER of Promise.race keeps running — the workflow ignores
 *     its result but side effects still happen. Use the Kill Switch pattern
 *     if you need hard cross-process cancellation.
 *
 * DOCS: https://workflow-sdk.dev/patterns/timeouts
 */
import { createWebhook, sleep } from 'workflow';

// Unique sentinel — can't collide with real return values.
const TIMEOUT = Symbol('timeout');

// HARD TIMEOUT — throw if the work doesn't finish in time.
export async function processWithTimeout(data: string) {
  'use workflow';

  const result = await Promise.race([
    processData(data),
    sleep('30s').then(() => TIMEOUT as typeof TIMEOUT),
  ]);

  if (result === TIMEOUT) {
    throw new Error('Processing timed out after 30 seconds');
  }

  return result;
}

// SOFT TIMEOUT — fall back to a cached value if the deadline fires first.
export async function fetchWithFallback(key: string, fallback: string) {
  'use workflow';

  const result = await Promise.race([
    fetchSlow(key),
    sleep('3s').then(() => TIMEOUT as typeof TIMEOUT),
  ]);

  return result === TIMEOUT ? fallback : result;
}

// WEBHOOK + DEADLINE — race an external callback against a 7-day sleep so
// the workflow never hangs forever on a missing event.
export async function waitForApproval(requestId: string) {
  'use workflow';

  const webhook = createWebhook();
  await sendApprovalRequest(requestId, webhook.url);

  const result = await Promise.race([
    webhook.then((req) => req.json() as Promise<{ approved: boolean }>),
    sleep('7 days').then(() => ({ timedOut: true }) as const),
  ]);

  if ('timedOut' in result) {
    throw new Error('Approval request expired after 7 days');
  }

  return result.approved;
}

async function processData(data: string): Promise<string> {
  'use step';
  // Replace with real work. The LOSER of Promise.race keeps running —
  // the workflow ignores its result, but side effects still happen.
  // Use the Kill Switch pattern for hard cross-process cancellation.
  // DEMO: inputs starting with "slow:" take 5 wall-clock seconds so you can
  // watch the timeout win the race.
  if (data.startsWith('slow:')) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return data.toUpperCase();
}

async function fetchSlow(key: string): Promise<string> {
  'use step';
  // Real: const res = await fetch(`https://api.your-service.com/slow/${key}`);
  //       return res.text();
  // DEMO: keys starting with "slow:" take 5 wall-clock seconds so the
  // fallback path is observable.
  if (key.startsWith('slow:')) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return `fresh_${key}`;
}

// DEMO OUTBOX — records the approval request instead of calling a real
// service. (Exported so you can inspect it from a console or test.)
export const demoApprovalOutbox: Array<{
  requestId: string;
  webhookUrl: string;
}> = [];

async function sendApprovalRequest(
  requestId: string,
  webhookUrl: string
): Promise<void> {
  'use step';
  // Real: POST { requestId, webhookUrl } to your approvals service / email
  // the webhookUrl to the approver.
  demoApprovalOutbox.push({ requestId, webhookUrl });
}
