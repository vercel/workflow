/**
 * Source snippets for the Stripe registry entry.
 *
 * Dunning (failed-payment recovery) as a durable workflow: retry a failed
 * invoice on an escalating schedule, exit early the moment Stripe's
 * `invoice.paid` webhook arrives (the customer fixed their card), and
 * downgrade the account if every attempt fails. One run per invoice —
 * the whole multi-day recovery timeline lives in a single function.
 */

const STRIPE_BODY = `import { defineHook, sleep } from "workflow";
import Stripe from "stripe";

// Escalating retry schedule after the initial failure.
const RETRY_DELAYS = ["3d", "5d", "7d"] as const;

// Resumed by the Stripe webhook route when invoice.paid arrives.
export const invoicePaid = defineHook<{ invoiceId: string }>();

export function invoicePaidToken(invoiceId: string) {
  return \`stripe-invoice-paid:\${invoiceId}\`;
}

export async function dunningWorkflow(customerId: string, invoiceId: string) {
  "use workflow";

  // If the customer pays at ANY point (webhook), the race exits early.
  const paid = invoicePaid.create({ token: invoicePaidToken(invoiceId) });

  for (const delay of RETRY_DELAYS) {
    await notifyCustomer(customerId, invoiceId, delay);

    // Wait out the grace period — unless payment arrives first.
    const outcome = await Promise.race([
      sleep(delay).then(() => "elapsed" as const),
      paid.then(() => "paid" as const),
    ]);
    if (outcome === "paid") {
      return { invoiceId, status: "recovered" as const };
    }

    // Grace period over — retry the charge ourselves.
    const result = await retryInvoice(invoiceId);
    if (result === "paid") {
      return { invoiceId, status: "recovered" as const };
    }
  }

  // Every attempt failed — downgrade and close out.
  await downgradeAccount(customerId);
  return { invoiceId, status: "downgraded" as const };
}

function stripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY as string);
}

async function retryInvoice(invoiceId: string): Promise<"paid" | "failed"> {
  "use step";
  const stripe = stripeClient();
  try {
    const invoice = await stripe.invoices.pay(invoiceId);
    return invoice.status === "paid" ? "paid" : "failed";
  } catch {
    // Card declined again — treat as failed, the schedule continues.
    return "failed";
  }
}

async function notifyCustomer(
  customerId: string,
  invoiceId: string,
  graceDelay: string,
): Promise<void> {
  "use step";
  // Replace with your email provider (see the Resend pattern). Tell the
  // customer what failed and how long they have before the next attempt.
  await fetch("https://api.example.com/emails/payment-failed", {
    method: "POST",
    body: JSON.stringify({ customerId, invoiceId, graceDelay }),
  });
}

async function downgradeAccount(customerId: string): Promise<void> {
  "use step";
  // Replace with your real downgrade: cancel the subscription, flip a
  // plan flag, revoke entitlements.
  const stripe = stripeClient();
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
  });
  for (const sub of subscriptions.data) {
    await stripe.subscriptions.cancel(sub.id);
  }
}
`;

export const stripeWorkflowSource = STRIPE_BODY;

export const stripeWorkflowInstallSource = `/**
 * Stripe Dunning — failed-payment recovery as one durable function.
 *
 * THE PATTERN:
 *   1. A payment_failed webhook starts one run per invoice. The run owns
 *      the entire multi-day recovery timeline: notify → grace period →
 *      retry charge → escalate → downgrade.
 *   2. Each grace period races a durable sleep against an invoice.paid
 *      hook resumed by Stripe's webhook — the moment the customer fixes
 *      their card, the run exits with "recovered", no polling.
 *   3. If the whole schedule fails, the account downgrades exactly once.
 *
 * USEFUL WHEN:
 *   - Recovering failed subscription payments without a cron + state
 *     machine spread across tables and webhook handlers.
 *   - Any multi-step billing timeline (trial ending, seat true-ups).
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Tune RETRY_DELAYS to your dunning policy.
 *   - Replace notifyCustomer with your email provider (see the Resend
 *     pattern) and downgradeAccount with your real entitlement change.
 *   - Verify webhook signatures in the route (stripe.webhooks
 *     .constructEvent) before resuming hooks or starting runs.
 *   - Stripe Smart Retries can do the retrying; this pattern is for when
 *     you want the timeline, notifications, and downgrade logic in YOUR
 *     code with full observability per invoice.
 *
 * REQUIRED ENV:
 *   - STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *
 * DOCS: https://workflow-sdk.dev/patterns/stripe
 */
${STRIPE_BODY}`;

export const stripeWebhookRouteSource = `import { NextResponse } from "next/server";
import Stripe from "stripe";
import { start } from "workflow/api";
import {
  dunningWorkflow,
  invoicePaid,
  invoicePaidToken,
} from "@/app/workflows/stripe-workflow";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

// POST /api/webhooks/stripe — Stripe webhook endpoint.
export async function POST(request: Request) {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") as string;

  // Always verify the signature before acting on a webhook.
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object;
    // One durable run owns this invoice's whole recovery timeline.
    await start(dunningWorkflow, [
      invoice.customer as string,
      invoice.id as string,
    ]);
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    try {
      await invoicePaid.resume(invoicePaidToken(invoice.id as string), {
        invoiceId: invoice.id as string,
      });
    } catch {
      // No dunning run waiting on this invoice — normal payment, ignore.
    }
  }

  return NextResponse.json({ received: true });
}
`;
