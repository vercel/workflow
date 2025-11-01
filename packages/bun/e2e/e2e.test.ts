import { dehydrateWorkflowArguments } from '@workflow/core/serialization';
import { describe, expect, test } from 'vitest';

const deploymentUrl = process.env.DEPLOYMENT_URL || 'http://localhost:3000';

async function triggerWorkflow(
  workflow: string | { workflowFile: string; workflowFn: string },
  args: any[]
): Promise<{ runId: string }> {
  const url = new URL('/api/trigger', deploymentUrl);
  const workflowFn =
    typeof workflow === 'string' ? workflow : workflow.workflowFn;
  const workflowFile =
    typeof workflow === 'string'
      ? 'workflows/99_e2e.ts'
      : workflow.workflowFile;

  url.searchParams.set('workflowFile', workflowFile);
  url.searchParams.set('workflowFn', workflowFn);
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(dehydrateWorkflowArguments(args, [], globalThis)),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to trigger workflow: ${res.url} ${res.status}: ${await res.text()}`
    );
  }
  const run = await res.json();
  return run;
}

async function getWorkflowReturnValue(runId: string) {
  // Poll the GET endpoint until the workflow run is completed
  while (true) {
    const url = new URL('/api/trigger', deploymentUrl);
    url.searchParams.set('runId', runId);

    const res = await fetch(url);

    if (res.status === 202) {
      // Workflow run is still running, wait and poll again
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    const contentType = res.headers.get('Content-Type');

    if (contentType?.includes('application/json')) {
      return await res.json();
    }

    if (contentType?.includes('application/octet-stream')) {
      return res.body;
    }

    throw new Error(`Unexpected content type: ${contentType}`);
  }
}

describe('bun workbench e2e', () => {
  test('calc workflow (0_demo.ts)', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow(
      { workflowFile: 'workflows/0_calc.ts', workflowFn: 'calc' },
      [2]
    );
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe(4);
  });

  test('addTenWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow(
      { workflowFile: 'workflows/99_e2e.ts', workflowFn: 'addTenWorkflow' },
      [123]
    );
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe(133);
  });

  test('promiseAllWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('promiseAllWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe('ABC');
  });

  test('promiseRaceWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('promiseRaceWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe('B');
  });

  test('hookWorkflow', { timeout: 60_000 }, async () => {
    const token = Math.random().toString(36).slice(2);
    const customData = Math.random().toString(36).slice(2);

    const run = await triggerWorkflow('hookWorkflow', [token, customData]);

    // Wait for webhook to be registered
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const hookUrl = new URL('/api/hook', deploymentUrl);

    let res = await fetch(hookUrl, {
      method: 'POST',
      body: JSON.stringify({ token, data: { message: 'one' } }),
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.runId).toBe(run.runId);

    // Invalid token test
    res = await fetch(hookUrl, {
      method: 'POST',
      body: JSON.stringify({ token: 'invalid' }),
    });
    expect(res.status).toBe(404);
    body = await res.json();
    expect(body).toBeNull();

    res = await fetch(hookUrl, {
      method: 'POST',
      body: JSON.stringify({ token, data: { message: 'two' } }),
    });
    expect(res.status).toBe(200);

    res = await fetch(hookUrl, {
      method: 'POST',
      body: JSON.stringify({ token, data: { message: 'three', done: true } }),
    });
    expect(res.status).toBe(200);

    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBeInstanceOf(Array);
    expect(returnValue.length).toBe(3);
    expect(returnValue[0].message).toBe('one');
    expect(returnValue[0].customData).toBe(customData);
    expect(returnValue[1].message).toBe('two');
    expect(returnValue[2].message).toBe('three');
    expect(returnValue[2].done).toBe(true);
  });

  test('webhookWorkflow', { timeout: 60_000 }, async () => {
    const token = Math.random().toString(36).slice(2);
    const token2 = Math.random().toString(36).slice(2);
    const token3 = Math.random().toString(36).slice(2);

    const run = await triggerWorkflow('webhookWorkflow', [
      token,
      token2,
      token3,
    ]);

    // Wait for webhooks to be registered
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // Webhook with default response
    const res = await fetch(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token)}`,
        deploymentUrl
      ),
      {
        method: 'POST',
        body: JSON.stringify({ message: 'one' }),
      }
    );
    expect(res.status).toBe(202);

    // Webhook with static response
    const res2 = await fetch(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token2)}`,
        deploymentUrl
      ),
      {
        method: 'POST',
        body: JSON.stringify({ message: 'two' }),
      }
    );
    expect(res2.status).toBe(402);

    // Webhook with manual response
    const res3 = await fetch(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token3)}`,
        deploymentUrl
      ),
      {
        method: 'POST',
        body: JSON.stringify({ message: 'three' }),
      }
    );
    expect(res3.status).toBe(200);

    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toHaveLength(3);
    expect(returnValue[0].method).toBe('POST');
    expect(returnValue[1].method).toBe('POST');
    expect(returnValue[2].method).toBe('POST');
  });

  test('webhook route with invalid token', { timeout: 60_000 }, async () => {
    const invalidWebhookUrl = new URL(
      `/.well-known/workflow/v1/webhook/${encodeURIComponent('invalid')}`,
      deploymentUrl
    );
    const res = await fetch(invalidWebhookUrl, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test('sleepingWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('sleepingWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue.startTime).toBeLessThan(returnValue.endTime);
    expect(returnValue.endTime - returnValue.startTime).toBeGreaterThan(9999);
  });
});
