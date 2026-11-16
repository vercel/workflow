// Cloudflare Workflows input for the `workflow migrate cloudflare-workflows`
// round-trip test. The codemod's output is committed as
// workbench/vitest/workflows/cloudflare-workflows-migrated.ts, where it runs
// in-process. After editing this file, regenerate that one with
// UPDATE_CLOUDFLARE_FIXTURE=1 pnpm --filter @workflow/cli test cloudflare
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Env = { GREETING: string };
type LineItem = { sku: string; qty: number };
type OrderParams = { orderId: string; items: LineItem[] };

const TAX = 0.25;

async function priceOf(sku: string): Promise<number> {
  return ({ mug: 10, tee: 20, cap: 15 } as Record<string, number>)[sku] ?? 0;
}

async function reserve(sku: string, qty: number) {
  return { id: `res-${sku}-${qty}` };
}

// Captures, a loop, parallel steps, step config and a non-retryable error.
export class OrderWorkflow extends WorkflowEntrypoint<Env, OrderParams> {
  async run(event: WorkflowEvent<OrderParams>, step: WorkflowStep) {
    const { orderId, items } = event.payload;
    if (items.length === 0) {
      await step.do('reject empty order', async () => {
        throw new NonRetryableError(`order ${orderId} is empty`);
      });
    }
    const priced = await Promise.all(
      items.map((item) =>
        step.do(`price ${item.sku}`, async () => {
          const unit = await priceOf(item.sku);
          return { sku: item.sku, total: unit * item.qty * (1 + TAX) };
        })
      )
    );
    const reservations: string[] = [];
    for (const item of items) {
      const reservation = await step.do(`reserve ${item.sku}`, { retries: { limit: 2, delay: '1 second', backoff: 'constant' } }, async () =>
        reserve(item.sku, item.qty)
      );
      reservations.push(reservation.id);
    }
    const greeting = await step.do('greet', async () => `${this.env.GREETING} ${orderId}`);
    const total = priced.reduce((sum, line) => sum + line.total, 0);
    return { orderId, total, reservations, greeting };
  }
}

// waitForEvent: resumed, buffered before the wait, repeated, typed, and timed out.
export class ApprovalWorkflow extends WorkflowEntrypoint<Env, { mode: string }> {
  async run(event: WorkflowEvent<{ mode: string }>, step: WorkflowStep) {
    if (event.payload.mode === 'timeout') {
      try {
        await step.waitForEvent<{ ok: boolean }>('approval', { type: 'approved', timeout: '2 seconds' });
        return { timedOut: false };
      } catch (error) {
        const e = error as Error;
        return { timedOut: true, name: e.name, message: e.message };
      }
    }
    if (event.payload.mode === 'early') {
      // The event is sent while the run sleeps, before it waits.
      await step.sleep('let the event arrive first', '3 seconds');
    }
    const first = await step.waitForEvent<{ by: string }>('first approval', { type: 'approved', timeout: '1 minute' });
    if (event.payload.mode !== 'twice') {
      return { type: first.type, by: first.payload.by, hasTimestamp: first.timestamp instanceof Date };
    }
    // A second wait for the same type, and one for another type sent first.
    const second = await step.waitForEvent<{ by: string }>('second approval', { type: 'approved', timeout: '1 minute' });
    const note = await step.waitForEvent<{ text: string }>('note', { type: 'note', timeout: '1 minute' });
    return { approvers: [first.payload.by, second.payload.by], note: note.payload.text };
  }
}

// Retries: an explicit limit, the default limit, and ctx.attempt.
export class RetryWorkflow extends WorkflowEntrypoint<Env, { failures: number; limit?: number }> {
  async run(event: WorkflowEvent<{ failures: number; limit?: number }>, step: WorkflowStep) {
    const { failures } = event.payload;
    if (event.payload.limit === 1) {
      return step.do('limited', { retries: { limit: 1, delay: '1 second' } }, async (ctx) => {
        if (ctx.attempt <= failures) throw new Error(`attempt ${ctx.attempt} fails`);
        return { attempt: ctx.attempt, step: ctx.step.name };
      });
    }
    // No config: Cloudflare retries 5 times.
    return step.do('default retries', async (ctx) => {
      if (ctx.attempt <= failures) throw new Error(`attempt ${ctx.attempt} fails`);
      return { attempt: ctx.attempt, step: ctx.step.name };
    });
  }
}

// sleep and sleepUntil, with Cloudflare duration strings.
export class TimerWorkflow extends WorkflowEntrypoint<Env, { ms: number }> {
  async run(event: WorkflowEvent<{ ms: number }>, step: WorkflowStep) {
    const startedAt = await step.do('start', async () => Date.now());
    await step.sleep('short nap', '1 second');
    await step.sleep('numeric nap', event.payload.ms);
    await step.sleepUntil('until', new Date(startedAt + 3500));
    const elapsed = await step.do('measure', async () => Date.now() - startedAt);
    return { atLeast3s: elapsed >= 3000, under30s: elapsed < 30_000 };
  }
}
