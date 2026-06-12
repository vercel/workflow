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
 *   - Replace the demo provider with your provider's API (a real Stripe
 *     call is shown in the comment inside createCharge).
 *   - Pass stepId as the idempotency key header your provider expects
 *     (Stripe: "Idempotency-Key", Braintree: "X-Request-Id", etc.).
 *   - Replace sendReceipt with your notification step (Resend, SendGrid…).
 *   - Add STRIPE_SECRET_KEY (and other secrets) to your .env file.
 *
 * DOCS: https://workflow-sdk.dev/patterns/idempotency
 */
import { getStepMetadata, RetryableError } from 'workflow';

export async function chargeCustomer(customerId: string, amountCents: number) {
  'use workflow';

  const charge = await createCharge(customerId, amountCents);
  await sendReceipt(customerId, charge.id);

  return { customerId, chargeId: charge.id, status: 'completed' as const };
}

// DEMO PAYMENT PROVIDER — an in-memory stand-in that honors idempotency
// keys exactly the way Stripe does: a request that repeats a previously
// seen key returns the ORIGINAL charge instead of creating a new one.
// (Exported so you can inspect it from a console or test.)
export const demoProviderCharges = new Map<
  string,
  { id: string; amount: number; customerId: string }
>();

// stepId is deterministic across retries — the provider deduplicates on it,
// so even if this step runs twice the customer is only charged once.
async function createCharge(
  customerId: string,
  amountCents: number
): Promise<{ id: string; amount: number }> {
  'use step';

  const { stepId, attempt } = getStepMetadata();

  // The real call this demo stands in for:
  //   const res = await fetch("https://api.stripe.com/v1/charges", {
  //     method: "POST",
  //     headers: {
  //       Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
  //       "Content-Type": "application/x-www-form-urlencoded",
  //       // Stripe returns the same charge if this key has been seen before.
  //       "Idempotency-Key": stepId,
  //     },
  //     body: new URLSearchParams({
  //       amount: String(amountCents),
  //       currency: "usd",
  //       customer: customerId,
  //     }),
  //   });
  //   if (!res.ok) throw new Error(`Charge failed: ${res.status}`);
  //   return res.json();

  // DEMO: the provider dedupes on the idempotency key (= stepId).
  const existing = demoProviderCharges.get(stepId);
  const charge = existing ?? {
    id: `ch_${customerId}_${demoProviderCharges.size + 1}`,
    amount: amountCents,
    customerId,
  };
  demoProviderCharges.set(stepId, charge);

  // DEMO: simulate the response getting lost in transit on the first
  // attempt — the provider already recorded the charge. The runtime retries
  // the step; the retry repeats the SAME key, so the provider returns the
  // original charge instead of double-charging.
  if (attempt === 1) {
    throw new RetryableError('demo: response lost after provider charged', {
      retryAfter: 100,
    });
  }

  return { id: charge.id, amount: charge.amount };
}

// DEMO RECEIPT LOG — same idempotency mechanics for notifications.
export const demoReceipts = new Map<
  string,
  { customerId: string; chargeId: string }
>();

async function sendReceipt(
  customerId: string,
  chargeId: string
): Promise<void> {
  'use step';

  const { stepId } = getStepMetadata();

  // Real: POST to your notification API with an "Idempotency-Key": stepId
  // header — the same pattern as the charge above.
  demoReceipts.set(stepId, { customerId, chargeId });
}
