// Temporal input for the `workflow migrate temporal` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/temporal-migrated/,
// where it runs in-process. After editing this file, regenerate that directory
// with UPDATE_TEMPORAL_FIXTURE=1 pnpm --filter @workflow/cli test temporal
import { ApplicationFailure, Context } from '@temporalio/activity';

const PRICES: Record<string, number> = { mug: 10, tee: 20, cap: 15 };

export async function priceOf(sku: string): Promise<number> {
  return PRICES[sku] ?? 0;
}

export async function reserve(sku: string, qty: number) {
  return { sku, qty, reservationId: `res-${sku}-${qty}` };
}

// Fails on its first two attempts.
export async function flakyCharge(orderId: string): Promise<{ orderId: string; attempt: number }> {
  const { attempt } = Context.current().info;
  if (attempt < 3) throw new Error(`charge attempt ${attempt} failed`);
  return { orderId, attempt };
}

// Fails on its first attempt.
export async function failsOnce(): Promise<string> {
  if (Context.current().info.attempt === 1) throw new Error('first attempt fails');
  return 'retried';
}

export async function rejectCard(orderId: string): Promise<never> {
  throw ApplicationFailure.nonRetryable(`card declined for ${orderId}`);
}

export async function busyThenOk(): Promise<{ attempt: number }> {
  const attempt = Context.current().info.attempt;
  if (attempt === 1) {
    throw ApplicationFailure.create({ message: 'busy', nextRetryDelay: '1s' });
  }
  return { attempt };
}
