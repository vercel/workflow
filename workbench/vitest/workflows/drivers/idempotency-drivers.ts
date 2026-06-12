import {
  chargeCustomer,
  demoProviderCharges,
  demoReceipts,
} from '../patterns/idempotency.js';

// The demo provider's records live in the step bundle — tests can only
// observe them through a step's return value.
async function readProviderState(customerId: string): Promise<{
  chargeCount: number;
  chargeIds: string[];
  receiptCount: number;
}> {
  'use step';
  const charges = [...demoProviderCharges.values()].filter(
    (charge) => charge.customerId === customerId
  );
  const receipts = [...demoReceipts.values()].filter(
    (receipt) => receipt.customerId === customerId
  );
  return {
    chargeCount: charges.length,
    chargeIds: charges.map((charge) => charge.id),
    receiptCount: receipts.length,
  };
}

/**
 * Charge a customer (the demo provider drops the response on the first
 * attempt, forcing a retry), then audit how many charges the provider
 * actually recorded — the idempotency key must have deduped to exactly one.
 */
export async function chargeAndAudit(customerId: string, amountCents: number) {
  'use workflow';

  const result = await chargeCustomer(customerId, amountCents);
  const audit = await readProviderState(customerId);
  return { result, audit };
}
