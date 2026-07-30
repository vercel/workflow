export const recurringCronStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import {
  recurringCron,
  stopCron,
  type CronState,
} from "@/app/workflows/recurring-cron-workflow";

const INTERVAL_MS = 60 * 60 * 1000;

// POST /api/recurring-cron { name }                — start a schedule
// POST /api/recurring-cron { name, stop: true }    — stop it
export async function POST(request: Request) {
  const { name, stop, iteration } = await request.json();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (stop) {
    // The stop token includes the generation's starting iteration; pass
    // the one you observed (e.g. from the run's state) or track it.
    await stopCron.resume(\`cron:\${name}:\${iteration ?? 0}\`, {
      reason: "Stopped via API",
    });
    return NextResponse.json({ stopped: true, name });
  }

  const state: CronState = {
    iteration: 0,
    nextDueAt: Date.now() + INTERVAL_MS,
  };
  const run = await start(recurringCron, [name, state]);
  return NextResponse.json({ runId: run.runId, name });
}
`;
