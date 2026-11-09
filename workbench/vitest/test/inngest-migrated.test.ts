import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { FatalError } from 'workflow';
import { resumeHook, start } from 'workflow/api';
import { WorkflowRunFailedError } from 'workflow/errors';
import {
  auditVotes,
  collectVotes,
  failFast,
  fulfillOrder,
} from '../workflows/inngest-migrated.js';

// workflows/inngest-migrated.ts is the output of `workflow migrate inngest`
// for packages/cli/tests/fixture/inngest/order/functions.ts. These tests
// prove the codemod's output runs, not just that it compiles: the lifted
// steps receive their captured variables, the waitForEvent() hook resumes on
// the token built from `match`, the timeout, NonRetriableError and
// `retries: 0` paths keep their Inngest behavior, a run can wait twice on one
// token, and two workflows waiting for the same event are both resumed.

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

    const token = `shop/order.approved:fulfillOrder:${orderId}`;
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

    await waitForHook(run, {
      token: `shop/order.approved:fulfillOrder:${orderId}`,
    });
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

  it('waits twice on one token in a run, and resumes every workflow waiting for the event', async () => {
    const pollId = `poll-${Math.random().toString(36).slice(2)}`;
    const opened = { name: 'poll/opened', data: { pollId, field: 'choice' } };
    const votes = await start(collectVotes, [opened]);
    const audit = await start(auditVotes, [opened]);

    // Where Inngest sent one 'poll/vote' event, the sender resumes the token
    // of each workflow that waits for it (the migration report lists them).
    const vote = (voter: string, choice: string) => ({
      name: 'poll/vote',
      data: { pollId, voter, choice },
    });
    const votesToken = `poll/vote:collectVotes:${pollId}`;
    const auditToken = `poll/vote:auditVotes:${pollId}`;
    const first = await waitForHook(votes, { token: votesToken });
    await waitForHook(audit, { token: auditToken });
    await resumeHook(votesToken, vote('ana', 'red'));
    await resumeHook(auditToken, vote('ana', 'red'));

    // The first hook was disposed, so the second wait can reuse the token.
    await waitForHook(votes, { token: votesToken, notHookId: first.hookId });
    await resumeHook(votesToken, vote('bo', 'blue'));

    await expect(votes.returnValue).resolves.toEqual({
      pollId,
      votes: ['red', 'blue'],
    });
    await expect(audit.returnValue).resolves.toEqual({ firstVoter: 'ana' });
  }, 60_000);

  it('does not retry a step whose function set retries to 0 through a const', async () => {
    const run = await start(failFast, []);
    const error = await run.returnValue.catch((e: unknown) => e);
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    // Only the first attempt throws, so a retry would have succeeded.
    expect(
      String(((error as WorkflowRunFailedError).cause as Error).message)
    ).toContain('first attempt fails');
  }, 60_000);
});
