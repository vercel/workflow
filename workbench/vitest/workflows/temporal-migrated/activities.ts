// Temporal input for the `workflow migrate temporal` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/temporal-migrated/,
// where it runs in-process. After editing this file, regenerate that directory
// with UPDATE_TEMPORAL_FIXTURE=1 pnpm --filter @workflow/cli test temporal
import { FatalError, getStepMetadata, RetryableError } from 'workflow';

const PRICES: Record<string, number> = { mug: 10, tee: 20, cap: 15 };

export async function priceOf(sku: string): Promise<number> {
  'use step';
  return PRICES[sku] ?? 0;
}
priceOf.maxRetries = 1;

export async function reserve(sku: string, qty: number) {
  'use step';
  return { sku, qty, reservationId: `res-${sku}-${qty}` };
}
reserve.maxRetries = 1;

// Fails on its first two attempts.
export async function flakyCharge(
  orderId: string
): Promise<{ orderId: string; attempt: number }> {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt < 3) throw new Error(`charge attempt ${attempt} failed`);
  return { orderId, attempt };
}
flakyCharge.maxRetries = 2;

// Fails on its first attempt.
export async function failsOnce(): Promise<string> {
  'use step';
  if (getStepMetadata().attempt === 1) throw new Error('first attempt fails');
  return 'retried';
}
failsOnce.maxRetries = 0;

export async function rejectCard(orderId: string): Promise<never> {
  'use step';
  throw new FatalError(`card declined for ${orderId}`);
}
rejectCard.maxRetries = 0;

export async function busyThenOk(): Promise<{ attempt: number }> {
  'use step';
  const attempt = getStepMetadata().attempt;
  if (attempt === 1) {
    throw new RetryableError('busy', { retryAfter: '1s' });
  }
  return { attempt };
}
busyThenOk.maxRetries = 2;
