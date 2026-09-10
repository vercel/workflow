export const idempotencyStartRouteSource = `import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { chargeCustomer } from "@/app/workflows/idempotency";

// POST /api/idempotency { customerId, amountCents }
export async function POST(request: Request) {
  const { customerId, amountCents } = await request.json();
  if (!customerId || typeof amountCents !== "number") {
    return NextResponse.json(
      { error: "customerId and amountCents are required" },
      { status: 400 },
    );
  }

  const run = await start(chargeCustomer, [customerId, amountCents]);
  return NextResponse.json({ runId: run.runId });
}
`;
