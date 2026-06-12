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

export const schedulingUsageSource = `import { start } from "workflow/api";
import {
  cancellableSleep,
  cancelSchedule,
  scheduleAction,
} from "@/app/workflows/scheduling-workflow";

// 1) Defer an action — one run per scheduled action:
export async function scheduleTrialReminder(userId: string) {
  await start(scheduleAction, [
    { id: \`trial-reminder:\${userId}\`, delay: "2d", payload: { userId } },
  ]);
}

// …and cancel it from anywhere (e.g. the user converted):
export async function cancelTrialReminder(userId: string) {
  await cancelSchedule.resume(\`schedule:trial-reminder:\${userId}\`, {
    reason: "User converted",
  });
}

// 2) Or use cancellableSleep directly inside YOUR OWN workflow:
export async function trialFlow(userId: string) {
  "use workflow";

  const outcome = await cancellableSleep(\`trial:\${userId}\`, "14d");
  if (outcome === "cancelled") {
    return { userId, converted: true };
  }

  await sendTrialExpiredEmail(userId);
  return { userId, converted: false };
}

async function sendTrialExpiredEmail(userId: string): Promise<void> {
  "use step";
  // your email provider here
}
`;
