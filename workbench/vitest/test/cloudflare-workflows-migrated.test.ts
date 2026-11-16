import { waitForSleep } from '@workflow/vitest';
import { beforeAll, describe, expect, it } from 'vitest';
import { FatalError } from 'workflow';
import { resumeHook, start } from 'workflow/api';
import { WorkflowRunFailedError } from 'workflow/errors';
import {
  ApprovalWorkflow,
  OrderWorkflow,
  RetryWorkflow,
  TimerWorkflow,
} from '../workflows/cloudflare-workflows-migrated.js';

// workflows/cloudflare-workflows-migrated.ts is the output of
// `workflow migrate cloudflare-workflows` for
// packages/cli/tests/fixture/cloudflare-workflows/workflows.ts. These tests run
// it the way the migration report's `workflowInstances()` adapter does: one
// run per instance ID, started with the `${workflow}:${id}` token, and events
// resumed on that token as `{ type, payload, timestamp }`.

const id = (name: string) => `${name}-${Math.random().toString(36).slice(2)}`;
const event = <P>(workflowName: string, instanceId: string, payload: P) => ({
  payload,
  timestamp: new Date(),
  instanceId,
  workflowName,
});
const create = <P>(
  workflow: (e: ReturnType<typeof event<P>>) => Promise<unknown>,
  workflowName: string,
  payload: P
) => {
  const instanceId = id(workflowName);
  const token = `${workflowName}:${instanceId}`;
  return start(workflow, [event(workflowName, instanceId, payload)], {
    experimental_hook: { token },
  }).then((run) => ({ run, token }));
};
const send = (token: string, type: string, payload: unknown) =>
  resumeHook(token, { type, payload, timestamp: new Date() });

beforeAll(() => {
  // A wrangler var, read with process.env inside the step.
  process.env.GREETING = 'hello';
});

describe('workflows migrated from Cloudflare Workflows by the codemod', () => {
  it('runs the lifted steps with their captured variables', async () => {
    const { run } = await create(OrderWorkflow, 'OrderWorkflow', {
      orderId: 'o1',
      items: [
        { sku: 'mug', qty: 2 },
        { sku: 'tee', qty: 1 },
      ],
    });
    await expect(run.returnValue).resolves.toEqual({
      orderId: 'o1',
      total: 50,
      reservations: ['res-mug-2', 'res-tee-1'],
      greeting: 'hello o1',
    });
  }, 60_000);

  it('fails without retrying where Cloudflare threw NonRetryableError', async () => {
    const { run } = await create(OrderWorkflow, 'OrderWorkflow', {
      orderId: 'o2',
      items: [],
    });
    const error = await run.returnValue.catch((e: unknown) => e);
    expect(WorkflowRunFailedError.is(error)).toBe(true);
    const cause = (error as WorkflowRunFailedError).cause;
    expect(FatalError.is(cause)).toBe(true);
    expect((cause as Error).message).toBe('order o2 is empty');
  }, 60_000);

  it('keeps events sent before the run waits, and takes them by type in arrival order', async () => {
    const { run, token } = await create(ApprovalWorkflow, 'ApprovalWorkflow', {
      mode: 'twice',
    });
    // All three arrive before the first wait; the note arrives first.
    await send(token, 'note', { text: 'ship it' });
    await send(token, 'approved', { by: 'ana' });
    await send(token, 'approved', { by: 'bo' });
    await expect(run.returnValue).resolves.toEqual({
      approvers: ['ana', 'bo'],
      note: 'ship it',
    });
  }, 60_000);

  it('returns the event with its type, payload and timestamp', async () => {
    const { run, token } = await create(ApprovalWorkflow, 'ApprovalWorkflow', {
      mode: 'now',
    });
    await send(token, 'approved', { by: 'ana' });
    await expect(run.returnValue).resolves.toEqual({
      type: 'approved',
      by: 'ana',
      hasTimestamp: true,
    });
  }, 60_000);

  it('throws a timeout error from a wait that times out, as Cloudflare does', async () => {
    const { run } = await create(ApprovalWorkflow, 'ApprovalWorkflow', {
      mode: 'timeout',
    });
    const timeout = await waitForSleep(run);
    await run.wakeUp({ correlationIds: [timeout] });
    await expect(run.returnValue).resolves.toEqual({
      timedOut: true,
      name: 'Error',
      message: 'WorkflowTimeoutError: Execution timed out after 2000ms',
    });
  }, 60_000);

  it('retries a step as often as its retries.limit allows', async () => {
    const { run } = await create(RetryWorkflow, 'RetryWorkflow', {
      failures: 1,
      limit: 1,
    });
    await expect(run.returnValue).resolves.toEqual({
      attempt: 2,
      step: 'limited',
    });
  }, 60_000);

  it("retries a step without config 5 times, Cloudflare's default", async () => {
    const { run } = await create(RetryWorkflow, 'RetryWorkflow', {
      failures: 5,
    });
    await expect(run.returnValue).resolves.toEqual({
      attempt: 6,
      step: 'default retries',
    });
  }, 90_000);

  it('sleeps for Cloudflare durations and until a date', async () => {
    const { run } = await create(TimerWorkflow, 'TimerWorkflow', { ms: 100 });
    await expect(run.returnValue).resolves.toEqual({
      atLeast3s: true,
      under30s: true,
    });
  }, 60_000);
});
