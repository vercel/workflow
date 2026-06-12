/**
 * Saga (Transactions & Rollbacks) — multi-step transaction with automatic
 * compensation on failure.
 *
 * THE PATTERN:
 *   1. Each forward step pushes a matching undo function onto a compensation
 *      stack before executing — so the stack is always in sync with what
 *      has actually succeeded.
 *   2. On any error, the catch block unwinds the stack in LIFO order,
 *      calling each undo step to restore consistency.
 *   3. Compensation steps are "use step" functions — durable and retried —
 *      so a mid-rollback crash doesn't leave data inconsistent.
 *   4. FatalError skips the default 3x retry and triggers rollback immediately
 *      for errors that can't benefit from a retry (e.g. "card declined").
 *
 * USEFUL WHEN:
 *   - A multi-step flow (reserve → charge → provision → notify) must be
 *     consistent: if any step fails, all prior steps must be undone.
 *   - You can't use a database transaction across multiple external services.
 *   - You need an audit trail of what was attempted and what was rolled back.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace reserveSeats / captureInvoice / provisionSeats with your
 *     forward steps. Each must have a matching compensation pushed before it.
 *   - Make all compensation steps idempotent — they may be called multiple
 *     times if the workflow restarts mid-rollback.
 *   - Use FatalError on permanent failures (auth errors, validation) to skip
 *     retries and trigger the rollback immediately.
 *   - sendConfirmation is fire-and-forget (no compensation) — OK for
 *     notifications where duplication is harmless.
 *
 * DOCS: https://workflow-sdk.dev/patterns/saga
 */
import { FatalError, getStepMetadata } from 'workflow';

// DEMO LEDGER — records each action so you can watch the forward steps and
// the LIFO rollback. Replace with real API calls (examples in each step).
// Steps execute at-least-once, so entries are deduped by stepId.
export const demoLedger: string[] = [];
const recordedSteps = new Set<string>();
function record(entry: string): void {
  const { stepId } = getStepMetadata();
  if (recordedSteps.has(stepId)) return;
  recordedSteps.add(stepId);
  demoLedger.push(entry);
}

export async function subscriptionUpgradeSaga(
  accountId: string,
  seats: number
) {
  'use workflow';

  // Stack grows as steps succeed; unwound in LIFO order on failure.
  const compensations: Array<{ name: string; undo: () => Promise<void> }> = [];

  try {
    const reservationId = await reserveSeats(accountId, seats);
    compensations.push({
      name: 'Release seats',
      undo: () => releaseSeats(accountId, reservationId),
    });

    const invoiceId = await captureInvoice(accountId, seats);
    compensations.push({
      name: 'Refund invoice',
      undo: () => refundInvoice(accountId, invoiceId),
    });

    const entitlementId = await provisionSeats(accountId, seats);
    compensations.push({
      name: 'Deprovision seats',
      undo: () => deprovisionSeats(accountId, entitlementId),
    });

    // Fire-and-forget — notifications don't need a compensation.
    await sendConfirmation(accountId, invoiceId, entitlementId);

    return {
      status: 'completed' as const,
      accountId,
      invoiceId,
      entitlementId,
    };
  } catch (error) {
    // Unwind in LIFO order. Each undo is itself a step → durable + retried.
    for (const comp of compensations.reverse()) {
      await comp.undo();
    }
    return {
      status: 'rolled_back' as const,
      accountId,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Forward steps — throw FatalError for permanent failures to skip retries
// and trigger compensation immediately. Each demo body shows the real call
// it stands in for.
async function reserveSeats(accountId: string, seats: number): Promise<string> {
  'use step';
  // Real: POST https://api.your-billing.com/seats/reserve { accountId, seats }
  record(`reserve:${accountId}`);
  return `res_${accountId}_${seats}`;
}

async function captureInvoice(
  accountId: string,
  seats: number
): Promise<string> {
  'use step';
  // Real: POST https://api.your-billing.com/invoices { accountId, seats }
  record(`capture:${accountId}`);
  return `inv_${accountId}_${seats}`;
}

async function provisionSeats(
  accountId: string,
  seats: number
): Promise<string> {
  'use step';
  // Real: POST https://api.your-provisioner.com/entitlements { accountId, seats }
  // DEMO: account IDs containing "fail" simulate a permanent provisioning
  // failure so you can watch the rollback happen.
  if (accountId.includes('fail')) {
    throw new FatalError('Provisioning failed');
  }
  record(`provision:${accountId}`);
  return `ent_${accountId}_${seats}`;
}

async function sendConfirmation(
  accountId: string,
  invoiceId: string,
  entitlementId: string
): Promise<void> {
  'use step';
  // Real: send an email / Slack message referencing invoiceId + entitlementId.
  record(`confirm:${accountId}:${invoiceId}:${entitlementId}`);
}

// Compensation steps — MUST be idempotent. May be called again if retried.
async function releaseSeats(
  accountId: string,
  reservationId: string
): Promise<void> {
  'use step';
  // Real: POST https://api.your-billing.com/seats/release { accountId, reservationId }
  record(`release:${accountId}:${reservationId}`);
}

async function refundInvoice(
  accountId: string,
  invoiceId: string
): Promise<void> {
  'use step';
  // Real: POST https://api.your-billing.com/invoices/{invoiceId}/refund
  record(`refund:${accountId}:${invoiceId}`);
}

async function deprovisionSeats(
  accountId: string,
  entitlementId: string
): Promise<void> {
  'use step';
  // Real: DELETE https://api.your-provisioner.com/entitlements/{entitlementId}
  record(`deprovision:${accountId}:${entitlementId}`);
}
