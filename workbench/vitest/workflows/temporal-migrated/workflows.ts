// Temporal input for the `workflow migrate temporal` round-trip test. The
// codemod's output is committed as workbench/vitest/workflows/temporal-migrated/,
// where it runs in-process. After editing this file, regenerate that directory
// with UPDATE_TEMPORAL_FIXTURE=1 pnpm --filter @workflow/cli test temporal

import {
  createHook,
  FatalError,
  getWorkflowMetadata,
  type Hook,
  sleep,
} from 'workflow';
import { start } from 'workflow/api';
import {
  busyThenOk,
  failsOnce,
  flakyCharge,
  priceOf,
  rejectCard,
  reserve,
} from './activities';

const TAX = 0.25;

export const approveSignal = { type: 'signal', name: 'approve' } as const;
export const incrementSignal = { type: 'signal', name: 'increment' } as const;

type Item = { sku: string; qty: number };

// Parallel activities over captured items, a loop, a sleep.
export async function orderWorkflow(
  orderId: string,
  items: Item[]
): Promise<{ orderId: string; total: number; reservations: string[] }> {
  'use workflow';
  const prices = await Promise.all(items.map((item) => priceOf(item.sku)));
  const total = items.reduce(
    (sum, item, i) => sum + prices[i] * item.qty * (1 + TAX),
    0
  );
  const reservations: string[] = [];
  for (const item of items) {
    const r = await reserve(item.sku, item.qty);
    reservations.push(r.reservationId);
  }
  await sleep('1s');
  console.info('order done', { orderId });
  return { orderId, total, reservations };
}

// A signal and condition() with a timeout.
export async function approvalWorkflow(
  id: string,
  timeout: string
): Promise<{ id: string; status: string; by: string | null }> {
  'use workflow';
  const signals = new TemporalSignals();
  const approveSignalHook = signals.hook<[boolean, string]>(approveSignal.name);
  let approved: boolean | undefined;
  let by: string | null = null;
  signals.handle(approveSignalHook, (ok, who) => {
    approved = ok;
    by = who;
  });
  const decided = await signals.condition(
    () => approved !== undefined,
    () => sleep(timeout as '1m')
  );
  if (!decided) return { id, status: 'expired', by };
  return { id, status: approved ? 'approved' : 'rejected', by };
}

// Several signals, sent before the handler is set.
export async function counterWorkflow(
  target: number
): Promise<{ count: number; seen: number[] }> {
  'use workflow';
  const signals = new TemporalSignals();
  const incrementSignalHook = signals.hook<[number]>(incrementSignal.name);
  await sleep('500ms');
  let count = 0;
  const seen: number[] = [];
  signals.handle(incrementSignalHook, (by) => {
    count += by;
    seen.push(by);
  });
  await signals.condition(() => count >= target);
  return { count, seen };
}

// Retries: succeeds on the third attempt, fails with no retries, fatal error.
export async function retryWorkflow(
  orderId: string
): Promise<{ orderId: string; attempt: number }> {
  'use workflow';
  return flakyCharge(orderId);
}

export async function noRetryWorkflow(): Promise<string> {
  'use workflow';
  return failsOnce();
}

export async function fatalWorkflow(orderId: string): Promise<string> {
  'use workflow';
  await rejectCard(orderId);
  return 'unreachable';
}

export async function retryAfterWorkflow(): Promise<{ attempt: number }> {
  'use workflow';
  return busyThenOk();
}

// Child workflows, both ways.
export async function doubleWorkflow(n: number): Promise<{ doubled: number }> {
  'use workflow';
  return { doubled: n * 2 };
}

export async function parentWorkflow(
  n: number
): Promise<{ executed: { doubled: number }; started: { doubled: number } }> {
  'use workflow';
  const executed = await start(doubleWorkflow, [n]).then(
    (run) => run.returnValue
  );
  const handle = await start(doubleWorkflow, [n + 1]);
  const started = await handle.returnValue;
  return { executed, started };
}

// Patches, workflowInfo, uuid4, and a workflow-level failure.
export async function infoWorkflow(): Promise<{
  branch: string;
  type: string;
  uuidLength: number;
}> {
  'use workflow';
  const branch = 'v2';
  return {
    branch,
    type: getWorkflowMetadata().workflowName.replace(/^.*\//, ''),
    uuidLength: crypto.randomUUID().length,
  };
}

export async function validateWorkflow(amount: number): Promise<number> {
  'use workflow';
  if (amount < 0) throw new FatalError(`invalid amount ${amount}`);
  return amount;
}

/**
 * Temporal signals on Workflow SDK hooks. Each signal has a hook with the
 * token `${runId}:<signal name>`, created when the run starts so a signal
 * sent early waits in it. handle() runs the handler for each payload in
 * order (the payload is the signal's arguments array), and condition()
 * re-checks its predicate after each one.
 */
class TemporalSignals {
  private readonly runId = getWorkflowMetadata().workflowRunId;
  private waiters: Array<() => void> = [];

  hook<Args extends unknown[] = any[]>(name: string): Hook<Args> {
    return createHook<Args>({ token: `${this.runId}:${name}` });
  }

  handle<Args extends unknown[]>(
    hook: Hook<Args>,
    handler: (...args: Args) => unknown
  ): void {
    void (async () => {
      for await (const args of hook) {
        await handler(...args);
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
      }
    })();
  }

  async condition(
    fn: () => boolean,
    timeout?: () => Promise<void>
  ): Promise<boolean> {
    let expired: Promise<false> | undefined;
    while (!fn()) {
      expired ??= timeout?.().then(() => false as const);
      const changed = new Promise<true>((wake) =>
        this.waiters.push(() => wake(true))
      );
      if (
        (await (expired ? Promise.race([changed, expired]) : changed)) === false
      )
        return false;
    }
    return true;
  }
}
