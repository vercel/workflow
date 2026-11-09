// Inngest input for the `workflow migrate inngest` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/inngest-migrated.ts,
// where it runs in-process. After editing this file, regenerate that one with
// UPDATE_INNGEST_FIXTURE=1 pnpm --filter @workflow/cli test inngest
import { createHook, FatalError, getWorkflowMetadata, sleep } from 'workflow';

type LineItem = { sku: string; qty: number; price: number };

const TAX_RATE = 0.25;

export async function fulfillOrder(event: any) {
  'use workflow';
  const priced = await priceItems(event);

  const reservations = await Promise.all(priced.map((line) => reserve(line)));

  await sleep('1s');

  const approval = await Promise.race([
    createHook({ token: `shop/order.approved:${event.data.orderId}` }),
    sleep('1h').then(() => null),
  ]);
  if (!approval) {
    return { orderId: event.data.orderId, status: 'expired' };
  }

  const receipt = await charge(priced, event, approval, 'usd');

  return {
    status: 'fulfilled',
    receipt,
    reserved: reservations.map((r) => r.sku),
    sameRun: reservations.every(
      (r) => r.reservedBy === getWorkflowMetadata().workflowRunId
    ),
  };
}

async function priceItems(event: any) {
  'use step';
  const items: LineItem[] = event.data.items;
  if (items.length === 0) {
    throw new FatalError(`Order ${event.data.orderId} has no items`);
  }
  return items.map((item) => ({
    sku: item.sku,
    total: item.qty * item.price * (1 + TAX_RATE),
  }));
}
priceItems.maxRetries = 2;

async function reserve(line: { sku: string; total: number }) {
  'use step';
  return {
    sku: line.sku,
    reservedBy: getWorkflowMetadata().workflowRunId,
  };
}
reserve.maxRetries = 2;

async function charge(
  priced: { sku: string; total: number }[],
  event: any,
  approval: any,
  currency: string
) {
  'use step';
  const amount = priced.reduce((sum, line) => sum + line.total, 0);
  return {
    orderId: event.data.orderId,
    amount,
    currency,
    approvedBy: approval.data.approver,
  };
}
charge.maxRetries = 2;
