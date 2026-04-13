import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeWebhook, start } from 'workflow/api';
import { sagaWorkflow } from '../workflows/cookbook/saga.js';
import { batchWorkflow } from '../workflows/cookbook/batching.js';
import { rateLimitWorkflow } from '../workflows/cookbook/rate-limiting.js';
import { fanOutWorkflow } from '../workflows/cookbook/fan-out.js';
import { schedulingWorkflow } from '../workflows/cookbook/scheduling.js';
import { idempotencyWorkflow } from '../workflows/cookbook/idempotency.js';
import { webhooksWorkflow } from '../workflows/cookbook/webhooks.js';
import { contentRouterWorkflow } from '../workflows/cookbook/content-router.js';
import {
  parentWorkflow,
  childWorkflow,
} from '../workflows/cookbook/child-workflows.js';

describe('saga', () => {
  it('should run compensations in reverse on FatalError', async () => {
    const run = await start(sagaWorkflow, ['order-1']);
    const result = await run.returnValue;
    expect(result).toEqual({ status: 'rolled_back' });
  });
});

describe('batching', () => {
  it('should process items in parallel batches', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const run = await start(batchWorkflow, [items, 2]);

    // Wake up sleeps between batches
    const sleep1 = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleep1] });

    const sleep2 = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleep2] });

    const result = await run.returnValue;
    expect(result).toEqual({ total: 5, succeeded: 5, failed: 0 });
  });
});

describe('rate-limiting', () => {
  it('should complete after RetryableError triggers retry', async () => {
    const run = await start(rateLimitWorkflow, ['contact-1']);
    const result = await run.returnValue;
    expect(result).toEqual({ contactId: 'contact-1', status: 'synced' });
  });
});

describe('fan-out', () => {
  it('should notify multiple channels in parallel', async () => {
    const run = await start(fanOutWorkflow, ['inc-1', 'Server down']);
    const result = await run.returnValue;
    expect(result).toEqual({ incidentId: 'inc-1', delivered: 3, failed: 0 });
  });
});

describe('scheduling', () => {
  it('should pause on sleep and resume after wakeUp', async () => {
    const run = await start(schedulingWorkflow, ['user@test.com']);

    const sleepId = await waitForSleep(run);
    expect(sleepId).toBeTypeOf('string');
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ email: 'user@test.com', status: 'completed' });
  });
});

describe('idempotency', () => {
  it('should return consistent result with stepId as idempotency key', async () => {
    const run = await start(idempotencyWorkflow, ['cust-1', 5000]);
    const result = await run.returnValue;
    expect(result.customerId).toBe('cust-1');
    expect(result.chargeId).toBe('charge-cust-1');
    expect(result.idempotencyKey).toBeTypeOf('string');
    expect(result.idempotencyKey.length).toBeGreaterThan(0);
  });
});

describe('webhooks', () => {
  it('should suspend on webhook and complete when resumed', async () => {
    const run = await start(webhooksWorkflow, ['order-1']);

    const hook = await waitForHook(run);

    await resumeWebhook(
      hook.token,
      new Request('https://example.com/webhook', {
        method: 'POST',
        body: JSON.stringify({ event: 'payment.completed' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await run.returnValue;
    expect(result).toEqual({ orderId: 'order-1', event: 'payment.completed' });
  });
});

describe('content-router', () => {
  it('should route billing tickets to billing handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-1', 'Invoice issue']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-1',
      routedTo: 'billing',
      result: 'handled-billing',
    });
  });

  it('should route technical tickets to technical handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-2', 'Bug in dashboard']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-2',
      routedTo: 'technical',
      result: 'handled-technical',
    });
  });

  it('should route unknown tickets to general handler', async () => {
    const run = await start(contentRouterWorkflow, ['t-3', 'Hello there']);
    const result = await run.returnValue;
    expect(result).toEqual({
      ticketId: 't-3',
      routedTo: 'general',
      result: 'handled-general',
    });
  });
});

describe('child-workflows', () => {
  it('should spawn a child workflow via start() and collect its result', async () => {
    const run = await start(parentWorkflow, ['x']);

    const result = await run.returnValue;
    expect(result.childRunId).toMatch(/^wrun_/);
    expect(result.result).toEqual({ item: 'x', result: 'processed-x' });
  });
});
