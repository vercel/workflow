/**
 * Scheduling — defer any action with a cancellable durable sleep.
 *
 * THE PATTERN:
 *   1. sleep() suspends the workflow until the delay elapses — no cron
 *      jobs, no DB flags, no scheduler infrastructure required.
 *   2. cancellableSleep() races the sleep against a cancel hook. Whichever
 *      resolves first wins: "elapsed" runs the action, "cancelled" skips it.
 *   3. The hook token is keyed by the schedule ID, not the run ID, so the
 *      cancel API only needs the ID you provided at schedule time.
 *
 * REUSABLE COMPONENT:
 *   cancellableSleep(token, delay) is generic — call it from ANY workflow
 *   where you want a delay that something external can cut short (snooze,
 *   user conversion, unsubscribe, manual override).
 *
 * USEFUL WHEN:
 *   - Sending a reminder email N days after signup.
 *   - Triggering a follow-up notification if a user hasn't acted yet.
 *   - Scheduling a deferred webhook call or Slack message.
 *   - Implementing "send later" / snooze / retry-after patterns.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the runAction step body with your real action — send an email
 *     via Resend, post to Slack, fire a webhook, write to your database.
 *   - The delay field accepts a duration string ("2d", "1h", "30m"), millis,
 *     or an absolute Date for scheduling to a specific timestamp.
 *   - Add payload fields to ScheduledAction for everything your action needs.
 *   - For recurring schedules, see the Recurring Cron pattern.
 *
 * DOCS: https://workflow-sdk.dev/patterns/scheduling
 */
import { defineHook, sleep } from 'workflow';

// Exported so the cancel API route can resume it with just the schedule ID.
export const cancelSchedule = defineHook<{ reason?: string }>();

/**
 * REUSABLE COMPONENT — durable sleep raced against a cancel hook.
 * Call from any workflow. Resolves "elapsed" when the delay passes, or
 * "cancelled" when cancelSchedule.resume(token) fires first.
 */
export async function cancellableSleep(
  token: string,
  delay: string | number | Date
): Promise<'elapsed' | 'cancelled'> {
  const hook = cancelSchedule.create({ token });
  const result = await Promise.race([
    sleep(delay as any).then(() => 'elapsed' as const),
    hook.then(() => 'cancelled' as const),
  ]);
  return result;
}

export interface ScheduledAction {
  id: string;
  /** Duration string ("2d", "1h"), millis, or absolute Date. */
  delay: string | number | Date;
  /** Action payload — passed straight to runAction. */
  payload: Record<string, unknown>;
}

// Scheduling workflow — defer runAction until the delay elapses, unless
// cancelled first. One run per scheduled action.
export async function scheduleAction(action: ScheduledAction) {
  'use workflow';

  const outcome = await cancellableSleep(`schedule:${action.id}`, action.delay);

  if (outcome === 'cancelled') {
    return { id: action.id, status: 'cancelled' as const };
  }

  await runAction(action);
  return { id: action.id, status: 'executed' as const };
}

// In-memory record of executed actions so the demo runs out of the box.
// (Keyed by action id, so a transparent step retry can't double-record.)
export const executedActions = new Map<string, Record<string, unknown>>();

// Replace the body of this step with your real action. The step has full
// Node.js access and is automatically retried on transient failure (3x).
// A real implementation looks like:
//
//   await fetch("https://api.your-domain.com/scheduled-action", {
//     method: "POST",
//     body: JSON.stringify(action),
//   });
async function runAction(action: ScheduledAction): Promise<void> {
  'use step';
  executedActions.set(action.id, action.payload);
}
