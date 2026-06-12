export const timeoutsStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { processWithTimeout } from "@/app/workflows/timeouts";

// POST /api/timeouts { data }
export async function POST(request: Request) {
  const { data } = await request.json();
  if (typeof data !== "string") {
    return NextResponse.json({ error: "data must be a string" }, { status: 400 });
  }

  const run = await start(processWithTimeout, [data]);
  return NextResponse.json({ runId: run.runId });
}
`;
