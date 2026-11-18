// Cloudflare Workflows input for the `workflow migrate cloudflare-workflows`
// round-trip test. The codemod's output is committed as
// workbench/vitest/workflows/cloudflare-workflows-migrated.ts, where it runs
// in-process. After editing this file, regenerate that one with
// UPDATE_CLOUDFLARE_FIXTURE=1 pnpm --filter @workflow/cli test cloudflare
import { createHook, FatalError, getStepMetadata, sleep } from 'workflow';

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
export async function OrderWorkflow(event: {
  payload: OrderParams;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
}) {
  'use workflow';
  const { orderId, items } = event.payload;
  if (items.length === 0) {
    await rejectEmptyOrder(orderId);
  }
  const priced = await Promise.all(items.map((item) => price(item)));
  const reservations: string[] = [];
  for (const item of items) {
    const reservation = await reserveStep(item);
    reservations.push(reservation.id);
  }
  const greeting = await greet(orderId);
  const total = priced.reduce((sum, line) => sum + line.total, 0);
  return { orderId, total, reservations, greeting };
}

async function rejectEmptyOrder(orderId: string) {
  'use step';
  throw new FatalError(`order ${orderId} is empty`);
}
rejectEmptyOrder.maxRetries = 5;

async function price(item: LineItem) {
  'use step';
  const unit = await priceOf(item.sku);
  return { sku: item.sku, total: unit * item.qty * (1 + TAX) };
}
price.maxRetries = 5;

async function reserveStep(item: LineItem) {
  'use step';
  return reserve(item.sku, item.qty);
}
reserveStep.maxRetries = 2;

async function greet(orderId: string) {
  'use step';
  return `${process.env.GREETING} ${orderId}`;
}
greet.maxRetries = 5;

// waitForEvent: resumed, buffered before the wait, repeated, typed, and timed out.
export async function ApprovalWorkflow(event: {
  payload: { mode: string };
  timestamp: Date;
  instanceId: string;
  workflowName: string;
}) {
  'use workflow';
  const events = workflowEvents(`ApprovalWorkflow:${event.instanceId}`);
  if (event.payload.mode === 'timeout') {
    try {
      await events.next<{ ok: boolean }>('approved', 2000);
      return { timedOut: false };
    } catch (error) {
      const e = error as Error;
      return { timedOut: true, name: e.name, message: e.message };
    }
  }
  if (event.payload.mode === 'early') {
    // The event is sent while the run sleeps, before it waits.
    await sleep('3 seconds');
  }
  const first = await events.next<{ by: string }>('approved', 60000);
  if (event.payload.mode !== 'twice') {
    return {
      type: first.type,
      by: first.payload.by,
      hasTimestamp: first.timestamp instanceof Date,
    };
  }
  // A second wait for the same type, and one for another type sent first.
  const second = await events.next<{ by: string }>('approved', 60000);
  const note = await events.next<{ text: string }>('note', 60000);
  return {
    approvers: [first.payload.by, second.payload.by],
    note: note.payload.text,
  };
}

// Retries: an explicit limit, the default limit, and ctx.attempt.
export async function RetryWorkflow(event: {
  payload: { failures: number; limit?: number };
  timestamp: Date;
  instanceId: string;
  workflowName: string;
}) {
  'use workflow';
  const { failures } = event.payload;
  if (event.payload.limit === 1) {
    return limited(failures);
  }
  // No config: Cloudflare retries 5 times.
  return defaultRetries(failures);
}

async function limited(failures: number) {
  'use step';
  if (getStepMetadata().attempt <= failures)
    throw new Error(`attempt ${getStepMetadata().attempt} fails`);
  return { attempt: getStepMetadata().attempt, step: 'limited' };
}
limited.maxRetries = 1;

async function defaultRetries(failures: number) {
  'use step';
  if (getStepMetadata().attempt <= failures)
    throw new Error(`attempt ${getStepMetadata().attempt} fails`);
  return { attempt: getStepMetadata().attempt, step: 'default retries' };
}
defaultRetries.maxRetries = 5;

// sleep and sleepUntil, with Cloudflare duration strings.
export async function TimerWorkflow(event: {
  payload: { ms: number };
  timestamp: Date;
  instanceId: string;
  workflowName: string;
}) {
  'use workflow';
  const startedAt = await startStep();
  await sleep('1 second');
  await sleep(cloudflareDuration(event.payload.ms));
  await sleep(new Date(startedAt + 3500));
  const elapsed = await measure(startedAt);
  return { atLeast3s: elapsed >= 3000, under30s: elapsed < 30_000 };
}

async function startStep() {
  'use step';
  return Date.now();
}
startStep.maxRetries = 5;

async function measure(startedAt: number) {
  'use step';
  return Date.now() - startedAt;
}
measure.maxRetries = 5;

/**
 * The run's events, taken by type in the order they arrived, as
 * Cloudflare's step.waitForEvent() takes them. Start the run with
 * start(workflow, [event], { experimental_hook: { token } }) so events
 * sent before the run waits are kept, and send them with
 * resumeHook(token, { type, payload, timestamp: new Date() }).
 */
function workflowEvents(token: string) {
  const events = createHook<{
    type: string;
    payload: unknown;
    timestamp: Date;
  }>({ token })[Symbol.asyncIterator]();
  const early: { type: string; payload: unknown; timestamp: Date }[] = [];
  let pending:
    | Promise<
        IteratorResult<{ type: string; payload: unknown; timestamp: Date }>
      >
    | undefined;
  const timedOut = {};
  return {
    async next<T = any>(
      type: string,
      timeoutMs: number
    ): Promise<{ type: string; payload: T; timestamp: Date }> {
      const index = early.findIndex((event) => event.type === type);
      if (index !== -1)
        return early.splice(index, 1)[0] as {
          type: string;
          payload: T;
          timestamp: Date;
        };
      const timeout = sleep(timeoutMs).then(() => timedOut);
      for (;;) {
        pending ??= events.next();
        const result = await Promise.race([pending, timeout]);
        if (result === timedOut) {
          throw new Error(
            `WorkflowTimeoutError: Execution timed out after ${timeoutMs}ms`
          );
        }
        pending = undefined;
        const next = result as IteratorResult<{
          type: string;
          payload: unknown;
          timestamp: Date;
        }>;
        if (next.done) throw new Error('The event hook closed');
        if (next.value.type === type)
          return next.value as { type: string; payload: T; timestamp: Date };
        early.push(next.value);
      }
    },
  };
}

/** A Cloudflare Workflows duration (milliseconds or "<n> <unit>"), in milliseconds. */
function cloudflareDuration(duration: number | string): number {
  if (typeof duration === 'number') return duration;
  const units: Record<string, number> = {
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2592000000,
    year: 31557600000,
  };
  const match =
    /^\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week|month|year)s?\s*$/.exec(
      duration
    );
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  return Number(match[1]) * units[match[2]];
}
