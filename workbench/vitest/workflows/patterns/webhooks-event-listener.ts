/**
 * Webhooks — Event Listener pattern (long-running webhook ledger).
 *
 * THE PATTERN:
 *   1. createWebhook({ respondWith: "manual" }) returns a durable URL and an
 *      async iterator. Register the URL with the external service once.
 *   2. `for await (const request of webhook)` yields incoming HTTP requests
 *      into the workflow's event loop — each iteration is a durable step.
 *   3. Process and respond to each webhook inside processEvent ("use step")
 *      so the response is durable and the handler retries on crash.
 *   4. `break` the loop to terminate the workflow when a terminal event
 *      arrives (payment.succeeded, refund.created, etc.).
 *
 * USEFUL WHEN:
 *   - You need to receive and process a sequence of webhook events for a
 *     single entity (order, payment, document) over time.
 *   - Each event must be acknowledged individually to the provider.
 *   - The workflow must survive restarts without missing or duplicating events.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Register webhook.url with your provider (Stripe, GitHub, Twilio…)
 *     after starting the workflow — it's stable for the run's lifetime.
 *   - Replace processEvent with your domain logic. Return a type discriminant
 *     so the loop knows when to break.
 *   - Add more terminal event types to the break condition as needed.
 *   - For a single callback (not a sequence), use the Request-Reply pattern.
 *
 * DOCS: https://workflow-sdk.dev/patterns/webhooks
 */
import { createWebhook, type RequestWithResponse } from 'workflow';

export async function paymentWebhook(orderId: string) {
  'use workflow';

  // createWebhook returns a stable URL and an async iterator over requests.
  const webhook = createWebhook({ respondWith: 'manual' });
  // Register webhook.url with your provider — it's valid for this run's lifetime.

  const ledger: { type: string; at: string }[] = [];

  for await (const request of webhook) {
    const entry = await processEvent(request);
    ledger.push({ ...entry, at: new Date().toISOString() });

    // Break on terminal events to end the workflow.
    if (entry.type === 'payment.succeeded' || entry.type === 'refund.created') {
      break;
    }
  }

  return {
    orderId,
    webhookUrl: webhook.url,
    ledger,
    status: 'settled' as const,
  };
}

async function processEvent(
  request: RequestWithResponse
): Promise<{ type: string }> {
  'use step';
  const body = await request.json().catch(() => ({}));
  const type = (body?.type as string) ?? 'unknown';

  if (type === 'payment.succeeded') {
    await request.respondWith(Response.json({ ack: true, action: 'captured' }));
  } else if (type === 'payment.failed') {
    await request.respondWith(Response.json({ ack: true, action: 'flagged' }));
  } else {
    await request.respondWith(Response.json({ ack: true, action: 'ignored' }));
  }

  return { type };
}
