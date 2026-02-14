import { WorkflowRunFailedError } from '@workflow/errors';
import fs from 'fs';
import path from 'path';
import { afterAll, assert, beforeAll, describe, expect, test } from 'vitest';
import type { Run } from '../src/runtime';
import {
  getHookByToken,
  getRun,
  getWorld,
  healthCheck,
  resumeHook,
  start,
} from '../src/runtime';
import {
  cliHealthJson,
  cliInspectJson,
  getProtectionBypassHeaders,
  getWorkbenchAppPath,
  hasStepSourceMaps,
  hasWorkflowSourceMaps,
  isLocalDeployment,
} from './utils';

// Manifest type matching the structure from BaseBuilder.createManifest()
interface WorkflowManifest {
  version: string;
  workflows: Record<
    string,
    Record<string, { workflowId: string; graph?: unknown }>
  >;
  steps: Record<string, Record<string, { stepId: string }>>;
  classes?: Record<string, Record<string, { classId: string }>>;
}

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

// Collect runIds for observability links (Vercel world only)
const collectedRunIds: {
  testName: string;
  runId: string;
  timestamp: string;
}[] = [];

function getE2EMetadataPath() {
  const appName = process.env.APP_NAME || 'unknown';
  // Detect if this is a Vercel deployment
  const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
  const backend = isVercel ? 'vercel' : 'local';
  return path.resolve(process.cwd(), `e2e-metadata-${appName}-${backend}.json`);
}

function writeE2EMetadata() {
  // Only write metadata for Vercel tests
  if (!process.env.WORKFLOW_VERCEL_ENV) return;

  const metadata = {
    runIds: collectedRunIds,
    vercel: {
      projectSlug: process.env.WORKFLOW_VERCEL_PROJECT_SLUG,
      environment: process.env.WORKFLOW_VERCEL_ENV,
      teamSlug: 'vercel-labs',
    },
  };

  fs.writeFileSync(getE2EMetadataPath(), JSON.stringify(metadata, null, 2));
}

// Cached manifest fetched from the deployment
let cachedManifest: WorkflowManifest | null = null;

/**
 * Fetches the workflow manifest from the deployment URL.
 * The manifest is served at /.well-known/workflow/v1/manifest.json by each
 * workbench app when WORKFLOW_PUBLIC_MANIFEST=1 is set.
 */
async function fetchManifest(): Promise<WorkflowManifest> {
  if (cachedManifest) return cachedManifest;

  const url = new URL('/.well-known/workflow/v1/manifest.json', deploymentUrl);
  const res = await fetch(url, {
    headers: getProtectionBypassHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${res.status} ${await res.text()}`
    );
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  return cachedManifest;
}

/**
 * Looks up the workflow metadata from the manifest for a given workflow file and function name.
 * Returns an object that can be passed directly to `start()`.
 *
 * The manifest contains the exact IDs produced by the SWC transform during the build,
 * which handles symlink resolution and path normalization correctly.
 */
async function getWorkflowMetadata(
  workflowFile: string,
  workflowFn: string
): Promise<{ workflowId: string }> {
  const manifest = await fetchManifest();

  // The manifest keys are relative file paths as seen by the builder.
  // Due to symlinks, the key may differ from the workflowFile we pass
  // (e.g., "example/workflows/99_e2e.ts" vs "workflows/99_e2e.ts").
  // Search all files for the matching function name and workflow file suffix.
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    if (
      manifestFile.endsWith(workflowFile) ||
      workflowFile.endsWith(manifestFile)
    ) {
      const entry = functions[workflowFn];
      if (entry) {
        return entry;
      }
    }
  }

  // If suffix matching didn't find it, try stripping the extension for matching
  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    const manifestFileWithoutExt = manifestFile.replace(/\.tsx?$/, '');
    if (
      manifestFileWithoutExt.endsWith(fileWithoutExt) ||
      fileWithoutExt.endsWith(manifestFileWithoutExt)
    ) {
      const entry = functions[workflowFn];
      if (entry) {
        return entry;
      }
    }
  }

  throw new Error(
    `Workflow "${workflowFn}" not found in manifest for file "${workflowFile}". ` +
      `Available files: ${Object.keys(manifest.workflows).join(', ')}`
  );
}

/**
 * Shorthand for looking up workflow metadata from workflows/99_e2e.ts.
 * Usage: `const run = await start(await e2e('addTenWorkflow'), [123]);`
 */
const e2e = (fn: string) => getWorkflowMetadata('workflows/99_e2e.ts', fn);

/**
 * Triggers a workflow via HTTP POST. Used only for Pages Router tests
 * that specifically need to validate the HTTP trigger endpoint.
 */
async function startWorkflowViaHttp(
  workflow: string | { workflowFile: string; workflowFn: string },
  args: any[],
  endpoint: string
): Promise<Run<any>> {
  const url = new URL(endpoint, deploymentUrl);
  const workflowFn =
    typeof workflow === 'string' ? workflow : workflow.workflowFn;
  const workflowFile =
    typeof workflow === 'string'
      ? 'workflows/99_e2e.ts'
      : workflow.workflowFile;

  url.searchParams.set('workflowFile', workflowFile);
  url.searchParams.set('workflowFn', workflowFn);

  // Note: when args is empty, the server may use default args (e.g., [42]).
  // This is acceptable for Pages Router tests since the workflows called
  // with empty args don't use their arguments.
  if (args.length > 0) {
    url.searchParams.set('args', args.map(String).join(','));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...getProtectionBypassHeaders(),
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to trigger workflow: ${res.url} ${
        res.status
      }: ${await res.text()}`
    );
  }
  const result = await res.json();
  const run = getRun(result.runId);

  return run;
}

// NOTE: Temporarily disabling concurrent tests to avoid flakiness.
// TODO: Re-enable concurrent tests after conf when we have more time to investigate.
describe('e2e', () => {
  // Configure the World for the test runner process so that start() and
  // run.returnValue can communicate with the same backend as the workbench app.
  beforeAll(async () => {
    if (isLocalDeployment()) {
      // Set base URL so the local queue can reach the running workbench app
      process.env.WORKFLOW_LOCAL_BASE_URL = deploymentUrl;

      // Set the data directory to match the workbench app's data directory.
      // We must set this explicitly (not discover it) because the data dir
      // may not exist yet when the test starts — the app creates it on first use.
      // Next.js uses .next/workflow-data, all other frameworks use .workflow-data.
      const appPath = getWorkbenchAppPath();
      const appName = process.env.APP_NAME!;
      const isNextJs = appName.includes('nextjs') || appName.includes('next-');
      const dataDirName = isNextJs ? '.next/workflow-data' : '.workflow-data';
      process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(appPath, dataDirName);
    }
    // For Vercel tests: WORKFLOW_VERCEL_AUTH_TOKEN, WORKFLOW_VERCEL_PROJECT, etc. are set by CI
    // For Postgres tests: WORKFLOW_TARGET_WORLD and WORKFLOW_POSTGRES_URL are set by CI
  });

  // Write E2E metadata file with runIds for observability links
  afterAll(() => {
    writeE2EMetadata();
  });

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
    const run = await start(
      await getWorkflowMetadata(workflow.workflowFile, workflow.workflowFn),
      [123]
    );

    const returnValue = await run.returnValue;
    expect(returnValue).toBe(133);

    const { json } = await cliInspectJson(`runs ${run.runId} --withData`);
    expect(json).toMatchObject({
      runId: run.runId,
      workflowName: expect.any(String),
      status: 'completed',
      input: [123],
      output: 133,
    });
    // Workflow ID format: workflow//./{path-without-extension}//{functionName}
    // Different workbenches have different directory structures:
    // - workflows/ (standard)
    // - src/workflows/ (some frameworks)
    // - example/workflows/ (example app)
    const fileWithoutExt = workflow.workflowFile.replace(/\.tsx?$/, '');
    expect(json.workflowName).toMatch(
      new RegExp(
        `^workflow//\\./(?:src/|example/)?${fileWithoutExt}//${workflow.workflowFn}$`
      )
    );
  });

  const isNext = process.env.APP_NAME?.includes('nextjs');
  const isLocal = deploymentUrl.includes('localhost');
  // only works with framework that transpiles react and
  // doesn't work on Vercel due to eval hack so react isn't
  // bundled in function
  const shouldSkipReactRenderTest = !(isNext && isLocal);

  test.skipIf(shouldSkipReactRenderTest)(
    'should work with react rendering in step',
    async () => {
      const run = await start(
        await getWorkflowMetadata(
          'workflows/8_react_render.tsx',
          'reactWorkflow'
        ),
        []
      );

      const returnValue = await run.returnValue;
      expect(returnValue).toBe('<div>hello world <!-- -->2</div>');
    }
  );

  test('promiseAllWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('promiseAllWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue).toBe('ABC');
  });

  test('promiseRaceWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('promiseRaceWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue).toBe('B');
  });

  test('promiseAnyWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('promiseAnyWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue).toBe('B');
  });

  // ReadableStream return values use the world's streaming infrastructure which
  // requires in-process access. The local world's streamer uses an in-process EventEmitter
  // that doesn't work cross-process (test runner ↔ workbench app).
  test.skipIf(isLocalDeployment())(
    'readableStreamWorkflow',
    { timeout: 60_000 },
    async () => {
      const run = await start(await e2e('readableStreamWorkflow'), []);
      const returnValue = await run.returnValue;
      expect(returnValue).toBeInstanceOf(ReadableStream);

      const decoder = new TextDecoder();
      let contents = '';
      for await (const chunk of returnValue) {
        const text = decoder.decode(chunk, { stream: true });
        contents += text;
      }
      expect(contents).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n');
    }
  );

  test('hookWorkflow', { timeout: 60_000 }, async () => {
    const token = Math.random().toString(36).slice(2);
    const customData = Math.random().toString(36).slice(2);

    const run = await start(await e2e('hookWorkflow'), [token, customData]);

    // Wait a few seconds so that the hook is registered.
    // TODO: make this more efficient when we add subscription support.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // Look up the hook and resume it with the first payload
    let hook = await getHookByToken(token);
    expect(hook.runId).toBe(run.runId);
    await resumeHook(hook, {
      message: 'one',
      customData: (hook.metadata as any)?.customData,
    });

    // Invalid token test
    await expect(getHookByToken('invalid')).rejects.toThrow(/not found/i);

    // Resume with second payload
    hook = await getHookByToken(token);
    expect(hook.runId).toBe(run.runId);
    await resumeHook(hook, {
      message: 'two',
      customData: (hook.metadata as any)?.customData,
    });

    // Resume with third (final) payload
    hook = await getHookByToken(token);
    expect(hook.runId).toBe(run.runId);
    await resumeHook(hook, {
      message: 'three',
      done: true,
      customData: (hook.metadata as any)?.customData,
    });

    const returnValue = await run.returnValue;
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

    const run = await start(await e2e('webhookWorkflow'), [
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
        headers: getProtectionBypassHeaders(),
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
        headers: getProtectionBypassHeaders(),
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
        headers: getProtectionBypassHeaders(),
        body: JSON.stringify({ message: 'three' }),
      }
    );
    expect(res3.status).toBe(200);
    const body3 = await res3.text();
    expect(body3).toBe('Hello from webhook!');

    const returnValue = await run.returnValue;
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
      headers: getProtectionBypassHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe('');
  });

  test('sleepingWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('sleepingWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue.startTime).toBeLessThan(returnValue.endTime);
    expect(returnValue.endTime - returnValue.startTime).toBeGreaterThan(9999);
  });

  test('parallelSleepWorkflow', { timeout: 30_000 }, async () => {
    const run = await start(await e2e('parallelSleepWorkflow'), []);
    const returnValue = await run.returnValue;
    // 10 parallel sleep('1s') should complete in ~1s, not 10s
    const elapsed = returnValue.endTime - returnValue.startTime;
    expect(elapsed).toBeGreaterThan(999);
    expect(elapsed).toBeLessThan(10_000);
  });

  test('nullByteWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('nullByteWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue).toBe('null byte \0');
  });

  test('workflowAndStepMetadataWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('workflowAndStepMetadataWorkflow'), []);
    const returnValue = await run.returnValue;

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
    // Note: workflowStartedAt may be a Date object (when using run.returnValue directly)
    // or a string (when serialized through JSON via HTTP)
    expect(returnValue.workflowMetadata.workflowStartedAt).toBeDefined();
    expect(returnValue.innerWorkflowMetadata.workflowStartedAt).toBeDefined();
    expect(String(returnValue.innerWorkflowMetadata.workflowStartedAt)).toBe(
      String(returnValue.workflowMetadata.workflowStartedAt)
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

    // stepStartedAt should be a Date or date string
    expect(returnValue.stepMetadata.stepStartedAt).toBeDefined();
  });

  // Output stream tests use run.getReadable() which requires in-process streaming
  // infrastructure. The local world's streamer uses an EventEmitter that doesn't work
  // cross-process (test runner ↔ workbench app).
  test.skipIf(isLocalDeployment())(
    'outputStreamWorkflow',
    { timeout: 60_000 },
    async () => {
      const run = await start(await e2e('outputStreamWorkflow'), []);
      const reader = run.getReadable().getReader();
      const namedReader = run.getReadable({ namespace: 'test' }).getReader();

      // First chunk from default stream: binary data
      const r1 = await reader.read();
      assert(r1.value);
      assert(r1.value instanceof Uint8Array);
      expect(Buffer.from(r1.value).toString()).toEqual('Hello, world!');

      // First chunk from named stream: binary data
      const r1Named = await namedReader.read();
      assert(r1Named.value);
      assert(r1Named.value instanceof Uint8Array);
      expect(Buffer.from(r1Named.value).toString()).toEqual(
        'Hello, named stream!'
      );

      // Second chunk from default stream: JSON object
      const r2 = await reader.read();
      assert(r2.value);
      expect(r2.value).toEqual({ foo: 'test' });

      // Second chunk from named stream: JSON object
      const r2Named = await namedReader.read();
      assert(r2Named.value);
      expect(r2Named.value).toEqual({ foo: 'bar' });

      // Streams should be closed
      const r3 = await reader.read();
      expect(r3.done).toBe(true);

      const r3Named = await namedReader.read();
      expect(r3Named.done).toBe(true);

      const returnValue = await run.returnValue;
      expect(returnValue).toEqual('done');
    }
  );

  test.skipIf(isLocalDeployment())(
    'outputStreamInsideStepWorkflow - getWritable() called inside step functions',
    { timeout: 60_000 },
    async () => {
      const run = await start(await e2e('outputStreamInsideStepWorkflow'), []);
      const reader = run.getReadable().getReader();
      const namedReader = run.getReadable({ namespace: 'step-ns' }).getReader();

      // First message from default stream: binary data
      const r1 = await reader.read();
      assert(r1.value);
      assert(r1.value instanceof Uint8Array);
      expect(Buffer.from(r1.value).toString()).toEqual('Hello from step!');

      // First message from named stream: JSON object
      const r1Named = await namedReader.read();
      assert(r1Named.value);
      expect(r1Named.value).toEqual({
        message: 'Hello from named stream in step!',
      });

      // Second message from default stream: binary data
      const r2 = await reader.read();
      assert(r2.value);
      assert(r2.value instanceof Uint8Array);
      expect(Buffer.from(r2.value).toString()).toEqual('Second message');

      // Second message from named stream: JSON object
      const r2Named = await namedReader.read();
      assert(r2Named.value);
      expect(r2Named.value).toEqual({ counter: 42 });

      // Verify streams are closed
      const r3 = await reader.read();
      expect(r3.done).toBe(true);

      const r3Named = await namedReader.read();
      expect(r3Named.done).toBe(true);

      const returnValue = await run.returnValue;
      expect(returnValue).toEqual('done');
    }
  );

  test('fetchWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('fetchWorkflow'), []);
    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      userId: 1,
      id: 1,
      title: 'delectus aut autem',
      completed: false,
    });
  });

  test('promiseRaceStressTestWorkflow', { timeout: 60_000 }, async () => {
    const run = await start(await e2e('promiseRaceStressTestWorkflow'), []);
    const returnValue = await run.returnValue;
    // Completion order can vary across worlds and scheduling environments.
    expect([...returnValue].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  // ==================== ERROR HANDLING TESTS ====================
  describe('error handling', () => {
    describe('error propagation', () => {
      describe('workflow errors', () => {
        test(
          'nested function calls preserve message and stack trace',
          { timeout: 60_000 },
          async () => {
            const run = await start(await e2e('errorWorkflowNested'), []);
            const error = await run.returnValue.catch((e: unknown) => e);

            expect(WorkflowRunFailedError.is(error)).toBe(true);
            assert(WorkflowRunFailedError.is(error));
            expect(error.cause.message).toContain('Nested workflow error');

            // Workflow source maps are not properly supported everywhere. Check the definition
            // of hasWorkflowSourceMaps() to see where they are supported
            if (hasWorkflowSourceMaps()) {
              // Stack shows call chain: errorNested1 -> errorNested2 -> errorNested3
              expect(error.cause.stack).toContain('errorNested1');
              expect(error.cause.stack).toContain('errorNested2');
              expect(error.cause.stack).toContain('errorNested3');
              expect(error.cause.stack).toContain('errorWorkflowNested');
              expect(error.cause.stack).toContain('99_e2e.ts');
              expect(error.cause.stack).not.toContain('evalmachine');
            }

            const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
            expect(runData.status).toBe('failed');
          }
        );

        test(
          'cross-file imports preserve message and stack trace',
          { timeout: 60_000 },
          async () => {
            const run = await start(await e2e('errorWorkflowCrossFile'), []);
            const error = await run.returnValue.catch((e: unknown) => e);

            expect(WorkflowRunFailedError.is(error)).toBe(true);
            assert(WorkflowRunFailedError.is(error));
            expect(error.cause.message).toContain(
              'Error from imported helper module'
            );

            // Workflow source maps are not properly supported everywhere. Check the definition
            // of hasWorkflowSourceMaps() to see where they are supported
            if (hasWorkflowSourceMaps()) {
              expect(error.cause.stack).toContain('throwError');
              expect(error.cause.stack).toContain('callThrower');
              expect(error.cause.stack).toContain('errorWorkflowCrossFile');
              expect(error.cause.stack).toContain('helpers.ts');
              expect(error.cause.stack).not.toContain('evalmachine');
            }

            const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
            expect(runData.status).toBe('failed');
          }
        );
      });

      describe('step errors', () => {
        test(
          'basic step error preserves message and stack trace',
          { timeout: 60_000 },
          async () => {
            const run = await start(await e2e('errorStepBasic'), []);
            const result = await run.returnValue;

            // Workflow catches the error and returns it
            expect(result.caught).toBe(true);
            expect(result.message).toContain('Step error message');
            // Stack trace can show either the original step function or its transformed wrapper name
            expect(result.stack).toMatch(/errorStepFn|registerStepFunction/);
            expect(result.stack).not.toContain('evalmachine');

            // Source maps are not supported everyhwere. Check the definition
            // of hasStepSourceMaps() to see where they are supported
            if (hasStepSourceMaps()) {
              expect(result.stack).toContain('99_e2e.ts');
            } else {
              expect(result.stack).not.toContain('99_e2e.ts');
            }

            // Verify step failed via CLI (--withData needed to resolve errorRef)
            const { json: steps } = await cliInspectJson(
              `steps --runId ${run.runId} --withData`
            );
            const failedStep = steps.find((s: any) =>
              s.stepName.includes('errorStepFn')
            );
            expect(failedStep.status).toBe('failed');
            expect(failedStep.error.message).toContain('Step error message');

            // Step error stack can show either the original step function or its transformed wrapper name
            expect(failedStep.error.stack).toMatch(
              /errorStepFn|registerStepFunction/
            );
            expect(failedStep.error.stack).not.toContain('evalmachine');

            // Source maps are not supported everyhwere. Check the definition
            // of hasStepSourceMaps() to see where they are supported
            if (hasStepSourceMaps()) {
              expect(failedStep.error.stack).toContain('99_e2e.ts');
            } else {
              expect(failedStep.error.stack).not.toContain('99_e2e.ts');
            }

            // Workflow completed (error was caught)
            const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
            expect(runData.status).toBe('completed');
          }
        );

        test(
          'cross-file step error preserves message and function names in stack',
          { timeout: 60_000 },
          async () => {
            const run = await start(await e2e('errorStepCrossFile'), []);
            const result = await run.returnValue;

            // Workflow catches the error and returns message + stack
            expect(result.caught).toBe(true);
            expect(result.message).toContain(
              'Step error from imported helper module'
            );
            // Stack trace propagates to caught error with function names and source file
            expect(result.stack).toContain('throwErrorFromStep');
            expect(result.stack).toMatch(
              /stepThatThrowsFromHelper|registerStepFunction/
            );
            expect(result.stack).not.toContain('evalmachine');

            // Source maps are not supported everyhwere. Check the definition
            // of hasStepSourceMaps() to see where they are supported
            if (hasStepSourceMaps()) {
              expect(result.stack).toContain('helpers.ts');
            } else {
              expect(result.stack).not.toContain('helpers.ts');
            }

            // Verify step failed via CLI - same stack info available there too (--withData needed to resolve errorRef)
            const { json: steps } = await cliInspectJson(
              `steps --runId ${run.runId} --withData`
            );
            const failedStep = steps.find((s: any) =>
              s.stepName.includes('stepThatThrowsFromHelper')
            );
            expect(failedStep.status).toBe('failed');
            expect(failedStep.error.stack).toContain('throwErrorFromStep');
            expect(failedStep.error.stack).toMatch(
              /stepThatThrowsFromHelper|registerStepFunction/
            );
            expect(failedStep.error.stack).not.toContain('evalmachine');
            // Source maps are not supported everyhwere. Check the definition
            // of hasStepSourceMaps() to see where they are supported
            if (hasStepSourceMaps()) {
              expect(failedStep.error.stack).toContain('helpers.ts');
            } else {
              expect(failedStep.error.stack).not.toContain('helpers.ts');
            }

            // Workflow completed (error was caught)
            const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
            expect(runData.status).toBe('completed');
          }
        );
      });
    });

    describe('retry behavior', () => {
      test(
        'regular Error retries until success',
        { timeout: 60_000 },
        async () => {
          const run = await start(await e2e('errorRetrySuccess'), []);
          const result = await run.returnValue;

          expect(result.finalAttempt).toBe(3);

          const { json: steps } = await cliInspectJson(
            `steps --runId ${run.runId}`
          );
          const step = steps.find((s: any) =>
            s.stepName.includes('retryUntilAttempt3')
          );
          expect(step.status).toBe('completed');
          expect(step.attempt).toBe(3);
        }
      );

      test(
        'FatalError fails immediately without retries',
        { timeout: 60_000 },
        async () => {
          const run = await start(await e2e('errorRetryFatal'), []);
          const error = await run.returnValue.catch((e: unknown) => e);

          expect(WorkflowRunFailedError.is(error)).toBe(true);
          assert(WorkflowRunFailedError.is(error));
          expect(error.cause.message).toContain('Fatal step error');

          const { json: steps } = await cliInspectJson(
            `steps --runId ${run.runId}`
          );
          const step = steps.find((s: any) =>
            s.stepName.includes('throwFatalError')
          );
          expect(step.status).toBe('failed');
          expect(step.attempt).toBe(1);
        }
      );

      test(
        'RetryableError respects custom retryAfter delay',
        { timeout: 60_000 },
        async () => {
          const run = await start(await e2e('errorRetryCustomDelay'), []);
          const result = await run.returnValue;

          expect(result.attempt).toBe(2);
          expect(result.duration).toBeGreaterThan(10_000);
        }
      );

      test('maxRetries=0 disables retries', { timeout: 60_000 }, async () => {
        const run = await start(await e2e('errorRetryDisabled'), []);
        const result = await run.returnValue;

        expect(result.failed).toBe(true);
        expect(result.attempt).toBe(1);
      });

      test(
        'workflow completes despite transient 5xx on step_completed',
        { timeout: 120_000 },
        async () => {
          const run = await start(
            await e2e('serverError5xxRetryWorkflow'),
            [42]
          );
          const result = await run.returnValue;

          // Correct result proves workflow completed successfully
          expect(result.result).toBe(84); // 42 * 2

          // retryCount > 0 proves the fault injection actually triggered
          expect(result.retryCount).toBe(2);

          // attempt === 1 proves no step attempt was consumed by the 5xx retries
          const { json: steps } = await cliInspectJson(
            `steps --runId ${run.runId}`
          );
          const doWorkStep = steps.find((s: any) =>
            s.stepName.includes('doWork')
          );
          expect(doWorkStep.attempt).toBe(1);
        }
      );
    });

    describe('catchability', () => {
      test(
        'FatalError can be caught and detected with FatalError.is()',
        { timeout: 60_000 },
        async () => {
          const run = await start(await e2e('errorFatalCatchable'), []);
          const result = await run.returnValue;

          expect(result.caught).toBe(true);
          expect(result.isFatal).toBe(true);

          // Verify workflow completed successfully (error was caught)
          const { json: runData } = await cliInspectJson(`runs ${run.runId}`);
          expect(runData.status).toBe('completed');
        }
      );
    });
  });
  // ==================== END ERROR HANDLING TESTS ====================

  test(
    'stepDirectCallWorkflow - calling step functions directly outside workflow context',
    { timeout: 60_000 },
    async () => {
      // Call the API route that directly calls a step function (no workflow context)
      const url = new URL('/api/test-direct-step-call', deploymentUrl);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getProtectionBypassHeaders(),
        },
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
    'hookCleanupTestWorkflow - hook token reuse after workflow completion',
    { timeout: 60_000 },
    async () => {
      const token = Math.random().toString(36).slice(2);
      const customData = Math.random().toString(36).slice(2);

      // Start first workflow
      const run1 = await start(await e2e('hookCleanupTestWorkflow'), [
        token,
        customData,
      ]);

      // Wait for hook to be registered
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // Send payload to first workflow
      let hook = await getHookByToken(token);
      expect(hook.runId).toBe(run1.runId);
      await resumeHook(hook, {
        message: 'test-message-1',
        customData: (hook.metadata as any)?.customData,
      });

      // Get first workflow result
      const run1Result = await run1.returnValue;
      expect(run1Result).toMatchObject({
        message: 'test-message-1',
        customData,
        hookCleanupTestData: 'workflow_completed',
      });

      // Now verify token can be reused for a second workflow
      const run2 = await start(await e2e('hookCleanupTestWorkflow'), [
        token,
        customData,
      ]);

      // Wait for hook to be registered
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // Send payload to second workflow using same token
      hook = await getHookByToken(token);
      expect(hook.runId).toBe(run2.runId);
      await resumeHook(hook, {
        message: 'test-message-2',
        customData: (hook.metadata as any)?.customData,
      });

      // Get second workflow result
      const run2Result = await run2.returnValue;
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
    'concurrent hook token conflict - two workflows cannot use the same hook token simultaneously',
    { timeout: 60_000 },
    async () => {
      const token = Math.random().toString(36).slice(2);
      const customData = Math.random().toString(36).slice(2);

      // Start first workflow - it will create a hook and wait for a payload
      const run1 = await start(await e2e('hookCleanupTestWorkflow'), [
        token,
        customData,
      ]);

      // Wait for the hook to be registered by workflow 1
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // Start second workflow with the SAME token while first is still running
      // This should fail because the hook token is already in use
      const run2 = await start(await e2e('hookCleanupTestWorkflow'), [
        token,
        customData,
      ]);

      // The second workflow should fail with a hook token conflict error
      const run2Error = await run2.returnValue.catch((e: unknown) => e);
      expect(WorkflowRunFailedError.is(run2Error)).toBe(true);
      assert(WorkflowRunFailedError.is(run2Error));
      expect(run2Error.cause.message).toContain(
        'already in use by another workflow'
      );

      // Verify workflow 2 failed
      const { json: run2Data } = await cliInspectJson(`runs ${run2.runId}`);
      expect(run2Data.status).toBe('failed');

      // Now send a payload to complete workflow 1
      const hook = await getHookByToken(token);
      await resumeHook(hook, {
        message: 'test-concurrent',
        customData: (hook.metadata as any)?.customData,
      });

      // Verify workflow 1 completed successfully
      const run1Result = await run1.returnValue;
      expect(run1Result).toMatchObject({
        message: 'test-concurrent',
        customData,
        hookCleanupTestData: 'workflow_completed',
      });

      const { json: run1Data } = await cliInspectJson(`runs ${run1.runId}`);
      expect(run1Data.status).toBe('completed');
    }
  );

  test(
    'stepFunctionPassingWorkflow - step function references can be passed as arguments (without closure vars)',
    { timeout: 60_000 },
    async () => {
      // This workflow passes a step function reference to another step
      // The receiving step calls the passed function and returns the result
      const run = await start(await e2e('stepFunctionPassingWorkflow'), []);
      const returnValue = await run.returnValue;

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
      const run = await start(await e2e('stepFunctionWithClosureWorkflow'), []);
      const returnValue = await run.returnValue;

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
      const run = await start(await e2e('closureVariableWorkflow'), [7]);
      const returnValue = await run.returnValue;

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
      const run = await start(await e2e('spawnWorkflowFromStepWorkflow'), [
        inputValue,
      ]);
      const returnValue = await run.returnValue;

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

  test(
    'health check endpoint (HTTP) - workflow and step endpoints respond to __health query parameter',
    { timeout: 30_000 },
    async () => {
      // NOTE: This tests the HTTP-based health check using the `?__health` query parameter.
      // This approach requires direct HTTP access and works when:
      // - Running locally (for port detection)
      // - Vercel Deployment Protection bypass headers are available
      //
      // For production use on Vercel with Deployment Protection enabled, use the
      // queue-based `healthCheck(world, endpoint, options)` function instead, which
      // bypasses protection by sending messages through the Queue infrastructure.

      // Test the flow endpoint health check
      const flowHealthUrl = new URL(
        '/.well-known/workflow/v1/flow?__health',
        deploymentUrl
      );
      const flowRes = await fetch(flowHealthUrl, {
        method: 'POST',
        headers: getProtectionBypassHeaders(),
      });
      expect(flowRes.status).toBe(200);
      expect(flowRes.headers.get('Content-Type')).toBe('text/plain');
      const flowBody = await flowRes.text();
      expect(flowBody).toBe(
        'Workflow DevKit "/.well-known/workflow/v1/flow" endpoint is healthy'
      );

      // Test the step endpoint health check
      const stepHealthUrl = new URL(
        '/.well-known/workflow/v1/step?__health',
        deploymentUrl
      );
      const stepRes = await fetch(stepHealthUrl, {
        method: 'POST',
        headers: getProtectionBypassHeaders(),
      });
      expect(stepRes.status).toBe(200);
      expect(stepRes.headers.get('Content-Type')).toBe('text/plain');
      const stepBody = await stepRes.text();
      expect(stepBody).toBe(
        'Workflow DevKit "/.well-known/workflow/v1/step" endpoint is healthy'
      );
    }
  );

  test(
    'health check (queue-based) - workflow and step endpoints respond to health check messages',
    { timeout: 60_000 },
    async () => {
      // Tests the queue-based health check using healthCheck() directly.
      // This bypasses Vercel Deployment Protection by sending messages
      // through the Queue infrastructure rather than direct HTTP.
      const world = getWorld();

      // Test workflow endpoint health check
      const workflowResult = await healthCheck(world, 'workflow', {
        timeout: 30000,
      });
      expect(workflowResult.healthy).toBe(true);

      // Test step endpoint health check
      const stepResult = await healthCheck(world, 'step', { timeout: 30000 });
      expect(stepResult.healthy).toBe(true);
    }
  );

  test(
    'health check (CLI) - workflow health command reports healthy endpoints',
    { timeout: 60_000 },
    async () => {
      // NOTE: This tests the `workflow health` CLI command which uses the
      // queue-based health check under the hood. The CLI provides a convenient
      // way to check endpoint health from the command line.

      // Test checking both endpoints (default behavior)
      const result = await cliHealthJson({ timeout: 30000 });
      expect(result.json.allHealthy).toBe(true);
      expect(result.json.results).toHaveLength(2);

      // Verify workflow endpoint result
      const workflowResult = result.json.results.find(
        (r: { endpoint: string }) => r.endpoint === 'workflow'
      );
      expect(workflowResult).toBeDefined();
      expect(workflowResult.healthy).toBe(true);
      expect(workflowResult.latencyMs).toBeGreaterThan(0);

      // Verify step endpoint result
      const stepResult = result.json.results.find(
        (r: { endpoint: string }) => r.endpoint === 'step'
      );
      expect(stepResult).toBeDefined();
      expect(stepResult.healthy).toBe(true);
      expect(stepResult.latencyMs).toBeGreaterThan(0);
    }
  );

  test(
    'pathsAliasWorkflow - TypeScript path aliases resolve correctly',
    { timeout: 60_000 },
    async () => {
      // This workflow uses a step that calls a helper function imported via @repo/* path alias
      // which resolves to a file outside the workbench directory (../../lib/steps/paths-alias-test.ts)
      const run = await start(await e2e('pathsAliasWorkflow'), []);
      const returnValue = await run.returnValue;

      // The step should return the helper's identifier string
      expect(returnValue).toBe('pathsAliasHelper');

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe('pathsAliasHelper');
    }
  );

  // ==================== STATIC METHOD STEP/WORKFLOW TESTS ====================
  // Tests for static methods on classes with "use step" and "use workflow" directives.

  test(
    'Calculator.calculate - static workflow method using static step methods from another class',
    { timeout: 60_000 },
    async () => {
      // Calculator.calculate(5, 3) should:
      // 1. MathService.add(5, 3) = 8
      // 2. MathService.multiply(8, 2) = 16
      const run = await start(await e2e('Calculator.calculate'), [5, 3]);

      const returnValue = await run.returnValue;

      expect(returnValue).toBe(16);

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe(16);
    }
  );

  test(
    'AllInOneService.processNumber - static workflow method using sibling static step methods',
    { timeout: 60_000 },
    async () => {
      // AllInOneService.processNumber(10) should:
      // 1. AllInOneService.double(10) = 20
      // 2. AllInOneService.triple(10) = 30
      // 3. return 20 + 30 = 50
      const run = await start(await e2e('AllInOneService.processNumber'), [10]);

      const returnValue = await run.returnValue;

      expect(returnValue).toBe(50);

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe(50);
    }
  );

  test(
    'ChainableService.processWithThis - static step methods using `this` to reference the class',
    { timeout: 60_000 },
    async () => {
      // ChainableService.processWithThis(5) should:
      // - ChainableService.multiplyByClassValue(5) uses `this.multiplier` (10) -> 5 * 10 = 50
      // - ChainableService.doubleAndMultiply(5) uses `this.multiplier` (10) -> 5 * 2 * 10 = 100
      // - sum = 50 + 100 = 150
      const run = await start(
        await e2e('ChainableService.processWithThis'),
        [5]
      );

      const returnValue = await run.returnValue;

      expect(returnValue).toEqual({
        multiplied: 50, // 5 * 10
        doubledAndMultiplied: 100, // 5 * 2 * 10
        sum: 150, // 50 + 100
      });

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toEqual({
        multiplied: 50,
        doubledAndMultiplied: 100,
        sum: 150,
      });
    }
  );

  test(
    'thisSerializationWorkflow - step function invoked with .call() and .apply()',
    { timeout: 60_000 },
    async () => {
      // thisSerializationWorkflow(10) should:
      // 1. multiplyByFactor.call({ factor: 2 }, 10) = 20
      // 2. multiplyByFactor.apply({ factor: 3 }, [20]) = 60
      // 3. multiplyByFactor.call({ factor: 5 }, 60) = 300
      // Total: 10 * 2 * 3 * 5 = 300
      const run = await start(await e2e('thisSerializationWorkflow'), [10]);
      const returnValue = await run.returnValue;

      expect(returnValue).toBe(300);

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toBe(300);
    }
  );

  test(
    'customSerializationWorkflow - custom class serialization with WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE',
    { timeout: 60_000 },
    async () => {
      // This workflow tests custom serialization of user-defined class instances.
      // The Point class uses WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE symbols
      // to define how instances are serialized/deserialized across workflow/step boundaries.
      //
      // customSerializationWorkflow(3, 4) should:
      // 1. Create Point(3, 4)
      // 2. transformPoint(point, 2) -> Point(6, 8)
      // 3. transformPoint(scaled, 3) -> Point(18, 24)
      // 4. sumPoints([Point(1,2), Point(3,4), Point(5,6)]) -> Point(9, 12)
      const run = await start(await e2e('customSerializationWorkflow'), [3, 4]);
      const returnValue = await run.returnValue;

      expect(returnValue).toEqual({
        original: { x: 3, y: 4 },
        scaled: { x: 6, y: 8 }, // 3*2, 4*2
        scaledAgain: { x: 18, y: 24 }, // 6*3, 8*3
        sum: { x: 9, y: 12 }, // 1+3+5, 2+4+6
      });

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toEqual({
        original: { x: 3, y: 4 },
        scaled: { x: 6, y: 8 },
        scaledAgain: { x: 18, y: 24 },
        sum: { x: 9, y: 12 },
      });
    }
  );

  test(
    'instanceMethodStepWorkflow - instance methods with "use step" directive',
    { timeout: 60_000 },
    async () => {
      // This workflow tests instance methods marked with "use step".
      // The Counter class has custom serialization so the `this` context
      // (the Counter instance) can be serialized across the workflow/step boundary.
      //
      // instanceMethodStepWorkflow(5) should:
      // 1. Create Counter(5)
      // 2. counter.add(10) -> 5 + 10 = 15
      // 3. counter.multiply(3) -> 5 * 3 = 15
      // 4. counter.describe('test counter') -> { label: 'test counter', value: 5 }
      // 5. Create Counter(100), call counter2.add(50) -> 100 + 50 = 150
      const run = await start(await e2e('instanceMethodStepWorkflow'), [5]);
      const returnValue = await run.returnValue;

      expect(returnValue).toEqual({
        initialValue: 5,
        added: 15, // 5 + 10
        multiplied: 15, // 5 * 3
        description: { label: 'test counter', value: 5 },
        added2: 150, // 100 + 50
      });

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toEqual({
        initialValue: 5,
        added: 15,
        multiplied: 15,
        description: { label: 'test counter', value: 5 },
        added2: 150,
      });

      // Verify the steps were executed (should have 4 steps: add, multiply, describe, add)
      const { json: steps } = await cliInspectJson(
        `steps --runId ${run.runId}`
      );
      // Filter to only Counter instance method steps
      const counterSteps = steps.filter(
        (s: any) =>
          s.stepName.includes('Counter#add') ||
          s.stepName.includes('Counter#multiply') ||
          s.stepName.includes('Counter#describe')
      );
      expect(counterSteps.length).toBe(4); // add, multiply, describe, add (from counter2)
      expect(counterSteps.every((s: any) => s.status === 'completed')).toBe(
        true
      );
    }
  );

  test(
    'crossContextSerdeWorkflow - classes defined in step code are deserializable in workflow context',
    { timeout: 60_000 },
    async () => {
      // This is a critical test for the cross-context class registration feature.
      //
      // The Vector class is defined in serde-models.ts and ONLY imported by step code
      // (serde-steps.ts). The workflow code (99_e2e.ts) does NOT import Vector directly.
      //
      // Without cross-context class registration, this test would fail because:
      // - The workflow bundle wouldn't have Vector registered (never imported it)
      // - The workflow couldn't deserialize Vector instances returned from steps
      //
      // With cross-context class registration:
      // - The build system discovers serde-models.ts has serialization patterns
      // - It includes serde-models.ts in ALL bundle contexts (step, workflow, client)
      // - Vector is registered everywhere, enabling full round-trip serialization
      //
      // Test flow:
      // 1. Step creates Vector(1, 2, 3) and returns it (step serializes)
      // 2. Workflow receives Vector (workflow MUST deserialize - key test!)
      // 3. Workflow passes Vector to another step (workflow serializes)
      // 4. Step receives Vector and operates on it (step deserializes)
      // 5. Workflow returns plain objects to client (no client deserialization needed)
      //
      // The critical part is step 2: the workflow code never imports Vector,
      // so without cross-context registration it wouldn't know how to deserialize it.

      const run = await start(await e2e('crossContextSerdeWorkflow'), []);
      const returnValue = await run.returnValue;

      // Verify all the vector operations worked correctly
      expect(returnValue).toEqual({
        // v1 created in step: (1, 2, 3)
        v1: { x: 1, y: 2, z: 3 },
        // v2 created in step: (10, 20, 30)
        v2: { x: 10, y: 20, z: 30 },
        // sum of v1 + v2: (11, 22, 33)
        sum: { x: 11, y: 22, z: 33 },
        // v1 scaled by 5: (5, 10, 15)
        scaled: { x: 5, y: 10, z: 15 },
        // Array sum of v1 + v2 + scaled: (16, 32, 48)
        arraySum: { x: 16, y: 32, z: 48 },
      });

      // Verify the run completed successfully
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
    }
  );

  test(
    'stepFunctionAsStartArgWorkflow - step function reference passed as start() argument',
    { timeout: 120_000 },
    async () => {
      // This test verifies that step function references can be:
      // 1. Serialized in the client bundle (the SWC plugin sets stepId property on the function)
      // 2. Passed as arguments to start()
      // 3. Deserialized in the workflow bundle (using WORKFLOW_USE_STEP from globalThis)
      // 4. Invoked from within a step function in the workflow
      //
      // In client mode, the SWC plugin sets the `stepId` property directly on step functions
      // (e.g., `myStepFn.stepId = "step//..."`). This allows the serialization layer to detect
      // step functions and serialize them by their stepId.
      //
      // The workflow receives a step function reference (add) and:
      // 1. Calls stepFn(3, 5) directly -> 8
      // 2. Passes it to invokeStepFn(stepFn, 3, 5) -> stepFn(3, 5) = 8
      // 3. Calls stepFn(8, 8) -> 16

      // Look up the stepId for the `add` function from 98_duplicate_case.ts
      // This simulates what the SWC plugin does in client mode: setting stepId on the function
      const manifest = await fetchManifest();
      const stepFile = Object.keys(manifest.steps).find((f) =>
        f.includes('98_duplicate_case')
      );
      assert(stepFile, 'Could not find 98_duplicate_case in manifest steps');
      const addStepInfo = manifest.steps[stepFile]?.['add'];
      assert(addStepInfo, 'Could not find "add" step in manifest');

      // Create a function reference with stepId, mimicking what the SWC client transform does
      const addStepRef = Object.assign(() => {}, {
        stepId: addStepInfo.stepId,
      });

      const run = await start(await e2e('stepFunctionAsStartArgWorkflow'), [
        addStepRef,
        3,
        5,
      ]);
      const returnValue = await run.returnValue;

      // Verify the workflow result
      // directResult: stepFn called directly from workflow code = add(3, 5) = 8
      // viaStepResult: stepFn called via invokeStepFn = add(3, 5) = 8
      // doubled: stepFn(8, 8) = 16
      expect(returnValue).toEqual({
        directResult: 8,
        viaStepResult: 8,
        doubled: 16,
      });

      // Verify the run completed successfully via CLI
      const { json: runData } = await cliInspectJson(
        `runs ${run.runId} --withData`
      );
      expect(runData.status).toBe('completed');
      expect(runData.output).toEqual({
        directResult: 8,
        viaStepResult: 8,
        doubled: 16,
      });
    }
  );

  // ==================== PAGES ROUTER TESTS ====================
  // Tests for Next.js Pages Router API endpoint (only runs for nextjs-turbopack and nextjs-webpack)
  const isNextJsApp =
    process.env.APP_NAME === 'nextjs-turbopack' ||
    process.env.APP_NAME === 'nextjs-webpack';

  describe.skipIf(!isNextJsApp)('pages router', () => {
    test('addTenWorkflow via pages router', { timeout: 60_000 }, async () => {
      const run = await startWorkflowViaHttp(
        {
          workflowFile: 'workflows/99_e2e.ts',
          workflowFn: 'addTenWorkflow',
        },
        [123],
        '/api/trigger-pages'
      );
      const returnValue = await run.returnValue;
      expect(returnValue).toBe(133);
    });

    test(
      'promiseAllWorkflow via pages router',
      { timeout: 60_000 },
      async () => {
        const run = await startWorkflowViaHttp(
          'promiseAllWorkflow',
          [],
          '/api/trigger-pages'
        );
        const returnValue = await run.returnValue;
        expect(returnValue).toBe('ABC');
      }
    );

    test('sleepingWorkflow via pages router', { timeout: 60_000 }, async () => {
      const run = await startWorkflowViaHttp(
        'sleepingWorkflow',
        [],
        '/api/trigger-pages'
      );
      const returnValue = await run.returnValue;
      expect(returnValue.startTime).toBeLessThan(returnValue.endTime);
      expect(returnValue.endTime - returnValue.startTime).toBeGreaterThan(9999);
    });
  });
});
