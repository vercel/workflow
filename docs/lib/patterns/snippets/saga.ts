export const sagaStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { subscriptionUpgradeSaga } from "@/app/workflows/saga";

// POST /api/saga { accountId, seats }
export async function POST(request: Request) {
  const { accountId, seats } = await request.json();
  if (!accountId || typeof seats !== "number") {
    return NextResponse.json(
      { error: "accountId and seats are required" },
      { status: 400 },
    );
  }

  const run = await start(subscriptionUpgradeSaga, [accountId, seats]);
  return NextResponse.json({ runId: run.runId });
}
`;
