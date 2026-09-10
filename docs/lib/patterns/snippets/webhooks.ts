export const webhooksStartRouteSource = `import { start, getRun } from "workflow/api";
import { NextResponse } from "next/server";
import { paymentWebhook } from "@/app/workflows/webhooks-event-listener-workflow";

// POST /api/webhooks { orderId }
// Returns the auto-generated webhook URL — register it with the external service.
export async function POST(request: Request) {
  const { orderId } = await request.json();
  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  const run = await start(paymentWebhook, [orderId]);

  // Read the workflow's return value once to surface webhook.url upstream.
  // For long-lived webhooks, prefer streaming or a separate "/url/:runId" route.
  return NextResponse.json({
    runId: run.runId,
    note: "The workflow exposes webhook.url in its return value once settled.",
  });
}
`;
