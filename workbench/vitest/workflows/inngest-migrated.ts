// Inngest input for the `workflow migrate inngest` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/inngest-migrated.ts,
// where it runs in-process. After editing this file, regenerate that one with
// UPDATE_INNGEST_FIXTURE=1 pnpm --filter @workflow/cli test inngest
import {
  createHook,
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
  type Hook,
  sleep,
} from 'workflow';

type LineItem = { sku: string; qty: number; price: number };

const TAX_RATE = 0.25;

export async function fulfillOrder(event: any) {
  'use workflow';
  const priced = await priceItems(event);

  const reservations = await Promise.all(priced.map((line) => reserve(line)));

  await sleep('1s');

  // TODO(workflow-migrate): Only one run at a time can own this hook token. Inngest resumed every run waiting for a matching "shop/order.approved"; if two fulfillOrder runs can wait for the same key at once, add something unique to the token (for example the run ID) and resume each run where the event is sent. Otherwise, delete this comment.
  const approval = await waitForHook(
    createHook({
      token: `shop/order.approved:fulfillOrder:${event.data.orderId}`,
    }),
    sleep('1h')
  );
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
  approval: {},
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

// Waits twice for the same event key in one run, and reads the vote through
// a computed key captured from the handler.
export async function collectVotes(event: any) {
  'use workflow';
  const field: string = event.data.field;
  const votes: string[] = [];
  for (let round = 0; round < 2; round++) {
    // TODO(workflow-migrate): Only one run at a time can own this hook token. Inngest resumed every run waiting for a matching "poll/vote"; if two collectVotes runs can wait for the same key at once, add something unique to the token (for example the run ID) and resume each run where the event is sent. Otherwise, delete this comment.
    const vote = await waitForHook(
      createHook({ token: `poll/vote:collectVotes:${event.data.pollId}` }),
      sleep('1h')
    );
    if (!vote) break;
    const choice = await readVote(field, vote.data);
    votes.push(choice);
  }
  return { pollId: event.data.pollId, votes };
}

async function readVote(
  field: string,
  { [field]: value }: Record<string, string>
) {
  'use step';
  return value;
}
readVote.maxRetries = 0;

// A second function waiting for the same event and key.
export async function auditVotes(event: any) {
  'use workflow';
  // TODO(workflow-migrate): Only one run at a time can own this hook token. Inngest resumed every run waiting for a matching "poll/vote"; if two auditVotes runs can wait for the same key at once, add something unique to the token (for example the run ID) and resume each run where the event is sent. Otherwise, delete this comment.
  const vote = await waitForHook(
    createHook({ token: `poll/vote:auditVotes:${event.data.pollId}` }),
    sleep('1h')
  );
  return { firstVoter: vote ? vote.data.voter : null };
}

// Fails on its first attempt; with `retries: 0` that fails the run.
export async function failFast() {
  'use workflow';
  return flaky();
}

async function flaky() {
  'use step';
  if (getStepMetadata().attempt - 1 === 0)
    throw new Error('first attempt fails');
  return 'retried';
}
flaky.maxRetries = 0;

/** Resolves with the hook's payload, or with null once `timeout` resolves. */
async function waitForHook<T>(
  hook: Hook<T>,
  timeout?: Promise<void>
): Promise<T | null> {
  try {
    return await (timeout
      ? Promise.race([hook, timeout.then(() => null)])
      : hook);
  } finally {
    hook.dispose();
  }
}
