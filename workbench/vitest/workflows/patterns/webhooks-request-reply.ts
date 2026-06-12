/**
 * Webhooks — Async Request-Reply pattern (single callback with deadline).
 *
 * THE PATTERN:
 *   1. createWebhook() generates a one-time callback URL.
 *   2. Submit the URL to an external vendor that processes asynchronously
 *      (document verification, identity check, payment authorization…).
 *   3. Race the webhook callback against a sleep() deadline so the workflow
 *      never waits forever for an external service that never responds.
 *   4. Process the callback in a "use step" function so the response is
 *      durable and the handler retries on crash.
 *
 * USEFUL WHEN:
 *   - You call an external API that responds asynchronously via a callback URL.
 *   - You need a hard deadline after which the workflow times out gracefully.
 *   - The vendor callback is a one-shot event (not a sequence).
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace submitToVendor with your external API call.
 *   - Replace processCallback with your domain logic for the callback.
 *   - Tune the sleep("30s") deadline to match your vendor's SLA.
 *   - For sequences of events, use the Event Listener pattern instead.
 *
 * DOCS: https://workflow-sdk.dev/patterns/webhooks
 */
import {
  createWebhook,
  sleep,
  FatalError,
  type RequestWithResponse,
} from 'workflow';

export async function asyncVerification(documentId: string) {
  'use workflow';

  const webhook = createWebhook({ respondWith: 'manual' });
  await submitToVendor(documentId, webhook.url);

  const result = await Promise.race([
    (async () => {
      for await (const request of webhook) {
        return await processCallback(request);
      }
      throw new FatalError('Webhook closed without callback');
    })(),
    // Deadline: return a timed_out sentinel after 30s.
    sleep('30s').then(() => ({ status: 'timed_out' as const })),
  ]);

  return { documentId, ...result };
}

async function submitToVendor(
  documentId: string,
  callbackUrl: string
): Promise<void> {
  'use step';
  await fetch('https://vendor.example.com/verify', {
    method: 'POST',
    body: JSON.stringify({ documentId, callbackUrl }),
  });
}

async function processCallback(
  request: RequestWithResponse
): Promise<{ status: string; details: string }> {
  'use step';
  const body = await request.json().catch(() => ({}));
  await request.respondWith(Response.json({ ack: true }));
  return {
    status: body.approved ? 'verified' : 'rejected',
    details: body.details ?? body.reason ?? '',
  };
}
