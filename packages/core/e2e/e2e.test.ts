import { assert, describe, expect, test } from 'vitest';
import { dehydrateWorkflowArguments } from '../src/serialization';
import { cliInspectJson } from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

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
  // We need to poll the GET endpoint until the workflow run is completed.
  // TODO: make this more efficient when we add subscription support.
  while (true) {
    const url = new URL('/api/trigger', deploymentUrl);
    url.searchParams.set('runId', runId);

    const res = await fetch(url);

    if (res.status === 202) {
      // Workflow run is still running, so we need to wait and poll again
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

// NOTE: Temporarily disabling concurrent tests to avoid flakiness.
// TODO: Re-enable concurrent tests after conf when we have more time to investigate.
describe('e2e', () => {
  test.each([
    {
      workflowFile: 'workflows/99_e2e.ts',
      workflowFn: 'addTenWorkflow',
    },
    {
      workflowFile: 'workflows/98_duplicate_case.ts',
      workflowFn: 'addTenWorkflow',
    },
  ])('addTenWorkflow', { timeout: 60_000 }, async (workflow) => {
    const run = await triggerWorkflow(workflow, [123]);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe(133);

    const { json } = await cliInspectJson(`runs ${run.runId} --withData`);
    expect(json).toMatchObject({
      runId: run.runId,
      workflowName: expect.any(String),
      status: 'completed',
      input: [123],
      output: 133,
    });
    // In local vs. vercel backends, the workflow name is different, so we check for either,
    // since this test runs against both.
    expect(json.workflowName).toBeOneOf([
      `workflow//example/${workflow.workflowFile}//${workflow.workflowFn}`,
      `workflow//${workflow.workflowFile}//${workflow.workflowFn}`,
    ]);
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

  test('promiseAnyWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('promiseAnyWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe('B');
  });

  test('readableStreamWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('readableStreamWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBeInstanceOf(ReadableStream);

    const decoder = new TextDecoder();
    let contents = '';
    for await (const chunk of returnValue) {
      const text = decoder.decode(chunk, { stream: true });
      contents += text;
    }
    expect(contents).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
  });

  test('hookWorkflow', { timeout: 60_000 }, async () => {
    const token = Math.random().toString(36).slice(2);
    const customData = Math.random().toString(36).slice(2);

    const run = await triggerWorkflow('hookWorkflow', [token, customData]);

    // Wait a few seconds so that the webhook is registered.
    // TODO: make this more efficient when we add subscription support.
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
    body = await res.json();
    expect(body.runId).toBe(run.runId);

    res = await fetch(hookUrl, {
      method: 'POST',
      body: JSON.stringify({ token, data: { message: 'three', done: true } }),
    });
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.runId).toBe(run.runId);

    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBeInstanceOf(Array);
    expect(returnValue.length).toBe(3);
    expect(returnValue[0].message).toBe('one');
    expect(returnValue[0].customData).toBe(customData);
    expect(returnValue[0].done).toBeUndefined();
    expect(returnValue[1].message).toBe('two');
    expect(returnValue[1].customData).toBe(customData);
    expect(returnValue[1].done).toBeUndefined();
    expect(returnValue[2].message).toBe('three');
    expect(returnValue[2].customData).toBe(customData);
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

    // Wait a few seconds so that the webhooks are registered.
    // TODO: make this more efficient when we add subscription support.
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
    const body = await res.text();
    expect(body).toBe('');

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
    const body2 = await res2.text();
    expect(body2).toBe('Hello from static response!');

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
    const body3 = await res3.text();
    expect(body3).toBe('Hello from webhook!');

    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toHaveLength(3);
    expect(returnValue[0].url).toBe(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token)}`,
        deploymentUrl
      ).href
    );
    expect(returnValue[0].method).toBe('POST');
    expect(returnValue[0].body).toBe('{"message":"one"}');

    expect(returnValue[1].url).toBe(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token2)}`,
        deploymentUrl
      ).href
    );
    expect(returnValue[1].method).toBe('POST');
    expect(returnValue[1].body).toBe('{"message":"two"}');

    expect(returnValue[2].url).toBe(
      new URL(
        `/.well-known/workflow/v1/webhook/${encodeURIComponent(token3)}`,
        deploymentUrl
      ).href
    );
    expect(returnValue[2].method).toBe('POST');
    expect(returnValue[2].body).toBe('{"message":"three"}');
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
    const body = await res.text();
    expect(body).toBe('');
  });

  test('sleepingWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('sleepingWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue.startTime).toBeLessThan(returnValue.endTime);
    expect(returnValue.endTime - returnValue.startTime).toBeGreaterThan(9999);
  });

  test('sleepingDateWorkflow', { timeout: 60_000 }, async () => {
    const endDate = new Date(Date.now() + 30_000);
    const run = await triggerWorkflow('sleepingDateWorkflow', [endDate]);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue.startTime).toBeLessThan(returnValue.endTime);
    expect(returnValue.endTime).toBeGreaterThanOrEqual(endDate.getTime());
  });

  test('nullByteWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('nullByteWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toBe('null byte \0');
  });

  test('workflowAndStepMetadataWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('workflowAndStepMetadataWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);

    expect(returnValue).toHaveProperty('workflowMetadata');
    expect(returnValue).toHaveProperty('stepMetadata');
    expect(returnValue).toHaveProperty('innerWorkflowMetadata');

    // workflow and context

    expect(returnValue.workflowMetadata).toStrictEqual(
      returnValue.innerWorkflowMetadata
    );

    // workflow context should have workflowRunId and stepMetadata shouldn't
    expect(returnValue.workflowMetadata.workflowRunId).toBe(run.runId);
    expect(returnValue.innerWorkflowMetadata.workflowRunId).toBe(run.runId);
    expect(returnValue.stepMetadata.workflowRunId).toBeUndefined();

    // workflow context should have workflowStartedAt and stepMetadata shouldn't
    expect(typeof returnValue.workflowMetadata.workflowStartedAt).toBe(
      'string'
    );
    expect(typeof returnValue.innerWorkflowMetadata.workflowStartedAt).toBe(
      'string'
    );
    expect(returnValue.innerWorkflowMetadata.workflowStartedAt).toBe(
      returnValue.workflowMetadata.workflowStartedAt
    );
    expect(returnValue.stepMetadata.workflowStartedAt).toBeUndefined();

    // workflow context should have url and stepMetadata shouldn't
    expect(typeof returnValue.workflowMetadata.url).toBe('string');
    expect(typeof returnValue.innerWorkflowMetadata.url).toBe('string');
    expect(returnValue.innerWorkflowMetadata.url).toBe(
      returnValue.workflowMetadata.url
    );
    expect(returnValue.stepMetadata.url).toBeUndefined();

    // workflow context shouldn't have stepId, stepStartedAt, or attempt
    expect(returnValue.workflowMetadata.stepId).toBeUndefined();
    expect(returnValue.workflowMetadata.stepStartedAt).toBeUndefined();
    expect(returnValue.workflowMetadata.attempt).toBeUndefined();

    // step context

    // Attempt should be atleast 1
    expect(returnValue.stepMetadata.attempt).toBeGreaterThanOrEqual(1);

    // stepStartedAt should be a Date
    expect(typeof returnValue.stepMetadata.stepStartedAt).toBe('string');
  });

  test('outputStreamWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('outputStreamWorkflow', []);
    const stream = await fetch(
      `${deploymentUrl}/api/trigger?runId=${run.runId}&output-stream=1`
    );
    const namedStream = await fetch(
      `${deploymentUrl}/api/trigger?runId=${run.runId}&output-stream=test`
    );
    const textDecoderStream = new TextDecoderStream();
    stream.body?.pipeThrough(textDecoderStream);
    const reader = textDecoderStream.readable.getReader();

    const namedTextDecoderStream = new TextDecoderStream();
    namedStream.body?.pipeThrough(namedTextDecoderStream);
    const namedReader = namedTextDecoderStream.readable.getReader();

    const r1 = await reader.read();
    assert(r1.value);
    const chunk1 = JSON.parse(r1.value);
    const binaryData = Buffer.from(chunk1.data, 'base64');
    expect(binaryData.toString()).toEqual('Hello, world!');

    const r1Named = await namedReader.read();
    assert(r1Named.value);
    const chunk1Named = JSON.parse(r1Named.value);
    const binaryDataNamed = Buffer.from(chunk1Named.data, 'base64');
    expect(binaryDataNamed.toString()).toEqual('Hello, named stream!');

    const r2 = await reader.read();
    assert(r2.value);
    const chunk2 = JSON.parse(r2.value);
    expect(chunk2).toEqual({ foo: 'test' });

    const r2Named = await namedReader.read();
    assert(r2Named.value);
    const chunk2Named = JSON.parse(r2Named.value);
    expect(chunk2Named).toEqual({ foo: 'bar' });

    const r3 = await reader.read();
    expect(r3.done).toBe(true);

    const r3Named = await namedReader.read();
    expect(r3Named.done).toBe(true);

    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toEqual('done');
  });

  test('fetchWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('fetchWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toMatchObject({
      userId: 1,
      id: 1,
      title: 'delectus aut autem',
      completed: false,
    });
  });

  test('promiseRaceStressTestWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('promiseRaceStressTestWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue).toEqual([0, 1, 2, 3, 4]);
  });

  test('retryAttemptCounterWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('retryAttemptCounterWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);

    // The step should have succeeded on attempt 3
    expect(returnValue).toEqual({ finalAttempt: 3 });

    // Also verify the run data shows the correct output
    const { json: runData } = await cliInspectJson(
      `runs ${run.runId} --withData`
    );
    expect(runData).toMatchObject({
      runId: run.runId,
      status: 'completed',
      output: { finalAttempt: 3 },
    });

    // Query steps separately to verify the step data
    const { json: stepsData } = await cliInspectJson(
      `steps --runId ${run.runId} --withData`
    );
    expect(stepsData).toBeDefined();
    expect(Array.isArray(stepsData)).toBe(true);
    expect(stepsData.length).toBeGreaterThan(0);

    // Find the stepThatRetriesAndSucceeds step
    const retryStep = stepsData.find((s: any) =>
      s.stepName.includes('stepThatRetriesAndSucceeds')
    );
    expect(retryStep).toBeDefined();
    expect(retryStep.status).toBe('completed');
    expect(retryStep.attempt).toBe(3);
    expect(retryStep.output).toEqual([3]);
  });

  test('retryableAndFatalErrorWorkflow', { timeout: 60_000 }, async () => {
    const run = await triggerWorkflow('retryableAndFatalErrorWorkflow', []);
    const returnValue = await getWorkflowReturnValue(run.runId);
    expect(returnValue.retryableResult.attempt).toEqual(2);
    expect(returnValue.retryableResult.duration).toBeGreaterThan(10_000);
    expect(returnValue.gotFatalError).toBe(true);
  });
});
