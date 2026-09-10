export const batchAggregatorUsageSource = `import { aggregatorSend } from "@/app/workflows/batch-aggregator-workflow";

// In an API route, webhook handler, or step — wherever events originate:
export async function POST(request: Request) {
  const event = await request.json();

  // Events pile up per tenant; flushBatch() fires with up to 100 of them,
  // or whatever has accumulated after 5 minutes.
  await aggregatorSend(
    \`analytics:\${event.tenantId}\`,
    {
      type: event.type,
      userId: event.userId,
      at: event.timestamp,
    },
    // Stable id dedupes webhook redeliveries and step-retry resends.
    event.id,
  );

  return Response.json({ queued: true });
}
`;
