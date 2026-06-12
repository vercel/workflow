/**
 * Idempotency — prevent duplicate side effects on retries and replays.
 *
 * THE PATTERN:
 *   1. getStepMetadata().stepId returns a deterministic ID that is stable
 *      across retries and replays of the same step invocation.
 *   2. Pass that stepId as the Idempotency-Key header to external APIs that
 *      support it (Stripe, Braintree, Adyen, etc.).
 *   3. The provider deduplicates: a retry with the same key returns the
 *      original response instead of creating a second charge / email / etc.
 *
 * USEFUL WHEN:
 *   - Charging a credit card (duplicates cause double charges).
 *   - Sending transactional emails (duplicates annoy users).
 *   - Creating external resources where duplication would cause data issues.
 *   - Any non-idempotent API call inside a retryable step.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace the Stripe charge call with your provider's API.
 *   - Pass stepId as the idempotency key header your provider expects
 *     (Stripe: "Idempotency-Key", Braintree: "X-Request-Id", etc.).
 *   - Replace sendReceipt with your notification step (Resend, SendGrid…).
 *   - Add STRIPE_SECRET_KEY (and other secrets) to your .env file.
 *
 * DOCS: https://workflow-sdk.dev/patterns/idempotency
 */
import { getStepMetadata } from 'workflow';

export async function chargeCustomer(customerId: string, amountCents: number) {
  'use workflow';

  const charge = await createCharge(customerId, amountCents);
  await sendReceipt(customerId, charge.id);

  return { customerId, chargeId: charge.id, status: 'completed' as const };
}

// stepId is deterministic across retries — Stripe deduplicates on it,
// so even if this step runs twice the customer is only charged once.
async function createCharge(
  customerId: string,
  amountCents: number
): Promise<{ id: string; amount: number }> {
  'use step';

  const { stepId } = getStepMetadata();

  const res = await fetch('https://api.stripe.com/v1/charges', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe returns the same charge object if this key has been seen before.
      'Idempotency-Key': stepId,
    },
    body: new URLSearchParams({
      amount: String(amountCents),
      currency: 'usd',
      customer: customerId,
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'unknown' }));
    throw new Error(`Charge failed: ${error.message ?? res.status}`);
  }

  return res.json();
}

async function sendReceipt(
  customerId: string,
  chargeId: string
): Promise<void> {
  'use step';

  const { stepId } = getStepMetadata();

  await fetch('https://api.example.com/receipts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Same pattern for any non-idempotent notification API.
      'Idempotency-Key': stepId,
    },
    body: JSON.stringify({ customerId, chargeId }),
  });
}
