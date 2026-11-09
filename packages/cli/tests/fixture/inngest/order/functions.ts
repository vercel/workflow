// Inngest input for the `workflow migrate inngest` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/inngest-migrated.ts,
// where it runs in-process. After editing this file, regenerate that one with
// UPDATE_INNGEST_FIXTURE=1 pnpm --filter @workflow/cli test inngest
import { NonRetriableError } from 'inngest';
import { inngest } from './client';

type LineItem = { sku: string; qty: number; price: number };

const TAX_RATE = 0.25;

export const fulfillOrder = inngest.createFunction(
  { id: 'fulfill-order', retries: 2 },
  { event: 'shop/order.created' },
  async ({ event, step, runId }) => {
    const priced = await step.run('price-items', async () => {
      const items: LineItem[] = event.data.items;
      if (items.length === 0) {
        throw new NonRetriableError(`Order ${event.data.orderId} has no items`);
      }
      return items.map((item) => ({
        sku: item.sku,
        total: item.qty * item.price * (1 + TAX_RATE),
      }));
    });

    const reservations = await Promise.all(
      priced.map((line) =>
        step.run(`reserve-${line.sku}`, () => ({
          sku: line.sku,
          reservedBy: runId,
        }))
      )
    );

    await step.sleep('cool-off', '1s');

    const approval = await step.waitForEvent('wait-for-approval', {
      event: 'shop/order.approved',
      timeout: '1h',
      match: 'data.orderId',
    });
    if (!approval) {
      return { orderId: event.data.orderId, status: 'expired' };
    }

    const receipt = await step.run(
      'charge',
      async (currency: string) => {
        const amount = priced.reduce((sum, line) => sum + line.total, 0);
        return {
          orderId: event.data.orderId,
          amount,
          currency,
          approvedBy: approval.data.approver,
        };
      },
      'usd'
    );

    return {
      status: 'fulfilled',
      receipt,
      reserved: reservations.map((r) => r.sku),
      sameRun: reservations.every((r) => r.reservedBy === runId),
    };
  }
);
