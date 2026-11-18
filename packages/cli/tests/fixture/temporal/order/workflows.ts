// Temporal input for the `workflow migrate temporal` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/temporal-migrated/,
// where it runs in-process. After editing this file, regenerate that directory
// with UPDATE_TEMPORAL_FIXTURE=1 pnpm --filter @workflow/cli test temporal
import {
  ApplicationFailure,
  condition,
  defineSignal,
  executeChild,
  log,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { priceOf, reserve } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 2 },
});

const { flakyCharge, busyThenOk } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, initialInterval: '100ms' },
});

const { failsOnce, rejectCard } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

const TAX = 0.25;

export const approveSignal = defineSignal<[boolean, string]>('approve');
export const incrementSignal = defineSignal<[number]>('increment');

type Item = { sku: string; qty: number };

// Parallel activities over captured items, a loop, a sleep.
export async function orderWorkflow(
  orderId: string,
  items: Item[]
): Promise<{ orderId: string; total: number; reservations: string[] }> {
  const prices = await Promise.all(items.map((item) => priceOf(item.sku)));
  const total = items.reduce((sum, item, i) => sum + prices[i] * item.qty * (1 + TAX), 0);
  const reservations: string[] = [];
  for (const item of items) {
    const r = await reserve(item.sku, item.qty);
    reservations.push(r.reservationId);
  }
  await sleep('1s');
  log.info('order done', { orderId });
  return { orderId, total, reservations };
}

// A signal and condition() with a timeout.
export async function approvalWorkflow(
  id: string,
  timeout: string
): Promise<{ id: string; status: string; by: string | null }> {
  let approved: boolean | undefined;
  let by: string | null = null;
  setHandler(approveSignal, (ok, who) => {
    approved = ok;
    by = who;
  });
  const decided = await condition(() => approved !== undefined, timeout as '1m');
  if (!decided) return { id, status: 'expired', by };
  return { id, status: approved ? 'approved' : 'rejected', by };
}

// Several signals, sent before the handler is set.
export async function counterWorkflow(target: number): Promise<{ count: number; seen: number[] }> {
  await sleep('500ms');
  let count = 0;
  const seen: number[] = [];
  setHandler(incrementSignal, (by) => {
    count += by;
    seen.push(by);
  });
  await condition(() => count >= target);
  return { count, seen };
}

// Retries: succeeds on the third attempt, fails with no retries, fatal error.
export async function retryWorkflow(orderId: string): Promise<{ orderId: string; attempt: number }> {
  return flakyCharge(orderId);
}

export async function noRetryWorkflow(): Promise<string> {
  return failsOnce();
}

export async function fatalWorkflow(orderId: string): Promise<string> {
  await rejectCard(orderId);
  return 'unreachable';
}

export async function retryAfterWorkflow(): Promise<{ attempt: number }> {
  return busyThenOk();
}

// Child workflows, both ways.
export async function doubleWorkflow(n: number): Promise<{ doubled: number }> {
  return { doubled: n * 2 };
}

export async function parentWorkflow(
  n: number
): Promise<{ executed: { doubled: number }; started: { doubled: number } }> {
  const executed = await executeChild(doubleWorkflow, { args: [n] });
  const handle = await startChild(doubleWorkflow, { args: [n + 1] });
  const started = await handle.result();
  return { executed, started };
}

// Patches, workflowInfo, uuid4, and a workflow-level failure.
export async function infoWorkflow(): Promise<{ branch: string; type: string; uuidLength: number }> {
  const branch = patched('v2') ? 'v2' : 'v1';
  return { branch, type: workflowInfo().workflowType, uuidLength: uuid4().length };
}

export async function validateWorkflow(amount: number): Promise<number> {
  if (amount < 0) throw ApplicationFailure.nonRetryable(`invalid amount ${amount}`);
  return amount;
}
