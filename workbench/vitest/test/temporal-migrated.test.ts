import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { FatalError } from 'workflow';
import { resumeHook, start } from 'workflow/api';
import { WorkflowRunFailedError } from 'workflow/errors';
import {
  approvalWorkflow,
  counterWorkflow,
  fatalWorkflow,
  infoWorkflow,
  noRetryWorkflow,
  orderWorkflow,
  parentWorkflow,
  retryAfterWorkflow,
  retryWorkflow,
  validateWorkflow,
} from '../workflows/temporal-migrated/workflows.js';

// workflows/temporal-migrated/ is the output of `workflow migrate temporal`
// for packages/cli/tests/fixture/temporal/order/. These tests prove the
// codemod's output runs: activities run as steps with the retry policy the
// proxies set, signals arrive through hooks (including ones sent before the
// handler is set), condition() waits and times out, child workflows return,
// and failures keep their Temporal meaning.

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(WorkflowRunFailedError.is(error)).toBe(true);
  return (error as WorkflowRunFailedError).cause as Error;
};

describe('workflows migrated from Temporal by the codemod', () => {
  it('runs activities in parallel and in a loop', async () => {
    const run = await start(orderWorkflow, [
      'o1',
      [
        { sku: 'mug', qty: 2 },
        { sku: 'tee', qty: 1 },
      ],
    ]);
    await expect(run.returnValue).resolves.toEqual({
      orderId: 'o1',
      total: 50,
      reservations: ['res-mug-2', 'res-tee-1'],
    });
  }, 60_000);

  it('delivers a signal to the handler and wakes condition()', async () => {
    const run = await start(approvalWorkflow, ['a1', '1m']);
    const token = `${run.runId}:approve`;
    await waitForHook(run, { token });
    await resumeHook(token, [true, 'ana']);
    await expect(run.returnValue).resolves.toEqual({
      id: 'a1',
      status: 'approved',
      by: 'ana',
    });
  }, 60_000);

  it('times condition() out', async () => {
    const run = await start(approvalWorkflow, ['a2', '1h']);
    await waitForHook(run, { token: `${run.runId}:approve` });
    await run.wakeUp({ correlationIds: [await waitForSleep(run)] });
    await expect(run.returnValue).resolves.toEqual({
      id: 'a2',
      status: 'expired',
      by: null,
    });
  }, 60_000);

  it('keeps signals sent before the handler is set, in order', async () => {
    const run = await start(counterWorkflow, [3]);
    const token = `${run.runId}:increment`;
    await waitForHook(run, { token });
    // The workflow is still in its first sleep: no handler yet.
    await resumeHook(token, [1]);
    await resumeHook(token, [2]);
    await expect(run.returnValue).resolves.toEqual({ count: 3, seen: [1, 2] });
  }, 60_000);

  it('retries an activity up to maximumAttempts', async () => {
    const run = await start(retryWorkflow, ['o2']);
    await expect(run.returnValue).resolves.toEqual({
      orderId: 'o2',
      attempt: 3,
    });
  }, 60_000);

  it('does not retry where maximumAttempts is 1', async () => {
    const cause = await failure((await start(noRetryWorkflow, [])).returnValue);
    expect(String(cause.message)).toContain('first attempt fails');
  }, 60_000);

  it('fails without retry on a non-retryable ApplicationFailure', async () => {
    const cause = await failure(
      (await start(fatalWorkflow, ['o3'])).returnValue
    );
    expect(FatalError.is(cause)).toBe(true);
    expect(cause.message).toBe('card declined for o3');
  }, 60_000);

  it('retries after nextRetryDelay', async () => {
    const run = await start(retryAfterWorkflow, []);
    await expect(run.returnValue).resolves.toEqual({ attempt: 2 });
  }, 60_000);

  it('runs child workflows started both ways', async () => {
    const run = await start(parentWorkflow, [4]);
    await expect(run.returnValue).resolves.toEqual({
      executed: { doubled: 8 },
      started: { doubled: 10 },
    });
  }, 60_000);

  it('maps patched(), workflowInfo() and uuid4()', async () => {
    const run = await start(infoWorkflow, []);
    await expect(run.returnValue).resolves.toEqual({
      branch: 'v2',
      type: 'infoWorkflow',
      uuidLength: 36,
    });
  }, 60_000);

  it('fails the run on a workflow-level ApplicationFailure', async () => {
    const cause = await failure(
      (await start(validateWorkflow, [-1])).returnValue
    );
    expect(cause.message).toBe('invalid amount -1');
    await expect(
      (await start(validateWorkflow, [5])).returnValue
    ).resolves.toBe(5);
  }, 60_000);
});
