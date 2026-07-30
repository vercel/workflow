import { describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { sagaWithLedger } from '../workflows/drivers/saga-drivers.js';

// Unique account IDs per vitest invocation — the demo ledger is module
// state filtered by accountId.
const RUN = Date.now().toString(36);

describe('saga pattern', () => {
  it('completes the happy path with all forward steps in order', async () => {
    const accountId = `acct-ok-${RUN}`;
    const run = await start(sagaWithLedger, [accountId, 5]);
    const { result, ledger } = await run.returnValue;

    expect(result).toEqual({
      status: 'completed',
      accountId,
      invoiceId: `inv_${accountId}_5`,
      entitlementId: `ent_${accountId}_5`,
    });

    // Forward steps ran in order; no compensations.
    expect(ledger.map((entry) => entry.split(':')[0])).toEqual([
      'reserve',
      'capture',
      'provision',
      'confirm',
    ]);
  });

  it('rolls back in LIFO order when a later step fails permanently', async () => {
    // Account IDs containing "fail" make the demo provisionSeats throw
    // FatalError — skipping retries and triggering compensation.
    const accountId = `acct-fail-${RUN}`;
    const run = await start(sagaWithLedger, [accountId, 3]);
    const { result, ledger } = await run.returnValue;

    expect(result).toEqual({
      status: 'rolled_back',
      accountId,
      reason: 'Provisioning failed',
    });

    // Forward: reserve → capture (provision threw before recording).
    // Rollback unwinds LIFO: refund (undo capture) BEFORE release (undo reserve).
    expect(ledger.map((entry) => entry.split(':')[0])).toEqual([
      'reserve',
      'capture',
      'refund',
      'release',
    ]);

    // Compensations received the IDs produced by their forward steps.
    expect(ledger[2]).toBe(`refund:${accountId}:inv_${accountId}_3`);
    expect(ledger[3]).toBe(`release:${accountId}:res_${accountId}_3`);
  });
});
