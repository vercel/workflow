import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { FatalError } from 'workflow';
import { resumeHook, start } from 'workflow/api';
import { WorkflowRunFailedError } from 'workflow/errors';
import { fulfillOrder } from '../workflows/inngest-migrated.js';

// workflows/inngest-migrated.ts is the output of `workflow migrate inngest`
// for packages/cli/tests/fixture/inngest/order/functions.ts. These tests
// prove the codemod's output runs, not just that it compiles: the lifted
// steps receive their captured variables, the waitForEvent() hook resumes on
// the token built from `match`, and the timeout and NonRetriableError paths
// keep their Inngest behavior.

const orderEvent = (orderId: string, items: unknown[]) => ({
  name: 'shop/order.created',
  data: { orderId, items },
});

const items = [
  { sku: 'mug', qty: 2, price: 10 },
  { sku: 'tee', qty: 1, price: 20 },
];

describe('workflow migrated from Inngest by the codemod', () => {
  it('runs the lifted steps and resumes on the waitForEvent() token', async () => {
    const orderId = `order-${Math.random().toString(36).slice(2)}`;
    const run = await start(fulfillOrder, [orderEvent(orderId, items)]);

    const token = `shop/order.approved:${orderId}`;
    await waitForHook(run, { token });
    await resumeHook(token, {
      name: 'shop/order.approved',
      data: { orderId, approver: 'ana' },
    });

    await expect(run.returnValue).resolves.toEqual({
      status: 'fulfilled',
      receipt: { orderId, amount: 50, currency: 'usd', approvedBy: 'ana' },
      reserved: ['mug', 'tee'],
      sameRun: true,
    });
  }, 60_000);

  it('returns null from the wait when the timeout passes', async () => {
    const orderId = `order-${Math.random().toString(36).slice(2)}`;
    const run = await start(fulfillOrder, [orderEvent(orderId, items)]);

    await waitForHook(run, { token: `shop/order.approved:${orderId}` });
    // The cool-off sleep has finished by now; the pending one is the timeout.
    const timeout = await waitForSleep(run);
    await run.wakeUp({ correlationIds: [timeout] });

    await expect(run.returnValue).resolves.toEqual({
      orderId,
      status: 'expired',
    });
  }, 60_000);

  it('fails the run without retrying where Inngest threw NonRetriableError', async () => {
    const run = await start(fulfillOrder, [orderEvent('empty', [])]);
    const error = await run.returnValue.catch((e: unknown) => e);
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    const cause = (error as WorkflowRunFailedError).cause;
    expect(FatalError.is(cause)).toBe(true);
    expect((cause as Error).message).toBe('Order empty has no items');
  }, 60_000);
});
