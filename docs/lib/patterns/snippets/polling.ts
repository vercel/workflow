export const pollingStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { waitForCondition } from "@/app/workflows/polling-workflow";

// POST /api/polling { target: string }
export async function POST(request: Request) {
  const { target } = (await request.json()) as { target: string };
  if (!target) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }

  const run = await start(waitForCondition, [target]);
  return NextResponse.json({ runId: run.runId });
}
`;
