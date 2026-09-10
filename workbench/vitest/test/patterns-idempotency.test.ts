import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { chargeAndAudit } from '../workflows/drivers/idempotency-drivers.js';

const RUN = Date.now().toString(36);

describe('idempotency pattern', () => {
  it('charges exactly once despite a forced retry (stepId as idempotency key)', async () => {
    const customerId = `cust-${RUN}-1`;
    const run = await start(chargeAndAudit, [customerId, 5000]);
    const { result, audit } = await run.returnValue;

    expect(result.customerId).toBe(customerId);
    expect(result.status).toBe('completed');

    // The demo provider drops the response on attempt 1 AFTER recording the
    // charge; the runtime retries the step with the same stepId, so the
    // provider dedupes — exactly ONE charge exists for this customer.
    expect(audit.chargeCount).toBe(1);
    expect(audit.chargeIds).toEqual([result.chargeId]);

    // The receipt step is keyed the same way → exactly one receipt.
    expect(audit.receiptCount).toBe(1);
  });

  it('separate workflow runs get distinct idempotency keys (new charges)', async () => {
    const customerId = `cust-${RUN}-2`;

    const first = await start(chargeAndAudit, [customerId, 100]);
    const firstResult = await first.returnValue;
    const second = await start(chargeAndAudit, [customerId, 100]);
    const secondResult = await second.returnValue;

    // Different runs → different stepIds → the provider records two
    // independent charges (idempotency dedupes retries, not new requests).
    expect(secondResult.audit.chargeCount).toBe(2);
    expect(firstResult.result.chargeId).not.toBe(secondResult.result.chargeId);
  });
});
