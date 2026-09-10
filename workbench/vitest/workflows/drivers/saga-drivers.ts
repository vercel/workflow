import { demoLedger, subscriptionUpgradeSaga } from '../patterns/saga.js';

// Reads the saga demo ledger (module state lives in the step bundle, so the
// test can only observe it through a step's return value).
async function readLedger(accountId: string): Promise<string[]> {
  'use step';
  return demoLedger.filter((entry) => entry.includes(accountId));
}

/** Run the saga, then return its result plus the ledger entries it wrote. */
export async function sagaWithLedger(accountId: string, seats: number) {
  'use workflow';

  const result = await subscriptionUpgradeSaga(accountId, seats);
  const ledger = await readLedger(accountId);
  return { result, ledger };
}
