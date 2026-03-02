import { describe, expect, it } from 'vitest';
import { getRun, resumeHook, start } from 'workflow/api';
import { waitForHook, waitForSleep } from 'workflow/vitest';
import { calculateWorkflow } from '../workflows/simple.js';
import { hookWorkflow } from '../workflows/hooks.js';
import { sleepingWorkflow } from '../workflows/sleeping.js';
import { webhookWorkflow } from '../workflows/webhook.js';

describe('simple workflow', () => {
  it('should run calculateWorkflow and return correct result', async () => {
    const run = await start(calculateWorkflow, [2, 7]);

    expect(run).toBeDefined();
    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;

    expect(result).toEqual({
      sum: 9,
      product: 14,
      combined: 23,
    });
  });
});

describe('sleeping workflow', () => {
  it('should complete after waking up from sleep', async () => {
    const run = await start(sleepingWorkflow, ['test-input']);

    await waitForSleep(run);
    await getRun(run.runId).wakeUp();

    const result = await run.returnValue;
    expect(result).toBe('finalized:prepared:test-input');
  });
});

describe('hook workflow', () => {
  it('should resume when hook is resolved with approval', async () => {
    const run = await start(hookWorkflow, ['doc-1']);

    const hook = await waitForHook(run, { token: 'approval:doc-1' });
    expect(hook.token).toBe('approval:doc-1');

    await resumeHook('approval:doc-1', {
      approved: true,
      reviewer: 'alice',
    });

    const result = await run.returnValue;
    expect(result).toEqual({ status: 'approved', reviewer: 'alice' });
  });

  it('should resume when hook is resolved with rejection', async () => {
    const run = await start(hookWorkflow, ['doc-2']);

    await waitForHook(run, { token: 'approval:doc-2' });

    await resumeHook('approval:doc-2', {
      approved: false,
      reviewer: 'bob',
    });

    const result = await run.returnValue;
    expect(result).toEqual({ status: 'rejected', reviewer: 'bob' });
  });
});

describe('webhook workflow', () => {
  it('should resume when webhook receives data via resumeHook', async () => {
    const run = await start(webhookWorkflow, ['endpoint-1']);

    await waitForHook(run, { token: 'webhook:endpoint-1' });

    // In vitest, webhooks are resumed using resumeHook with a Request object.
    // The webhook is fundamentally a hook with Request as its payload type.
    await resumeHook(
      'webhook:endpoint-1',
      new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ event: 'payment.completed', amount: 99 }),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await run.returnValue;
    expect(result).toEqual({
      endpointId: 'endpoint-1',
      received: { event: 'payment.completed', amount: 99 },
    });
  });
});
