import { withResolvers } from '@workflow/utils';
import { assert, describe, expect, test } from 'vitest';
import { dehydrateWorkflowArguments } from '../src/serialization';
import { cliInspectJson, isLocalDeployment } from './utils';

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

  const ops: Promise<void>[] = [];
  const { promise: runIdPromise, resolve: resolveRunId } =
    withResolvers<string>();
  const dehydratedArgs = dehydrateWorkflowArguments(args, ops, runIdPromise);

  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(dehydratedArgs),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to trigger workflow: ${res.url} ${
        res.status
      }: ${await res.text()}`
    );
  }
  const run = await res.json();
  resolveRunId(run.runId);

  // Resolve and wait for any stream operations
  await Promise.all(ops);

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
    // since this test runs against both. Also different workbenches have different directory structures.
    expect(json.workflowName).toBeOneOf([
      `workflow//example/${workflow.workflowFile}//${workflow.workflowFn}`,
      `workflow//${workflow.workflowFile}//${workflow.workflowFn}`,
      `workflow//src/${workflow.workflowFile}//${workflow.workflowFn}`,
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
    // NOTE: For Nitro apps (Vite, Hono, etc.) in dev mode, status 404 does some
    // unexpected stuff and could return a Vite SPA fallback or can cause a Hono route to hang.
    // This is because Nitro passes the 404 requests to the dev server to handle.
    expect(res.status).toBeOneOf([404, 422]);
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

  test(
    'outputStreamInsideStepWorkflow - getWritable() called inside step functions',
    { timeout: 60_000 },
    async () => {
      const run = await triggerWorkflow('outputStreamInsideStepWorkflow', []);
      const stream = await fetch(
        `${deploymentUrl}/api/trigger?runId=${run.runId}&output-stream=1`
      );
      const namedStream = await fetch(
        `${deploymentUrl}/api/trigger?runId=${run.runId}&output-stream=step-ns`
      );
      const textDecoderStream = new TextDecoderStream();
      stream.body?.pipeThrough(textDecoderStream);
      const reader = textDecoderStream.readable.getReader();

      const namedTextDecoderStream = new TextDecoderStream();
      namedStream.body?.pipeThrough(namedTextDecoderStream);
      const namedReader = namedTextDecoderStream.readable.getReader();

      // First message from default stream
      const r1 = await reader.read();
      assert(r1.value);
      const chunk1 = JSON.parse(r1.value);
      const binaryData1 = Buffer.from(chunk1.data, 'base64');
      expect(binaryData1.toString()).toEqual('Hello from step!');

      // First message from named stream
      const r1Named = await namedReader.read();
      assert(r1Named.value);
      const chunk1Named = JSON.parse(r1Named.value);
      expect(chunk1Named).toEqual({
        message: 'Hello from named stream in step!',
      });

      // Second message from default stream
      const r2 = await reader.read();
      assert(r2.value);
      const chunk2 = JSON.parse(r2.value);
      const binaryData2 = Buffer.from(chunk2.data, 'base64');
      expect(binaryData2.toString()).toEqual('Second message');

      // Second message from named stream
      const r2Named = await namedReader.read();
      assert(r2Named.value);
      const chunk2Named = JSON.parse(r2Named.value);
      expect(chunk2Named).toEqual({ counter: 42 });

      // Verify streams are closed
      const r3 = await reader.read();
      expect(r3.done).toBe(true);

      const r3Named = await namedReader.read();
      expect(r3Named.done).toBe(true);

      const returnValue = await getWorkflowReturnValue(run.runId);
      expect(returnValue).toEqual('done');
    }
  );

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

  test(
    'stepDirectCallWorkflow - calling step functions directly outside workflow context',
    { timeout: 60_000 },
    async () => {
      // Call the API route that directly calls a step function (no workflow context)
      const url = new URL('/api/test-direct-step-call', deploymentUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 3, y: 5 }),
      });

      if (!res.ok) {
        throw new Error(
          `Failed to call step function directly: ${res.url} ${
            res.status
          }: ${await res.text()}`
        );
      }

      const { result } = await res.json();

      // Expected: add(3, 5) = 8
      expect(result).toBe(8);
    }
  );

  test(
    'crossFileErrorWorkflow - stack traces work across imported modules',
    { timeout: 60_000 },
    async () => {
      // This workflow intentionally throws an error from an imported helper module
      // to verify that stack traces correctly show cross-file call chains
      const run = await triggerWorkflow('crossFileErrorWorkflow', []);
      const returnValue = await getWorkflowReturnValue(run.runId);

      // The workflow should fail with error response containing both top-level and cause
      expect(returnValue).toHaveProperty('name');
      expect(returnValue.name).toBe('WorkflowRunFailedError');
      expect(returnValue).toHaveProperty('message');

      // Verify the cause property contains the structured error
      expect(returnValue).toHaveProperty('cause');
      expect(returnValue.cause).toBeTypeOf('object');
      expect(returnValue.cause).toHaveProperty('message');
      expect(returnValue.cause.message).toContain(
        'Error from imported helper module'
      );

      // Verify the stack trace is present in the cause
      expect(returnValue.cause).toHaveProperty('stack');
      expect(typeof returnValue.cause.stack).toBe('string');

      // Known issue: vite-based frameworks dev mode has incorrect source map mappings for bundled imports.
      // esbuild with bundle:true inlines helpers.ts but source maps incorrectly map to 99_e2e.ts
      // This works correctly in production and other frameworks.
      // TODO: Investigate esbuild source map generation for bundled modules
      const isViteBasedFrameworkDevMode =
        (process.env.APP_NAME === 'sveltekit' ||
          process.env.APP_NAME === 'vite' ||
          process.env.APP_NAME === 'astro') &&
        isLocalDeployment();

      if (!isViteBasedFrameworkDevMode) {
        // Stack trace should include frames from the helper module (helpers.ts)
        expect(returnValue.cause.stack).toContain('helpers.ts');
      }

      // These checks should work in all modes
      expect(returnValue.cause.stack).toContain('throwError');
      expect(returnValue.cause.stack).toContain('callThrower');

      // Stack trace should include frames from the workflow file (99_e2e.ts)
      expect(returnValue.cause.stack).toContain('99_e2e.ts');
      expect(returnValue.cause.stack).toContain('crossFileErrorWorkflow');

      // Stack trace should NOT contain 'evalmachine' anywhere
      expect(returnValue.cause.stack).not.toContain('evalmachine');

      // Verify the run failed with structured error
      const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
      expect(runData.status).toBe('failed');
      expect(runData.error).toBeTypeOf('object');
      expect(runData.error.message).toContain(
        'Error from imported helper module'
      );
    }
  );

  test(
    'hookCleanupTestWorkflow - hook token reuse after workflow completion',
    { timeout: 60_000 },
    async () => {
      const token = Math.random().toString(36).slice(2);
      const customData = Math.random().toString(36).slice(2);

      // Start first workflow
      const run1 = await triggerWorkflow('hookCleanupTestWorkflow', [
        token,
        customData,
      ]);

      // Wait for hook to be registered
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // Send payload to first workflow
      const hookUrl = new URL('/api/hook', deploymentUrl);
      let res = await fetch(hookUrl, {
        method: 'POST',
        body: JSON.stringify({
          token,
          data: { message: 'test-message-1', customData },
        }),
      });

      expect(res.status).toBe(200);
      let body = await res.json();
      expect(body.runId).toBe(run1.runId);

      // Get first workflow result
      const run1Result = await getWorkflowReturnValue(run1.runId);
      expect(run1Result).toMatchObject({
        message: 'test-message-1',
        customData,
        hookCleanupTestData: 'workflow_completed',
      });

      // Now verify token can be reused for a second workflow
      const run2 = await triggerWorkflow('hookCleanupTestWorkflow', [
        token,
        customData,
      ]);

      // Wait for hook to be registered
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // Send payload to second workflow using same token
      res = await fetch(hookUrl, {
        method: 'POST',
        body: JSON.stringify({
          token,
          data: { message: 'test-message-2', customData },
        }),
      });

      expect(res.status).toBe(200);
      body = await res.json();
      expect(body.runId).toBe(run2.runId);

      // Get second workflow result
      const run2Result = await getWorkflowReturnValue(run2.runId);
      expect(run2Result).toMatchObject({
        message: 'test-message-2',
        customData,
        hookCleanupTestData: 'workflow_completed',
      });

      // Verify both runs completed successfully
      const { json: run1Data } = await cliInspectJson(`runs ${run1.runId}`);
      expect(run1Data.status).toBe('completed');

      const { json: run2Data } = await cliInspectJson(`runs ${run2.runId}`);
      expect(run2Data.status).toBe('completed');
    }
  );

  test(
    'stepFunctionPassingWorkflow - step function references can be passed as arguments (without closure vars)',
    { timeout: 60_000 },
    async () => {
      // This workflow passes a step function reference to another step
      // The receiving step calls the passed function and returns the result
      const run = await triggerWorkflow('stepFunctionPassingWorkflow', []);
      const returnValue = await getWorkflowReturnValue(run.runId);

      // doubleNumber(10) = 20, then multiply by 2 = 40
      expect(returnValue).toBe(40);

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe(40);

      // Verify that exactly 2 steps were executed:
      // 1. stepWithStepFunctionArg(doubleNumber)
      //   (doubleNumber(10) is run inside the stepWithStepFunctionArg step)
      const { json: eventsData } = await cliInspectJson(
        `events --run ${run.runId} --json`
      );
      const stepCompletedEvents = eventsData.filter(
        (event) => event.eventType === 'step_completed'
      );
      expect(stepCompletedEvents).toHaveLength(1);
    }
  );

  test(
    'stepFunctionWithClosureWorkflow - step function with closure variables passed as argument',
    { timeout: 60_000 },
    async () => {
      // This workflow creates a nested step function with closure variables,
      // then passes it to another step which invokes it.
      // The closure variables should be serialized and preserved across the call.
      const run = await triggerWorkflow('stepFunctionWithClosureWorkflow', []);
      const returnValue = await getWorkflowReturnValue(run.runId);

      // Expected: "Wrapped: Result: 21"
      // - calculate(7) uses closure vars: prefix="Result: ", multiplier=3
      // - 7 * 3 = 21, prefixed with "Result: " = "Result: 21"
      // - stepThatCallsStepFn wraps it: "Wrapped: Result: 21"
      expect(returnValue).toBe('Wrapped: Result: 21');

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe('Wrapped: Result: 21');
    }
  );

  test(
    'closureVariableWorkflow - nested step functions with closure variables',
    { timeout: 60_000 },
    async () => {
      // This workflow uses a nested step function that references closure variables
      // from the parent workflow scope (multiplier, prefix, baseValue)
      const run = await triggerWorkflow('closureVariableWorkflow', [7]);
      const returnValue = await getWorkflowReturnValue(run.runId);

      // Expected: baseValue (7) * multiplier (3) = 21, prefixed with "Result: "
      expect(returnValue).toBe('Result: 21');
    }
  );

  test(
    'spawnWorkflowFromStepWorkflow - spawning a child workflow using start() inside a step',
    { timeout: 120_000 },
    async () => {
      // This workflow spawns another workflow using start() inside a step function
      // This is the recommended pattern for spawning workflows from within workflows
      const inputValue = 42;
      const run = await triggerWorkflow('spawnWorkflowFromStepWorkflow', [
        inputValue,
      ]);
      const returnValue = await getWorkflowReturnValue(run.runId);

      // Verify the parent workflow completed
      expect(returnValue).toHaveProperty('parentInput');
      expect(returnValue.parentInput).toBe(inputValue);

      // Verify the child workflow was spawned
      expect(returnValue).toHaveProperty('childRunId');
      expect(typeof returnValue.childRunId).toBe('string');
      expect(returnValue.childRunId.startsWith('wrun_')).toBe(true);

      // Verify the child workflow completed and returned the expected result
      expect(returnValue).toHaveProperty('childResult');
      expect(returnValue.childResult).toEqual({
        childResult: inputValue * 2, // doubleValue(42) = 84
        originalValue: inputValue,
      });

      // Verify both runs completed successfully via CLI
      const { json: parentRunData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(parentRunData.status).toBe('completed');

      const { json: childRunData } = await cliInspectJson(
        `runs ${returnValue.childRunId} --withData`
      );
      expect(childRunData.status).toBe('completed');
      expect(childRunData.output).toEqual({
        childResult: inputValue * 2,
        originalValue: inputValue,
      });
    }
  );
});
