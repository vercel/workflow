/**
 * Source snippets for the Scheduling registry entry.
 *
 * Two layers:
 *   - `cancellableSleep()` — the reusable component: a durable sleep raced
 *     against a cancel hook, usable inside any workflow.
 *   - `scheduleAction()` — a thin scheduling workflow built on it: defer any
 *     action minutes / hours / days ahead, cancellable by semantic ID.
 *
 * No cron jobs, no DB flags, no scheduler infrastructure — durable sleep
 * suspends the run for free, and the hook cancels it from anywhere.
 */

export const schedulingWorkflowSource = `import { defineHook, sleep } from "workflow";

// Hook fired by your app to cancel an in-flight scheduled action.
// Token format is up to you — we use \`schedule:<id>\` here so the
// caller doesn't need to know the run ID.
export const cancelSchedule = defineHook<{ reason?: string }>();

/**
 * REUSABLE COMPONENT — durable sleep raced against a cancel hook.
 * Call from any workflow. Resolves "elapsed" when the delay passes, or
 * "cancelled" when \`cancelSchedule.resume(token)\` fires first.
 */
export async function cancellableSleep(
  token: string,
  delay: string | number | Date,
): Promise<"elapsed" | "cancelled"> {
  const hook = cancelSchedule.create({ token });
  const result = await Promise.race([
    sleep(delay as any).then(() => "elapsed" as const),
    hook.then(() => "cancelled" as const),
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
  "use workflow";

  const outcome = await cancellableSleep(
    \`schedule:\${action.id}\`,
    action.delay,
  );

  if (outcome === "cancelled") {
    return { id: action.id, status: "cancelled" as const };
  }

  await runAction(action);
  return { id: action.id, status: "executed" as const };
}

// Replace the body of this step with your real action — send an email,
// post to Slack, fire a webhook, write to your DB. The step has full
// Node.js access and is automatically retried on failure.
async function runAction(action: ScheduledAction): Promise<void> {
  "use step";
  await fetch("https://api.example.com/scheduled-action", {
    method: "POST",
    body: JSON.stringify(action),
  });
}
`;

export const schedulingWorkflowInstallSource = `/**
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
import { defineHook, sleep } from "workflow";

// Exported so the cancel API route can resume it with just the schedule ID.
export const cancelSchedule = defineHook<{ reason?: string }>();

/**
 * REUSABLE COMPONENT — durable sleep raced against a cancel hook.
 * Call from any workflow. Resolves "elapsed" when the delay passes, or
 * "cancelled" when cancelSchedule.resume(token) fires first.
 */
export async function cancellableSleep(
  token: string,
  delay: string | number | Date,
): Promise<"elapsed" | "cancelled"> {
  const hook = cancelSchedule.create({ token });
  const result = await Promise.race([
    sleep(delay as any).then(() => "elapsed" as const),
    hook.then(() => "cancelled" as const),
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
  "use workflow";

  const outcome = await cancellableSleep(
    \`schedule:\${action.id}\`,
    action.delay,
  );

  if (outcome === "cancelled") {
    return { id: action.id, status: "cancelled" as const };
  }

  await runAction(action);
  return { id: action.id, status: "executed" as const };
}

// Replace the body of this step with your real action. The step has full
// Node.js access and is automatically retried on transient failure (3x).
async function runAction(action: ScheduledAction): Promise<void> {
  "use step";
  await fetch("https://api.example.com/scheduled-action", {
    method: "POST",
    body: JSON.stringify(action),
  });
}
`;

export const schedulingStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { scheduleAction, type ScheduledAction } from "@/app/workflows/scheduling-workflow";

// POST /api/scheduling { id, delay, payload }
export async function POST(request: Request) {
  const action = (await request.json()) as ScheduledAction;
  if (!action.id || action.delay === undefined) {
    return NextResponse.json(
      { error: "id and delay are required" },
      { status: 400 },
    );
  }

  const run = await start(scheduleAction, [action]);
  return NextResponse.json({ runId: run.runId, scheduleId: action.id });
}
`;

export const schedulingCancelRouteSource = `import { NextResponse } from "next/server";
import { cancelSchedule } from "@/app/workflows/scheduling-workflow";

// POST /api/scheduling/cancel { scheduleId, reason? }
// Idempotent: returns success even if the hook has already fired or expired.
export async function POST(request: Request) {
  const { scheduleId, reason } = await request.json();
  if (!scheduleId) {
    return NextResponse.json(
      { error: "scheduleId is required" },
      { status: 400 },
    );
  }

  try {
    await cancelSchedule.resume(\`schedule:\${scheduleId}\`, {
      reason: reason ?? "Cancelled by user",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("expired")) {
      return NextResponse.json({
        success: true,
        scheduleId,
        note: "No active schedule found (already executed or cancelled)",
      });
    }
    throw error;
  }

  return NextResponse.json({ success: true, scheduleId });
}
`;
