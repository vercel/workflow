// Test path alias resolution - imports a helper from outside the workbench directory
/** biome-ignore-all lint/complexity/noStaticOnlyClass: <explanation> */
import { pathsAliasHelper } from '@repo/lib/steps/paths-alias-test';
import {
  createHook,
  createWebhook,
  experimental_setAttributes,
  FatalError,
  fetch,
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
  type RequestWithResponse,
  RetryableError,
  sleep,
} from 'workflow';
import { getHookByToken, getRun, Run, resumeHook, start } from 'workflow/api';
import { importedStepOnly } from './_imported_step_only';
import { callThrower, stepThatThrowsFromHelper } from './helpers';

//////////////////////////////////////////////////////////

export async function add(a: number, b: number) {
  'use step';
  return a + b;
}

export async function addTenWorkflow(input: number) {
  'use workflow';
  const a = await add(input, 2);
  const b = await add(a, 3);
  const c = await add(b, 5);
  return c;
}

//////////////////////////////////////////////////////////

async function randomDelay(v: string) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3000));
  return v.toUpperCase();
}

export async function promiseAllWorkflow() {
  'use workflow';
  const [a, b, c] = await Promise.all([
    randomDelay('a'),
    randomDelay('b'),
    randomDelay('c'),
  ]);
  return a + b + c;
}

//////////////////////////////////////////////////////////

async function specificDelay(delay: number, v: string) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, delay));
  return v.toUpperCase();
}

export async function promiseRaceWorkflow() {
  'use workflow';
  const winner = await Promise.race([
    specificDelay(10000, 'a'),
    specificDelay(100, 'b'), // "b" should always win
    specificDelay(20000, 'c'),
  ]);
  return winner;
}

//////////////////////////////////////////////////////////

async function stepThatFails() {
  'use step';
  throw new FatalError('step failed');
}

export async function promiseAnyWorkflow() {
  'use workflow';
  const winner = await Promise.any([
    stepThatFails(),
    specificDelay(100, 'b'), // "b" should always win
    specificDelay(6000, 'c'),
  ]);
  return winner;
}

//////////////////////////////////////////////////////////

export async function importedStepOnlyWorkflow() {
  'use workflow';
  return await importedStepOnly();
}

//////////////////////////////////////////////////////////

// Name should not conflict with genStream in 3_streams.ts
// TODO: swc transform should mangle names to avoid conflicts
async function genReadableStream() {
  'use step';
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        console.log('enqueueing', i);
        controller.enqueue(encoder.encode(`${i}\n`));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      console.log('closing controller');
      controller.close();
    },
  });
}

export async function readableStreamWorkflow() {
  'use workflow';
  console.log('calling genReadableStream');
  const stream = await genReadableStream();
  console.log('genReadableStream returned', stream);
  return stream;
}

//////////////////////////////////////////////////////////

export async function hookWorkflow(token: string, customData: string) {
  'use workflow';

  type Payload = { message: string; customData: string; done?: boolean };

  using hook = createHook<Payload>({
    token,
    metadata: { customData },
  });

  const payloads: Payload[] = [];
  for await (const payload of hook) {
    payloads.push(payload);

    if (payload.done) {
      break;
    }
  }

  return payloads;
}

//////////////////////////////////////////////////////////

async function sendWebhookResponse(req: RequestWithResponse) {
  'use step';
  const body = await req.text();
  await req.respondWith(new Response('Hello from webhook!'));
  return body;
}

export async function webhookWorkflow() {
  'use workflow';

  type Payload = { url: string; method: string; body: string };
  const payloads: Payload[] = [];

  // All webhooks must be created upfront so they're all registered
  // before the test sends HTTP requests to them
  const webhookWithDefaultResponse = createWebhook();

  const res = new Response('Hello from static response!', { status: 402 });
  const webhookWithStaticResponse = createWebhook({
    respondWith: res,
  });
  const webhookWithManualResponse = createWebhook({
    respondWith: 'manual',
  });

  // Webhook with default response
  {
    const req = await webhookWithDefaultResponse;
    const body = await req.text();
    payloads.push({ url: req.url, method: req.method, body });
  }

  // Webhook with static response
  {
    const req = await webhookWithStaticResponse;
    const body = await req.text();
    payloads.push({ url: req.url, method: req.method, body });
  }

  // Webhook with manual response
  {
    const req = await webhookWithManualResponse;
    const body = await sendWebhookResponse(req);
    payloads.push({ url: req.url, method: req.method, body });
  }

  return payloads;
}

//////////////////////////////////////////////////////////

export async function sleepingWorkflow(durationMs = 10_000) {
  'use workflow';
  const startTime = Date.now();
  await sleep(durationMs);
  const endTime = Date.now();
  return { startTime, endTime };
}

export async function parallelSleepWorkflow() {
  'use workflow';
  const startTime = Date.now();
  await Promise.all(Array.from({ length: 10 }, () => sleep('1s')));
  const endTime = Date.now();
  return { startTime, endTime };
}

//////////////////////////////////////////////////////////

async function delayMsStep(ms: number, label: string) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, ms));
  return label;
}

export async function sleepWinsRaceWorkflow() {
  'use workflow';
  const startTime = Date.now();
  const winner = await Promise.race([
    delayMsStep(10_000, 'step'),
    sleep('1s').then(() => 'sleep'),
  ]);
  const endTime = Date.now();
  return { winner, durationMs: endTime - startTime };
}

export async function stepWinsRaceWorkflow() {
  'use workflow';
  const startTime = Date.now();
  const winner = await Promise.race([
    delayMsStep(1_000, 'step'),
    sleep('10s').then(() => 'sleep'),
  ]);
  const endTime = Date.now();
  return { winner, durationMs: endTime - startTime };
}

//////////////////////////////////////////////////////////

async function nullByteStep() {
  'use step';
  return 'null byte \0';
}

export async function nullByteWorkflow() {
  'use workflow';
  const a = await nullByteStep();
  return a;
}

//////////////////////////////////////////////////////////

async function stepWithMetadata() {
  'use step';
  const stepMetadata = getStepMetadata();
  const workflowMetadata = getWorkflowMetadata();
  return { stepMetadata, workflowMetadata };
}

export async function workflowAndStepMetadataWorkflow() {
  'use workflow';
  const workflowMetadata = getWorkflowMetadata();
  const { stepMetadata, workflowMetadata: innerWorkflowMetadata } =
    await stepWithMetadata();
  return {
    workflowMetadata: {
      workflowName: workflowMetadata.workflowName,
      workflowRunId: workflowMetadata.workflowRunId,
      workflowStartedAt: workflowMetadata.workflowStartedAt,
      url: workflowMetadata.url,
      features: workflowMetadata.features,
    },
    stepMetadata,
    innerWorkflowMetadata,
  };
}

//////////////////////////////////////////////////////////

async function stepWithOutputStreamBinary(
  writable: WritableStream,
  text: string
) {
  'use step';
  const writer = writable.getWriter();
  // binary data
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

async function stepWithOutputStreamObject(writable: WritableStream, obj: any) {
  'use step';
  const writer = writable.getWriter();
  // object data
  await writer.write(obj);
  writer.releaseLock();
}

async function stepCloseOutputStream(writable: WritableStream) {
  'use step';
  await writable.close();
}

export async function outputStreamWorkflow() {
  'use workflow';
  const writable = getWritable();
  const namedWritable = getWritable({ namespace: 'test' });
  await sleep('1s');
  await stepWithOutputStreamBinary(writable, 'Hello, world!');
  await sleep('1s');
  await stepWithOutputStreamBinary(namedWritable, 'Hello, named stream!');
  await sleep('1s');
  await stepWithOutputStreamObject(writable, { foo: 'test' });
  await sleep('1s');
  await stepWithOutputStreamObject(namedWritable, { foo: 'bar' });
  await sleep('1s');
  await stepCloseOutputStream(writable);
  await stepCloseOutputStream(namedWritable);
  return 'done';
}

//////////////////////////////////////////////////////////

async function stepWithOutputStreamInsideStep(text: string) {
  'use step';
  // Call getWritable directly inside the step function
  const writable = getWritable();
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

async function stepWithNamedOutputStreamInsideStep(
  namespace: string,
  obj: any
) {
  'use step';
  // Call getWritable with namespace directly inside the step function
  const writable = getWritable({ namespace });
  const writer = writable.getWriter();
  await writer.write(obj);
  writer.releaseLock();
}

async function stepCloseOutputStreamInsideStep(namespace?: string) {
  'use step';
  // Call getWritable directly inside the step function and close it
  const writable = getWritable({ namespace });
  await writable.close();
}

export async function outputStreamInsideStepWorkflow() {
  'use workflow';
  await sleep('1s');
  await stepWithOutputStreamInsideStep('Hello from step!');
  await sleep('1s');
  await stepWithNamedOutputStreamInsideStep('step-ns', {
    message: 'Hello from named stream in step!',
  });
  await sleep('1s');
  await stepWithOutputStreamInsideStep('Second message');
  await sleep('1s');
  await stepWithNamedOutputStreamInsideStep('step-ns', { counter: 42 });
  await sleep('1s');
  await stepCloseOutputStreamInsideStep();
  await stepCloseOutputStreamInsideStep('step-ns');
  return 'done';
}

//////////////////////////////////////////////////////////

async function stepWriteUtf8Text(writable: WritableStream, text: string) {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

async function stepWriteUtf8Json(writable: WritableStream, value: unknown) {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(value)));
  writer.releaseLock();
}

// Emits a sequence of Uint8Array chunks containing UTF-8 encoded text,
// including multi-byte sequences (Latin Extended, CJK, emoji, RTL), plus
// one chunk whose decoded text is a valid JSON document. Used to validate
// that typed-array stream chunks round-trip as UTF-8 end-to-end.
export async function utf8StreamWorkflow() {
  'use workflow';
  const writable = getWritable();
  await sleep('1s');
  await stepWriteUtf8Text(writable, 'Hello, world!');
  await stepWriteUtf8Text(writable, 'Café — naïve résumé');
  await stepWriteUtf8Text(writable, '你好，世界！🌍✨');
  await stepWriteUtf8Text(writable, 'مرحبا بالعالم');
  await stepWriteUtf8Json(writable, { greeting: '안녕하세요', emoji: '🎉' });
  await stepCloseOutputStream(writable);
  return 'done';
}

//////////////////////////////////////////////////////////

export async function fetchWorkflow() {
  'use workflow';
  const response = await fetch('https://jsonplaceholder.typicode.com/todos/1');
  const data = await response.json();
  return data;
}

//////////////////////////////////////////////////////////

export async function promiseRaceStressTestDelayStep(
  dur: number,
  resp: number
): Promise<number> {
  'use step';

  console.log(`sleep`, resp, `/`, dur);
  await new Promise((resolve) => setTimeout(resolve, dur));

  console.log(resp, `done`);
  return resp;
}

export async function promiseRaceStressTestWorkflow() {
  'use workflow';

  const promises = new Map<number, Promise<number>>();
  const done: number[] = [];
  for (let i = 0; i < 5; i++) {
    const resp = i;
    const dur = 1000 * 5 * i; // 5 seconds apart
    console.log(`sched`, resp, `/`, dur);
    promises.set(i, promiseRaceStressTestDelayStep(dur, resp));
  }

  while (promises.size > 0) {
    console.log(`promises.size`, promises.size);
    const res = await Promise.race(promises.values());
    console.log(res);
    done.push(res);
    promises.delete(res);
  }

  return done;
}

//////////////////////////////////////////////////////////

async function stepThatRetriesAndSucceeds() {
  'use step';
  const { attempt } = getStepMetadata();
  console.log(`stepThatRetriesAndSucceeds - attempt: ${attempt}`);

  // Fail on attempts 1 and 2, succeed on attempt 3
  if (attempt < 3) {
    console.log(`Attempt ${attempt} - throwing error to trigger retry`);
    throw new Error(`Failed on attempt ${attempt}`);
  }

  console.log(`Attempt ${attempt} - succeeding`);
  return attempt;
}

export async function retryAttemptCounterWorkflow() {
  'use workflow';
  console.log('Starting retry attempt counter workflow');

  // This step should fail twice and succeed on the third attempt
  const finalAttempt = await stepThatRetriesAndSucceeds();

  console.log(`Workflow completed with final attempt: ${finalAttempt}`);
  return { finalAttempt };
}

//////////////////////////////////////////////////////////

async function stepThatThrowsRetryableError() {
  'use step';
  const { attempt, stepStartedAt } = getStepMetadata();
  if (attempt === 1) {
    throw new RetryableError('Retryable error', {
      retryAfter: '10s',
    });
  }
  return {
    attempt,
    stepStartedAt,
    duration: Date.now() - stepStartedAt.getTime(),
  };
}

export async function crossFileErrorWorkflow() {
  'use workflow';
  // This will throw an error from the imported helpers.ts file
  callThrower();
  return 'never reached';
}

//////////////////////////////////////////////////////////

export async function retryableAndFatalErrorWorkflow() {
  'use workflow';

  const retryableResult = await stepThatThrowsRetryableError();

  let gotFatalError = false;
  try {
    await stepThatFails();
  } catch (error: any) {
    if (FatalError.is(error)) {
      gotFatalError = true;
    }
  }

  return { retryableResult, gotFatalError };
}

//////////////////////////////////////////////////////////

// Test that maxRetries = 0 means the step runs once but does not retry on failure
async function stepWithNoRetries() {
  'use step';
  const { attempt } = getStepMetadata();
  console.log(`stepWithNoRetries - attempt: ${attempt}`);
  // Always fail - with maxRetries = 0, this should only run once
  throw new Error(`Failed on attempt ${attempt}`);
}
stepWithNoRetries.maxRetries = 0;

// Test that maxRetries = 0 works when the step succeeds
async function stepWithNoRetriesThatSucceeds() {
  'use step';
  const { attempt } = getStepMetadata();
  console.log(`stepWithNoRetriesThatSucceeds - attempt: ${attempt}`);
  return { attempt };
}
stepWithNoRetriesThatSucceeds.maxRetries = 0;

export async function maxRetriesZeroWorkflow() {
  'use workflow';
  console.log('Starting maxRetries = 0 workflow');

  // First, verify that a step with maxRetries = 0 can still succeed
  const successResult = await stepWithNoRetriesThatSucceeds();

  // Now test that a failing step with maxRetries = 0 does NOT retry
  let failedAttempt: number | null = null;
  let gotError = false;
  try {
    await stepWithNoRetries();
  } catch (error: any) {
    gotError = true;
    console.log('Received error', typeof error, error, error.message);
    // Extract the attempt number from the error message
    const match = error.message?.match(/attempt (\d+)/);
    if (match) {
      failedAttempt = parseInt(match[1], 10);
    }
  }

  console.log(
    `Workflow completed: successResult=${JSON.stringify(successResult)}, gotError=${gotError}, failedAttempt=${failedAttempt}`
  );

  return {
    successResult,
    gotError,
    failedAttempt,
  };
}

//////////////////////////////////////////////////////////

export async function hookCleanupTestWorkflow(
  token: string,
  customData: string
) {
  'use workflow';

  type Payload = { message: string; customData: string };

  using hook = createHook<Payload>({
    token,
    metadata: { customData },
  });

  const payload = await hook;

  return {
    message: payload.message,
    customData: payload.customData,
    hookCleanupTestData: 'workflow_completed',
  };
}

//////////////////////////////////////////////////////////

/**
 * Workflow for testing early hook disposal - allows another workflow to reuse
 * the token while this workflow is still running.
 *
 * The block scope with `using` releases the token before the sleep, so another
 * workflow can claim the token while this one continues.
 */
export async function hookDisposeTestWorkflow(
  token: string,
  customData: string
) {
  'use workflow';

  type Payload = { message: string; customData: string };

  let message: string;
  let customDataResult: string;

  {
    // Block scope releases the hook token when exited
    using hook = createHook<Payload>({
      token,
      metadata: { customData },
    });

    const payload = await hook;
    message = payload.message;
    customDataResult = payload.customData;
  }

  // Token is now available for another workflow while we continue
  await sleep('5s');

  return {
    message,
    customData: customDataResult,
    disposed: true,
    hookDisposeTestData: 'workflow_completed',
  };
}

//////////////////////////////////////////////////////////

export async function stepFunctionPassingWorkflow() {
  'use workflow';
  // Pass a step function reference to another step (without closure vars)
  const result = await stepWithStepFunctionArg(doubleNumber);
  return result;
}

async function stepWithStepFunctionArg(stepFn: (x: number) => Promise<number>) {
  'use step';
  // Call the passed step function reference
  const result = await stepFn(10);
  return result * 2;
}

async function doubleNumber(x: number) {
  'use step';
  return x * 2;
}

//////////////////////////////////////////////////////////

export async function stepFunctionWithClosureWorkflow() {
  'use workflow';
  const multiplier = 3;
  const prefix = 'Result: ';

  // Create a step function that captures closure variables
  const calculate = async (x: number) => {
    'use step';
    return `${prefix}${x * multiplier}`;
  };

  // Pass the step function (with closure vars) to another step
  const result = await stepThatCallsStepFn(calculate, 7);
  return result;
}

async function stepThatCallsStepFn(
  stepFn: (x: number) => Promise<string>,
  value: number
) {
  'use step';
  // Call the passed step function - closure vars should be preserved
  const result = await stepFn(value);
  return `Wrapped: ${result}`;
}

//////////////////////////////////////////////////////////

export async function closureVariableWorkflow(baseValue: number) {
  'use workflow';
  // biome-ignore lint/style/useConst: Intentionally using `let` instead of `const`
  let multiplier = 3;
  const prefix = 'Result: ';

  // Nested step function that uses closure variables
  const calculate = async () => {
    'use step';
    const result = baseValue * multiplier;
    return `${prefix}${result}`;
  };

  const output = await calculate();
  return output;
}

//////////////////////////////////////////////////////////

// Child workflow that will be spawned from another workflow
export async function childWorkflow(value: number) {
  'use workflow';
  // Do some processing
  const doubled = await doubleValue(value);
  return { childResult: doubled, originalValue: value };
}

async function doubleValue(value: number) {
  'use step';
  return value * 2;
}

// Step function that spawns another workflow using start()
async function spawnChildWorkflow(value: number) {
  'use step';
  // start() can only be called inside a step function, not directly in workflow code
  const childRun = await start(childWorkflow, [value]);
  return childRun.runId;
}

// Step function that waits for a workflow run to complete and returns its result
async function awaitWorkflowResult<T>(runId: string) {
  'use step';
  const run = getRun<T>(runId);
  const result = await run.returnValue;
  return result;
}

export async function spawnWorkflowFromStepWorkflow(inputValue: number) {
  'use workflow';
  // Spawn the child workflow from inside a step function
  const childRunId = await spawnChildWorkflow(inputValue);

  // Wait for the child workflow to complete (also in a step)
  const childResult = await awaitWorkflowResult<{
    childResult: number;
    originalValue: number;
  }>(childRunId);

  return {
    parentInput: inputValue,
    childRunId,
    childResult,
  };
}

async function spawnChildWorkflowRun(value: number) {
  'use step';
  return await start(childWorkflow, [value]);
}

async function getRunIdFromRun(run: Run<unknown>) {
  'use step';
  return run.runId;
}

async function awaitRunFromRun<T>(run: Run<T>) {
  'use step';
  return await run.returnValue;
}

export async function runClassSerializationWorkflow(inputValue: number) {
  'use workflow';

  const childRun = await spawnChildWorkflowRun(inputValue);
  const isRunInWorkflow = childRun instanceof Run;
  const runIdFromStep = await getRunIdFromRun(childRun);
  const childResult = await awaitRunFromRun<{
    childResult: number;
    originalValue: number;
  }>(childRun);

  return {
    childRunId: childRun.runId,
    runIdFromStep,
    isRunInWorkflow,
    childResult,
  };
}

//////////////////////////////////////////////////////////

/**
 * Step that calls a helper function imported via path alias.
 */
async function callPathsAliasHelper() {
  'use step';
  // Call the helper function imported via @repo/* path alias
  return pathsAliasHelper();
}

/**
 * Test that TypeScript path aliases work correctly.
 * This workflow uses a step that calls a helper function imported via the @repo/* path alias,
 * which resolves to a file outside the workbench directory.
 */
export async function pathsAliasWorkflow() {
  'use workflow';
  // Call the step that uses the path alias helper
  const result = await callPathsAliasHelper();
  return result;
}

// ============================================================
// ERROR HANDLING E2E TEST WORKFLOWS
// ============================================================
// These workflows test error propagation and retry behavior.
// Each workflow tests a specific error scenario with clear naming:
//   error<Context><Behavior>
// Where Context is "Workflow" or "Step", and Behavior describes what's tested.
//
// Organized into 3 sections:
// 1. Error Propagation - message and stack trace preservation
// 2. Retry Behavior - how different error types affect retries
// 3. Catchability - catching errors in workflow code
// ============================================================

// ------------------------------------------------------------
// SECTION 1: ERROR PROPAGATION
// Tests that error messages and stack traces are preserved correctly
// ------------------------------------------------------------

// --- Workflow Errors (errors thrown directly in workflow code) ---

function errorNested3() {
  throw new Error('Nested workflow error');
}

function errorNested2() {
  errorNested3();
}

function errorNested1() {
  errorNested2();
}

/** Test: Workflow error from nested function calls preserves stack trace */
export async function errorWorkflowNested() {
  'use workflow';
  errorNested1();
  return 'never reached';
}

/** Test: Workflow error from imported module preserves file reference in stack */
export async function errorWorkflowCrossFile() {
  'use workflow';
  callThrower(); // from helpers.ts - throws Error
  return 'never reached';
}

// --- Step Errors (errors thrown in steps that propagate to workflow) ---

async function errorStepFn() {
  'use step';
  throw new Error('Step error message');
}
errorStepFn.maxRetries = 0;

/** Test: Step error message propagates correctly to workflow */
export async function errorStepBasic() {
  'use workflow';
  try {
    await errorStepFn();
    return { caught: false, message: null, stack: null };
  } catch (e: any) {
    return { caught: true, message: e.message, stack: e.stack };
  }
}

/** Test: Step error from imported module has function names in stack */
export async function errorStepCrossFile() {
  'use workflow';
  try {
    await stepThatThrowsFromHelper(); // from helpers.ts
    return { caught: false, message: null, stack: null };
  } catch (e: any) {
    return { caught: true, message: e.message, stack: e.stack };
  }
}

// ------------------------------------------------------------
// SECTION 2: RETRY BEHAVIOR
// Tests how different error types affect step retry behavior
// ------------------------------------------------------------

async function retryUntilAttempt3() {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt < 3) {
    throw new Error(`Failed on attempt ${attempt}`);
  }
  return attempt;
}

/** Test: Regular Error retries until success (succeeds on attempt 3) */
export async function errorRetrySuccess() {
  'use workflow';
  const attempt = await retryUntilAttempt3();
  return { finalAttempt: attempt };
}

// ---

async function throwFatalError() {
  'use step';
  throw new FatalError('Fatal step error');
}

/** Test: FatalError fails immediately without retry (attempt=1) */
export async function errorRetryFatal() {
  'use workflow';
  await throwFatalError();
  return 'never reached';
}

// ---

async function throwRetryableError() {
  'use step';
  const { attempt, stepStartedAt } = getStepMetadata();
  if (attempt === 1) {
    throw new RetryableError('Retryable error', { retryAfter: '10s' });
  }
  return {
    attempt,
    duration: Date.now() - stepStartedAt.getTime(),
  };
}

/** Test: RetryableError respects custom retryAfter timing (waits 10s+) */
export async function errorRetryCustomDelay() {
  'use workflow';
  return await throwRetryableError();
}

// ---

async function throwWithNoRetries() {
  'use step';
  const { attempt } = getStepMetadata();
  throw new Error(`Failed on attempt ${attempt}`);
}
throwWithNoRetries.maxRetries = 0;

/** Test: maxRetries=0 runs once without retry on failure */
export async function errorRetryDisabled() {
  'use workflow';
  try {
    await throwWithNoRetries();
    return { failed: false, attempt: null };
  } catch (e: any) {
    // Extract attempt from error message
    const match = e.message?.match(/attempt (\d+)/);
    return { failed: true, attempt: match ? parseInt(match[1]) : null };
  }
}

// ------------------------------------------------------------
// SECTION 3: CATCHABILITY
// Tests that errors can be caught and inspected in workflow code
// ------------------------------------------------------------

/** Test: FatalError can be caught and detected with FatalError.is() */
export async function errorFatalCatchable() {
  'use workflow';
  try {
    await throwFatalError();
    return { caught: false, isFatal: false };
  } catch (e: any) {
    return { caught: true, isFatal: FatalError.is(e) };
  }
}

/**
 * Test: a step throws a FatalError; the workflow catches it and inspects
 * the hydrated thrown value. Exercises the step error serialization
 * pipeline (step throw → step_failed event → workflow catch).
 */
async function throwFatalErrorWithCause() {
  'use step';
  const root = new TypeError('underlying type error');
  const wrapped = new FatalError('fatal with cause');
  (wrapped as Error).cause = root;
  throw wrapped;
}

export async function errorStepThrowFatalRoundTrip() {
  'use workflow';
  try {
    await throwFatalErrorWithCause();
    return { caught: false } as any;
  } catch (err: any) {
    return {
      caught: true,
      isFatal: FatalError.is(err),
      isInstanceOf: err instanceof FatalError,
      message: err.message,
      name: err.name,
      hasFatalProp: err.fatal === true,
      causeIsTypeError: err.cause instanceof TypeError,
      causeName: err.cause?.name,
      causeMessage: err.cause?.message,
    };
  }
}

// ---

/**
 * Test: a workflow itself throws a FatalError with a cause chain.
 * Exercises the run-error serialization pipeline (workflow throw →
 * run_failed event → WorkflowRunFailedError.cause on the client side).
 */
export async function errorWorkflowThrowFatalRoundTrip() {
  'use workflow';
  const root = new RangeError('out of bounds');
  const top = new FatalError('workflow exploded');
  (top as Error).cause = root;
  throw top;
}

// ---

/**
 * Test: a workflow throws a non-Error value (a plain object). The
 * client-side hydrated `cause` on WorkflowRunFailedError should be
 * exactly that object — not coerced into an Error.
 */
export async function errorWorkflowThrowNonErrorValue() {
  'use workflow';
  const value: Record<string, unknown> = {
    kind: 'business-rule-violation',
    code: 'INVOICE_LOCKED',
    detail: { invoiceId: 'inv_123', userId: 'usr_456' },
  };
  // Throw a non-Error value (any JS value can be thrown). The serialization
  // pipeline must round-trip this verbatim — not coerce it into an Error.
  throw value;
}

// ---

/**
 * Test: a step throws a non-Error value (a plain object). Non-Error
 * throws are NOT recognized as `FatalError` (no `name === 'FatalError'`)
 * nor as `RetryableError`, so they take the transient retry path. With
 * `maxRetries = 0` the step fails on first attempt; the runtime wraps
 * the original thrown value as `cause` on a `FatalError` and the
 * workflow catches that.
 */
async function throwNonErrorFromStep() {
  'use step';
  // Same shape as `errorWorkflowThrowNonErrorValue` so the test asserts
  // a parallel round-trip on both throw boundaries.
  const value: Record<string, unknown> = {
    kind: 'business-rule-violation',
    code: 'INVOICE_LOCKED',
    detail: { invoiceId: 'inv_123', userId: 'usr_456' },
  };
  throw value;
}
throwNonErrorFromStep.maxRetries = 0;

export async function errorStepThrowNonErrorValue() {
  'use workflow';
  try {
    await throwNonErrorFromStep();
    return { caught: false } as any;
  } catch (err: any) {
    // After max retries the step handler wraps the underlying thrown value
    // as `cause` on a FatalError. The wrapping FatalError is what reaches
    // the workflow's catch; the original non-Error object is on `err.cause`.
    return {
      caught: true,
      isFatal: FatalError.is(err),
      isInstanceOf: err instanceof FatalError,
      // The wrapping message includes the retry count + the original
      // non-Error value's `JSON.stringify` form.
      messageIncludesKind:
        typeof err?.message === 'string' &&
        err.message.includes('business-rule-violation'),
      causeIsObject:
        err?.cause !== null &&
        typeof err?.cause === 'object' &&
        !(err.cause instanceof Error),
      causeKind: err?.cause?.kind,
      causeCode: err?.cause?.code,
      causeDetail: err?.cause?.detail,
    };
  }
}

// ------------------------------------------------------------
// SECTION 4: NOT REGISTERED ERRORS
// Tests for step/workflow not registered in the current deployment
// ------------------------------------------------------------

/**
 * Test: step not registered causes the step to fail (like FatalError),
 * and the workflow can catch the error gracefully.
 *
 * This manually invokes useStep with a step ID that doesn't exist in the
 * deployment bundle, simulating what would happen if a build/bundling issue
 * caused a step to be missing.
 */
export async function stepNotRegisteredCatchable() {
  'use workflow';
  // Manually invoke a step that doesn't exist in the deployment.
  // The SWC transform generates exactly this pattern for real step calls,
  // so this is equivalent to calling a step that wasn't bundled.
  const ghost = (globalThis as any)[Symbol.for('WORKFLOW_USE_STEP')](
    'step//./workflows/99_e2e//nonExistentStep'
  );
  try {
    await ghost();
    return { caught: false, error: null };
  } catch (e: any) {
    return { caught: true, error: e.message };
  }
}

/**
 * Test: step not registered causes the run to fail when not caught.
 */
export async function stepNotRegisteredUncaught() {
  'use workflow';
  const ghost = (globalThis as any)[Symbol.for('WORKFLOW_USE_STEP')](
    'step//./workflows/99_e2e//anotherNonExistentStep'
  );
  // Don't catch — the step failure should propagate and fail the run
  return await ghost();
}

// ============================================================
// STATIC METHOD STEP/WORKFLOW TESTS
// ============================================================
// Tests for static methods on classes with "use step" and "use workflow" directives.
// ============================================================

/**
 * Service class with static step methods for math operations.
 * These methods are transformed to be callable as workflow steps.
 */
export class MathService {
  /** Static step: add two numbers */
  static async add(a: number, b: number): Promise<number> {
    'use step';
    return a + b;
  }

  /** Static step: multiply two numbers */
  static async multiply(a: number, b: number): Promise<number> {
    'use step';
    return a * b;
  }
}

/**
 * Workflow class with a static workflow method that uses static step methods.
 */
export class Calculator {
  /** Static workflow: uses MathService static step methods */
  static async calculate(x: number, y: number): Promise<number> {
    'use workflow';
    // Add x + y, then multiply by 2
    const sum = await MathService.add(x, y);
    const result = await MathService.multiply(sum, 2);
    return result;
  }
}

/**
 * Alternative pattern: both step and workflow methods in the same class.
 */
export class AllInOneService {
  static async double(n: number): Promise<number> {
    'use step';
    return n * 2;
  }

  static async triple(n: number): Promise<number> {
    'use step';
    return n * 3;
  }

  /** Static workflow: double(n) + triple(n) = 2n + 3n = 5n */
  static async processNumber(n: number): Promise<number> {
    'use workflow';
    const doubled = await AllInOneService.double(n);
    const tripled = await AllInOneService.triple(n);
    return doubled + tripled;
  }
}

/**
 * Class that uses `this` in static step methods to reference the class itself.
 * This tests that the class constructor is properly serialized when `this` is used.
 */
export class ChainableService {
  /** The multiplier used by the multiply step */
  static multiplier = 10;

  /** Static step that uses `this` to access class properties */
  static async multiplyByClassValue(
    this: typeof ChainableService,
    n: number
  ): Promise<number> {
    'use step';
    // Use `this` to reference the class and access its static property
    // `this` is the class constructor, so `this.multiplier` accesses the static property
    // biome-ignore lint/complexity/noThisInStatic: Testing `this` serialization for static methods
    return n * this.multiplier;
  }

  /** Static step that uses `this` to call another static method */
  static async doubleAndMultiply(
    this: typeof ChainableService,
    n: number
  ): Promise<number> {
    'use step';
    // Use `this` to access the static property on the class
    // Note: We can't call another step from within a step, so we just reference a static property
    // biome-ignore lint/complexity/noThisInStatic: Testing `this` serialization for static methods
    return n * 2 * this.multiplier;
  }

  /** Static workflow that demonstrates `this` serialization with static methods */
  static async processWithThis(n: number): Promise<{
    multiplied: number;
    doubledAndMultiplied: number;
    sum: number;
  }> {
    'use workflow';
    // When calling static methods via ClassName.method(), `this` inside the step
    // will be the class constructor (ChainableService). The class constructor
    // is serialized with its classId and passed to the step handler.
    //
    // NOTE: We use `ChainableService.method()` here instead of `this.method()` because
    // the `this` argument is not currently passed through when invoking a workflow via
    // `start()`. Workflows are executed as standalone functions, so `this` inside the
    // workflow body is undefined. This could be revisited in the future if needed.
    const multiplied = await ChainableService.multiplyByClassValue(n);
    const doubledAndMultiplied = await ChainableService.doubleAndMultiply(n);

    return {
      multiplied, // n * 10
      doubledAndMultiplied, // n * 2 * 10 = n * 20
      sum: multiplied + doubledAndMultiplied, // n * 10 + n * 20 = n * 30
    };
  }
}

//////////////////////////////////////////////////////////
// E2E test for `this` serialization with .call() and .apply()
//////////////////////////////////////////////////////////

/**
 * A step function that uses `this` to access properties.
 */
async function multiplyByFactor(this: { factor: number }, value: number) {
  'use step';
  return value * this.factor;
}

/**
 * Workflow that tests calling step functions with explicit `this` via .call() and .apply()
 */
export async function thisSerializationWorkflow(baseValue: number) {
  'use workflow';
  // Test .call() - multiply baseValue by 2
  const result1 = await multiplyByFactor.call({ factor: 2 }, baseValue);

  // Test .apply() - multiply result1 by 3
  const result2 = await multiplyByFactor.apply({ factor: 3 }, [result1]);

  // Test .call() again - multiply result2 by 5
  const result3 = await multiplyByFactor.call({ factor: 5 }, result2);

  // baseValue * 2 * 3 * 5 = baseValue * 30
  return result3;
}

//////////////////////////////////////////////////////////
// Custom Serialization E2E Test
//////////////////////////////////////////////////////////

/**
 * A custom class with user-defined serialization using Symbol.for() directly.
 * The SWC plugin detects these symbols and generates the classId and registration automatically.
 *
 * Note: The SWC plugin also supports named imports (WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE)
 * from the "@workflow/serde" package. We use Symbol.for() directly here for simplicity since
 * the SWC plugin has its own tests for the named import case.
 */
export class Point {
  constructor(
    public x: number,
    public y: number
  ) {}

  /** Custom serialization - converts instance to plain object */
  static [Symbol.for('workflow-serialize')](instance: Point) {
    return { x: instance.x, y: instance.y };
  }

  /** Custom deserialization - reconstructs instance from plain object */
  static [Symbol.for('workflow-deserialize')](data: { x: number; y: number }) {
    return new Point(data.x, data.y);
  }

  /** Helper method to compute distance from origin */
  distanceFromOrigin(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
}

/**
 * Step that receives a Point instance and returns a new Point
 */
async function transformPoint(point: Point, scale: number) {
  'use step';
  // Verify the point was properly deserialized and has its methods
  // (calling distanceFromOrigin proves the prototype chain is intact)
  console.log('Point distance from origin:', point.distanceFromOrigin());
  // Create and return a new Point (will be serialized on return)
  return new Point(point.x * scale, point.y * scale);
}

/**
 * Step that receives an array of Points
 */
async function sumPoints(points: Point[]) {
  'use step';
  let totalX = 0;
  let totalY = 0;
  for (const p of points) {
    totalX += p.x;
    totalY += p.y;
  }
  return new Point(totalX, totalY);
}

/**
 * Workflow that tests custom serialization of user-defined class instances.
 * The Point class uses WORKFLOW_SERIALIZE and WORKFLOW_DESERIALIZE symbols
 * to define how instances should be serialized/deserialized across the
 * workflow/step boundary.
 */
export async function customSerializationWorkflow(x: number, y: number) {
  'use workflow';

  // Create a Point instance
  const point = new Point(x, y);

  // Pass it to a step - tests serialization of workflow -> step
  const scaled = await transformPoint(point, 2);

  // The returned Point should also work - tests serialization of step -> workflow
  const scaledAgain = await transformPoint(scaled, 3);

  // Test with an array of Points
  const points = [new Point(1, 2), new Point(3, 4), new Point(5, 6)];
  const sum = await sumPoints(points);

  return {
    original: { x: point.x, y: point.y },
    scaled: { x: scaled.x, y: scaled.y },
    scaledAgain: { x: scaledAgain.x, y: scaledAgain.y },
    sum: { x: sum.x, y: sum.y },
  };
}

//////////////////////////////////////////////////////////
// Cross-Context Class Registration E2E Test
//////////////////////////////////////////////////////////

/**
 * Import step functions that use Vector - but we do NOT import Vector directly.
 * This tests that Vector class is registered in the workflow bundle even though
 * the workflow code never directly references it.
 */
import {
  addVectors,
  createVector,
  scaleVector,
  sumVectors,
} from './serde-steps';

/**
 * Workflow that tests cross-context class registration.
 *
 * IMPORTANT: This workflow does NOT import Vector directly. It only receives
 * Vector instances through step return values. The cross-context class registration
 * feature ensures Vector is registered in the workflow bundle even though
 * the workflow code never imports it.
 *
 * Test flow:
 * 1. Step creates Vector instance and returns it (step serializes)
 * 2. Workflow receives Vector (workflow deserializes - THIS IS THE KEY TEST)
 * 3. Workflow passes Vector to another step (workflow serializes)
 * 4. Step receives Vector and operates on it (step deserializes)
 * 5. Workflow returns results to client (as plain objects for simplicity)
 *
 * Without cross-context class registration, step 2 would fail because the
 * workflow bundle wouldn't have Vector registered for deserialization.
 */
export async function crossContextSerdeWorkflow() {
  'use workflow';

  // Step 1: Create a vector in the step
  // Tests: step creating instance -> workflow deserialization
  // This is the KEY test - workflow must be able to deserialize Vector
  // even though the workflow code never imports Vector
  const v1 = await createVector(1, 2, 3);

  // Step 2: Create another vector
  const v2 = await createVector(10, 20, 30);

  // Step 3: Pass the deserialized vectors back to a step
  // Tests: workflow serializing Vector instances it received from steps
  const sum = await addVectors(v1, v2);

  // Step 4: Scale one of the vectors
  // Tests: workflow passing a single deserialized Vector to step
  const scaled = await scaleVector(v1, 5);

  // Step 5: Sum an array of vectors
  // Tests: array serialization with Vector instances
  const vectors = [v1, v2, scaled];
  const arraySum = await sumVectors(vectors);

  // Return plain objects (not Vector instances) so the client doesn't need
  // to deserialize Vector - we're testing workflow deserialization, not client
  return {
    v1: { x: v1.x, y: v1.y, z: v1.z },
    v2: { x: v2.x, y: v2.y, z: v2.z },
    sum: { x: sum.x, y: sum.y, z: sum.z },
    scaled: { x: scaled.x, y: scaled.y, z: scaled.z },
    arraySum: { x: arraySum.x, y: arraySum.y, z: arraySum.z },
  };
}

//////////////////////////////////////////////////////////
// Built-in Error subclass round-trip
//////////////////////////////////////////////////////////

/**
 * Step that echoes an array of thrown values straight back through the
 * step return-value boundary. Used by `errorSubclassRoundTripWorkflow` to
 * verify that built-in Error subclasses survive the step serialization
 * boundary with their type identity, message, stack, and cause intact.
 */
async function echoErrors(errors: unknown[]): Promise<unknown[]> {
  'use step';
  return errors;
}

/**
 * Round-trips an array of built-in Error subclass instances through every
 * serialization boundary:
 *
 *   client (start args) → workflow → step (echoErrors) → workflow → client (return)
 *
 * This exercises the per-subclass reducers/revivers added in the
 * "Add first-class serialization for built-in Error subclasses" change.
 * Each subclass reducer must run BEFORE the generic Error reducer
 * (devalue is first-match-wins); a regression would silently downgrade
 * `TypeError` etc. to plain `Error` instances.
 */
export async function errorSubclassRoundTripWorkflow(
  errors: unknown[]
): Promise<unknown[]> {
  'use workflow';
  return await echoErrors(errors);
}

/**
 * A class with instance methods that are marked as steps.
 * This tests the new "use step" support for instance methods.
 * The class uses custom serialization so the `this` value can be
 * serialized across the workflow/step boundary.
 */
export class Counter {
  constructor(public value: number) {}

  /** Custom serialization - converts instance to plain object */
  static [Symbol.for('workflow-serialize')](instance: Counter) {
    return { value: instance.value };
  }

  /** Custom deserialization - reconstructs instance from plain object */
  static [Symbol.for('workflow-deserialize')](data: { value: number }) {
    return new Counter(data.value);
  }

  /**
   * Instance method step: returns the sum of the counter's value and the given amount.
   * The `this` context (the Counter instance) is serialized and passed
   * to the step handler, then deserialized before the method is called.
   */
  async add(amount: number): Promise<number> {
    'use step';
    return this.value + amount;
  }

  /**
   * Instance method step: multiplies the counter's value by the given factor.
   */
  async multiply(factor: number): Promise<number> {
    'use step';
    return this.value * factor;
  }

  /**
   * Instance method step: returns an object with both the original and computed values.
   * This tests that `this` is correctly preserved through the step execution.
   */
  async describe(label: string): Promise<{ label: string; value: number }> {
    'use step';
    return { label, value: this.value };
  }

  /**
   * Returns a "tool"-shaped object whose `add` property is a nested arrow
   * step that lexically captures `this`.
   *
   * This exercises the SWC plugin's lexical-`this` capture for nested arrow
   * step functions: in workflow mode the proxy is wrapped with
   * `.bind(this)` (so the queue item carries `thisVal`), and in step mode
   * the body is hoisted as a regular `function` (so `stepFn.apply(thisVal,
   * args)` can rebind). The captured `delta` exercises the closure-vars
   * path alongside it.
   *
   * This is structurally identical to the AI SDK `tool({ execute: async
   * (input) => { 'use step'; return this.x; } })` pattern from the
   * upstream issue (vercel/workflow#1865).
   */
  makeAdder(delta: number): {
    add: (amount: number) => Promise<number>;
  } {
    return {
      add: async (amount: number) => {
        'use step';
        return this.value + amount + delta;
      },
    };
  }
}

/**
 * Step that takes a step-function reference and invokes it. Used by
 * `instanceMethodStepWorkflow` to exercise the workflow→step→step
 * round-trip serialization of a `bind(this)`-wrapped step proxy.
 */
async function invokeAdderFromStep(
  add: (amount: number) => Promise<number>,
  amount: number
): Promise<number> {
  'use step';
  return add(amount);
}

/**
 * Workflow that tests instance method steps.
 * Creates Counter instances and calls their instance methods as steps.
 * The `this` context (the Counter instance) should be serialized and
 * correctly restored when the step executes.
 */
export async function instanceMethodStepWorkflow(initialValue: number) {
  'use workflow';

  // Create a Counter instance
  const counter = new Counter(initialValue);

  // Call instance method steps
  const added = await counter.add(10);
  const multiplied = await counter.multiply(3);
  const description = await counter.describe('test counter');

  // Create another counter to verify different instances work
  const counter2 = new Counter(100);
  const added2 = await counter2.add(50);

  // Lexical-`this` capture in a nested arrow step:
  //
  // `counter.makeAdder(7).add` is a step proxy that the SWC plugin wraps
  // with `.bind(this)` in workflow mode. Invoking it directly should
  // capture the Counter instance as `thisVal` so the step body sees
  // `this.value` correctly.
  const adder = counter.makeAdder(7);
  const adderResult = await adder.add(2); // initialValue + 2 + 7

  // Round-trip the bound step proxy through another step boundary:
  //
  // Passing `adder.add` as a step argument forces the
  // `getStepFunctionReducer` to capture the bound `this` (`__boundThis`)
  // alongside the `stepId`, and the step bundle's reviver must re-bind
  // the freshly created proxy so the inner step still sees the original
  // Counter instance via `this`.
  const adderViaStep = await invokeAdderFromStep(adder.add, 3); // initialValue + 3 + 7

  return {
    initialValue,
    added, // initialValue + 10
    multiplied, // initialValue * 3
    description, // { label: 'test counter', value: initialValue }
    added2, // 100 + 50 = 150
    adderResult, // initialValue + 2 + 7
    adderViaStep, // initialValue + 3 + 7
  };
}

//////////////////////////////////////////////////////////
// Step Function Reference as start() Argument E2E Test
//////////////////////////////////////////////////////////

/**
 * A step function that invokes a step function reference passed to it.
 * This is called from within the workflow to execute the passed step function.
 */
async function invokeStepFn(
  stepFn: (a: number, b: number) => Promise<number>,
  x: number,
  y: number
): Promise<number> {
  'use step';
  // Call the step function reference that was passed in
  return await stepFn(x, y);
}

/**
 * Workflow that receives a step function reference as an argument from start().
 * This tests that:
 * 1. Step function references can be serialized in the client bundle (via stepId property)
 * 2. The serialized step function can be deserialized in the workflow bundle
 * 3. The deserialized step function can be invoked DIRECTLY from workflow code
 * 4. The deserialized step function can also be invoked from within another step
 */
export async function stepFunctionAsStartArgWorkflow(
  stepFn: (a: number, b: number) => Promise<number>,
  x: number,
  y: number
): Promise<{ directResult: number; viaStepResult: number; doubled: number }> {
  'use workflow';

  // CRITICAL TEST: Call the passed step function DIRECTLY from workflow code
  // This tests that the deserialized step function has the useStep wrapper,
  // allowing it to be scheduled as a proper step (not executed inline)
  const directResult = await stepFn(x, y);

  // Also test invoking via another step (this already worked before)
  const viaStepResult = await invokeStepFn(stepFn, x, y);

  // Do another operation to verify the workflow continues normally
  const doubled = await stepFn(directResult, directResult);

  return { directResult, viaStepResult, doubled };
}

//////////////////////////////////////////////////////////
// AbortController / AbortSignal e2e tests
//////////////////////////////////////////////////////////

/**
 * Step that performs a long-running operation respecting an AbortSignal.
 * Loops with 500ms delays, checking signal.aborted each iteration.
 */
async function longStep(signal: AbortSignal): Promise<string> {
  'use step';
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) {
      return 'aborted';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 'completed';
}

/**
 * Step that returns immediately with the signal's current aborted state.
 */
async function checkSignalState(signal: AbortSignal): Promise<{
  aborted: boolean;
  reason: unknown;
}> {
  'use step';
  return { aborted: signal.aborted, reason: signal.reason };
}

/**
 * Step that (optionally) waits, then calls `abort()` on the controller.
 * The delay lets a sibling step start running before the abort fires —
 * used by `abortFromStepWorkflow` to verify the in-flight sibling actually
 * receives the cancellation packet through the backing stream.
 */
async function abortFromStep(
  controller: AbortController,
  delayMs = 0
): Promise<void> {
  'use step';
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  controller.abort('aborted from step');
}

/**
 * Step that uses fetch with an AbortSignal.
 * Uses a URL that intentionally delays, so the abort cancels it.
 *
 * Accepts a list of URLs and tries them in order, falling back to the
 * next on 5xx (or non-AbortError network failure) so a single bad upstream
 * doesn't flake the abort-fetch tests. Empirically, httpbin.org returns
 * 502 from GH Actions runners often enough to dominate CI flakiness;
 * pairing it with a second slow endpoint gives both belt and suspenders.
 *
 * Reports `status`, `elapsedMs`, and the `url` that resolved so that when
 * the abort-fetch tests do fail, the assertion message shows exactly what
 * the upstream(s) returned instead of leaving us guessing why the race
 * winner was `fetch` instead of `timeout`.
 */
async function fetchWithSignal(
  urls: readonly string[],
  signal: AbortSignal
): Promise<{
  ok: boolean;
  aborted: boolean;
  status?: number;
  url?: string;
  elapsedMs: number;
  attempts: { url: string; status?: number; error?: string }[];
}> {
  'use step';
  const startedAt = Date.now();
  const attempts: { url: string; status?: number; error?: string }[] = [];
  for (const url of urls) {
    try {
      const response = await globalThis.fetch(url, { signal });
      attempts.push({ url, status: response.status });
      if (response.ok) {
        return {
          ok: true,
          aborted: false,
          status: response.status,
          url,
          elapsedMs: Date.now() - startedAt,
          attempts,
        };
      }
      // Non-2xx — fall through and try the next URL.
    } catch (err: any) {
      if (err.name === 'AbortError') {
        attempts.push({ url, error: 'AbortError' });
        return {
          ok: false,
          aborted: true,
          elapsedMs: Date.now() - startedAt,
          attempts,
        };
      }
      attempts.push({ url, error: err?.message ?? String(err) });
      // Network error — fall through and try the next URL.
    }
  }
  return {
    ok: false,
    aborted: false,
    elapsedMs: Date.now() - startedAt,
    attempts,
  };
}

// Slow endpoints used by the abort-fetch e2e tests. Tried in order; postman-
// echo first because httpbin.org has historically returned 502s from GH
// Actions. Both cap at /delay/10 in practice, which is comfortably longer
// than the 2s race threshold these tests use.
const SLOW_FETCH_URLS = [
  'https://postman-echo.com/delay/10',
  'https://httpbin.org/delay/10',
] as const;

/**
 * E2E: Basic timeout cancellation.
 * Creates controller in workflow, races step vs sleep, aborts on timeout.
 */
export async function abortTimeoutWorkflow() {
  'use workflow';

  const controller = new AbortController();

  const result = await Promise.race([
    longStep(controller.signal),
    sleep('3s').then(() => 'timeout' as const),
  ]);

  if (result === 'timeout') {
    controller.abort();
    return { status: 'timed out', aborted: controller.signal.aborted };
  }

  return { status: 'completed', result };
}

/**
 * E2E: Signal passed to multiple parallel steps, abort cancels all.
 */
export async function abortParallelWorkflow() {
  'use workflow';

  const controller = new AbortController();

  const result = await Promise.race([
    Promise.all([
      longStep(controller.signal),
      longStep(controller.signal),
      longStep(controller.signal),
    ]),
    sleep('3s').then(() => 'timeout' as const),
  ]);

  if (result === 'timeout') {
    controller.abort();
    return { status: 'timed out' };
  }

  return { status: 'completed', results: result };
}

/**
 * E2E: One step aborts a controller; an in-flight sibling step is cancelled.
 *
 * Runs `longStep` (a 30s busy-wait that polls `signal.aborted` every 500ms)
 * in parallel with `abortFromStep` (which sleeps 1s, then calls `abort()`).
 * The cancellation has to propagate from the aborting step → workflow's
 * backing stream → the polling step's local AbortController, so the polling
 * step sees `signal.aborted` flip and exits via the abort branch instead of
 * running to its 30s natural completion. After the parallel work, we also
 * verify the workflow VM's signal sees the abort (round-trip via hook event).
 */
export async function abortFromStepWorkflow() {
  'use workflow';

  const controller = new AbortController();

  // Run a long-polling step in parallel with a step that aborts after 1s.
  // longStep returns 'aborted' if it saw signal.aborted=true mid-flight,
  // 'completed' if it ran the full 30s without seeing the abort.
  const [longStepResult] = await Promise.all([
    longStep(controller.signal),
    abortFromStep(controller, 1000),
  ]);

  // After both steps finish, check that the workflow's signal also reflects
  // the abort (the hook event resumed the controller in the workflow VM).
  const state = await checkSignalState(controller.signal);

  return {
    workflowAborted: controller.signal.aborted,
    stepSawAborted: state.aborted,
    longStepResult,
  };
}

/**
 * E2E: Already-aborted signal passed to step.
 */
export async function abortAlreadyAbortedWorkflow() {
  'use workflow';

  const controller = new AbortController();
  controller.abort('pre-aborted');

  const state = await checkSignalState(controller.signal);

  return {
    aborted: state.aborted,
    reason: state.reason,
  };
}

/**
 * E2E: Abort reason is preserved.
 */
export async function abortReasonWorkflow() {
  'use workflow';

  const controller = new AbortController();

  const raceResult = await Promise.race([
    longStep(controller.signal),
    sleep('2s').then(() => 'timeout' as const),
  ]);

  if (raceResult === 'timeout') {
    controller.abort('custom timeout reason');
  }

  const state = await checkSignalState(controller.signal);
  return {
    aborted: state.aborted,
    reason: state.reason,
  };
}

/**
 * E2E: Abort after all steps complete (no-op, no error).
 */
export async function abortAfterCompletionWorkflow() {
  'use workflow';

  const controller = new AbortController();
  const state = await checkSignalState(controller.signal);

  // Abort after the step already completed
  controller.abort();

  return {
    stepSawAborted: state.aborted,
    workflowAborted: controller.signal.aborted,
  };
}

/**
 * E2E: User-triggered cancellation via hook + abort controller.
 */
export async function abortViaHookWorkflow(hookToken: string) {
  'use workflow';

  using cancelHook = createHook<{ reason: string }>({
    token: hookToken,
  });

  const controller = new AbortController();

  const result = await Promise.race([
    longStep(controller.signal).then((r) => ({
      status: 'completed' as const,
      result: r,
    })),
    cancelHook.then((payload) => {
      controller.abort(payload.reason);
      return { status: 'cancelled' as const, reason: payload.reason };
    }),
  ]);

  return result;
}

/**
 * E2E: AbortSignal passed as workflow input from external code.
 */
export async function abortExternalSignalWorkflow(signal: AbortSignal) {
  'use workflow';

  const state = await checkSignalState(signal);
  return { aborted: state.aborted, reason: state.reason };
}

/**
 * E2E: External signal NOT aborted at serialization time, aborted later
 * while in-flight steps are consuming it.
 *
 * This is the harder external-signal path that abortExternalSignalWorkflow
 * doesn't cover. The caller (test process) creates a fresh AbortController,
 * passes its signal as workflow input, and aborts it ~1.5s later via the
 * source controller's `abort()`. The serialization-time listener attached
 * in `getExternalReducers` writes the cancellation packet to the backing
 * stream when fired; the in-flight steps' deserialized signals — both a
 * polling step and a listener-based step running in parallel — must see
 * the abort propagate mid-flight.
 *
 * Failure mode if propagation breaks:
 *   - pollResult: 'completed' (longStep ran the full 30s without seeing aborted=true)
 *   - listenerResult.via: 'timeout' (addEventListener callback never fired)
 */
export async function abortExternalSignalInFlightWorkflow(signal: AbortSignal) {
  'use workflow';

  // Run two consumption patterns in parallel against the same external signal:
  // a polling step (reads signal.aborted) and a listener step (addEventListener).
  // Both must see the abort propagate from the external controller into their
  // respective deserialized signals while the steps are mid-flight.
  const [pollResult, listenerResult] = await Promise.all([
    longStep(signal),
    stepWaitingOnAbortListener(signal),
  ]);

  return { pollResult, listenerResult };
}

/**
 * E2E: `AbortSignal.any` composing signals INSIDE the workflow VM.
 *
 * The workflow VM provides its own `AbortSignal.any` impl
 * (workflow/abort-controller.ts) that produces a `WorkflowAbortSignal`
 * composite which listens to each source `WorkflowAbortSignal` via
 * `addEventListener`. When any source aborts, the composite fires
 * synchronously through the VM's listener firing path — no stream packet,
 * no replay round-trip, just in-VM signal composition.
 */
export async function abortAnyInWorkflowWorkflow() {
  'use workflow';
  const c1 = new AbortController();
  const c2 = new AbortController();
  const combined = AbortSignal.any([c1.signal, c2.signal]);

  const beforeCombinedAborted = combined.aborted;

  // Abort c2; the composite must reflect the abort synchronously
  // (the WorkflowAbortSignal listener fires sync inside the VM).
  c2.abort('via c2');

  const afterCombinedAborted = combined.aborted;
  const afterCombinedReason = combined.reason;
  const c1Aborted = c1.signal.aborted;

  return {
    beforeCombinedAborted,
    afterCombinedAborted,
    afterCombinedReason,
    c1Aborted,
  };
}

/**
 * E2E: `AbortSignal.any` INSIDE a step.
 *
 * The step receives two deserialized native `AbortSignal`s (revived via
 * `reviveAbortSignal`) and composes them with the native `AbortSignal.any`.
 * A sibling step aborts one of the source controllers ~1s in. The chain
 * that has to work: source controller aborts → workflow VM signal flips →
 * stream packet written → step's deserialized signal fires → composite from
 * `AbortSignal.any` fires → user listener fires.
 */
export async function abortAnyInStepWorkflow() {
  'use workflow';
  const c1 = new AbortController();
  const c2 = new AbortController();

  const [stepResult] = await Promise.all([
    stepCombiningSignals(c1.signal, c2.signal),
    abortFromStep(c2, 1000),
  ]);

  // Step-initiated aborts update workflow-side signal state when replay
  // processes hook_received at a suspension boundary.
  await sleep('100ms');

  return {
    stepResult,
    c1Aborted: c1.signal.aborted,
    c2Aborted: c2.signal.aborted,
  };
}

/**
 * E2E: Controller survives workflow replay (sleep causes suspension/resumption).
 */
export async function abortSurvivesReplayWorkflow() {
  'use workflow';

  const controller = new AbortController();

  // First step
  const before = await checkSignalState(controller.signal);

  // Sleep causes workflow to suspend and replay
  await sleep('1s');

  // Abort after replay
  controller.abort('after-replay');

  // Second step sees the abort
  const after = await checkSignalState(controller.signal);

  return {
    beforeAborted: before.aborted,
    afterAborted: after.aborted,
    afterReason: after.reason,
  };
}

/**
 * E2E: throwIfAborted() causes FatalError (no retries).
 * Step calls throwIfAborted() on an already-aborted signal.
 * The DOMException should be wrapped in FatalError, skip retries,
 * and propagate to the workflow.
 */
export async function abortThrowIfAbortedWorkflow() {
  'use workflow';

  const controller = new AbortController();
  controller.abort('throw-test-reason');

  try {
    await stepThatThrowsIfAborted(controller.signal);
    return { threw: false };
  } catch (err: any) {
    return {
      threw: true,
      message: err.message,
      isFatal: err.name === 'FatalError' || err.fatal === true,
    };
  }
}

async function stepThatThrowsIfAborted(signal: AbortSignal) {
  'use step';
  signal.throwIfAborted();
  return 'should not reach here';
}

/**
 * Step that resolves via `signal.addEventListener('abort', ...)`. Tests the
 * listener path on the deserialized signal — the path fetch's internal
 * cancellation uses, but invoked directly. Resolves with `via: 'listener'`
 * if the listener fired, or `via: 'timeout'` if propagation failed and the
 * 30s safety timeout won.
 *
 * No `signal.aborted` short-circuit: we rely solely on the listener firing.
 * Per the AbortSignal spec, calling addEventListener on an already-aborted
 * signal fires the callback (on a microtask), so any code path that breaks
 * that contract — present or future — surfaces as a 'timeout' result here
 * instead of being masked by a synchronous fast-path.
 */
async function stepWaitingOnAbortListener(
  signal: AbortSignal
): Promise<{ saw: boolean; via: 'listener' | 'timeout' }> {
  'use step';
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({ saw: true, via: 'listener' });
    };
    signal.addEventListener('abort', onAbort);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve({ saw: signal.aborted, via: 'timeout' });
    }, 30_000);
  });
}

/**
 * Step that polls `signal.throwIfAborted()` every 500ms. When the abort
 * fires mid-flight, throwIfAborted throws a DOMException — which the step
 * handler wraps as FatalError before it reaches the workflow. Returns the
 * natural-completion value if propagation fails and the loop runs out.
 */
async function stepPollingThrowIfAborted(signal: AbortSignal): Promise<string> {
  'use step';
  for (let i = 0; i < 60; i++) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 'completed';
}

/**
 * Step that combines two abort signals with native `AbortSignal.any` and
 * waits for the composite to fire via addEventListener. The composite is
 * a real native AbortSignal (Node's `AbortSignal.any`); each input signal
 * is the deserialized step-side native AbortSignal. Tests that the listener
 * chain (source signal aborts → composite fires → user listener fires)
 * works end-to-end through the deserialization layer.
 */
async function stepCombiningSignals(
  s1: AbortSignal,
  s2: AbortSignal
): Promise<{ saw: boolean; via: 'listener' | 'timeout' }> {
  'use step';
  const combined = AbortSignal.any([s1, s2]);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({ saw: true, via: 'listener' });
    };
    combined.addEventListener('abort', onAbort);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      combined.removeEventListener('abort', onAbort);
      resolve({ saw: combined.aborted, via: 'timeout' });
    }, 30_000);
  });
}

/**
 * E2E: Abort reason propagation with various types.
 * Tests that string, object, and undefined reasons all propagate correctly.
 */
export async function abortReasonTypesWorkflow() {
  'use workflow';

  const c1 = new AbortController();
  c1.abort('string-reason');
  const s1 = await checkSignalState(c1.signal);

  const c2 = new AbortController();
  c2.abort({ code: 'CANCELLED', detail: 'by user' });
  const s2 = await checkSignalState(c2.signal);

  const c3 = new AbortController();
  c3.abort();
  const s3 = await checkSignalState(c3.signal);

  return {
    stringReason: s1,
    objectReason: s2,
    undefinedReason: s3,
  };
}

/**
 * E2E: Aborting an in-flight fetch.
 *
 * Exercises the deserialized signal's listener path that no other abort test
 * covers: signal starts non-aborted, the step kicks off a fetch against a
 * slow endpoint, the workflow's abort() fires while fetch is still awaiting
 * the response, and fetch's internal abort listener (registered via
 * addEventListener on the signal) cancels the in-flight HTTP request.
 *
 * If propagation is broken — e.g. listeners don't fire on the deserialized
 * signal, or the cancellation stream packet isn't written — the fetch runs
 * to natural completion and `aborted` is `false`.
 */
export async function abortFetchInFlightWorkflow() {
  'use workflow';

  const controller = new AbortController();
  // SLOW_FETCH_URLS holds the response open for ~10s — used here as a slow
  // endpoint that the abort can cancel mid-flight. Same external-service
  // pattern as other e2e workflows in this file (jsonplaceholder, example.com).
  // Avoids needing a per-workbench /api/delay route, which would only exist
  // on the one workbench it was added to. The step falls back to the second
  // URL only if the first returns a 5xx or non-AbortError network failure,
  // so a transient outage on one upstream doesn't flake the test.
  const fetchPromise = fetchWithSignal(SLOW_FETCH_URLS, controller.signal);

  // Race the fetch against a 2s sleep. Sleep wins; abort fires.
  const winner = await Promise.race([
    fetchPromise.then(() => 'fetch' as const),
    sleep('2s').then(() => 'timeout' as const),
  ]);

  if (winner === 'timeout') {
    // Abort with no reason — defaults to a DOMException("AbortError") so
    // fetch's rejection is an Error-shaped value the step can catch by
    // `err.name === 'AbortError'`. (Per WHATWG fetch, `controller.abort(x)`
    // with a non-Error `x` would cause fetch to reject with `x` directly,
    // bypassing the AbortError check in `fetchWithSignal`.)
    controller.abort();
  }

  // Always await the fetch to see how it ended. The step's catch path returns
  // `{ ok: false, aborted: true }` if fetch saw the abort, or `{ ok: true,
  // aborted: false }` if propagation failed and the request ran to completion.
  const fetchResult = await fetchPromise;
  return { winner, fetchResult };
}

/**
 * E2E: The "simpler" timeout pattern documented on the
 * `abort-signal-timeout-in-workflow` error page —
 * `void sleep("Ns").then(() => controller.abort())` followed by a single
 * awaited step that consumes `controller.signal`. Validates the doc's
 * recommended replacement for `AbortSignal.timeout()` actually works
 * end-to-end.
 *
 * If the in-flight fetch finishes within the timeout, the step returns
 * normally. If the sleep wins, the .then fires `abort()`, the abort
 * propagates to the in-flight step's signal via the backing stream, fetch
 * cancels, and the step's catch path returns `{ ok: false, aborted: true }`.
 */
export async function abortVoidSleepTimeoutWorkflow() {
  'use workflow';

  const controller = new AbortController();
  void sleep('2s').then(() => controller.abort());

  return await fetchWithSignal(SLOW_FETCH_URLS, controller.signal);
}

/**
 * E2E: Uncaught fetch AbortError propagates as FatalError (no retries).
 * The step does NOT catch the AbortError from fetch — it should propagate
 * as a FatalError to the workflow without the step being retried.
 */
export async function abortFetchUncaughtWorkflow() {
  'use workflow';

  const controller = new AbortController();

  // Abort without a custom reason so fetch rejects with AbortError. Supplying
  // a reason makes fetch reject with that value directly, which is retryable.
  controller.abort();

  try {
    await stepThatFetchesWithSignal(controller.signal);
    return { threw: false };
  } catch (err: any) {
    return {
      threw: true,
      message: err.message,
      isFatal: err.name === 'FatalError' || err.fatal === true,
    };
  }
}

async function stepThatFetchesWithSignal(signal: AbortSignal) {
  'use step';
  // This will throw AbortError because the signal is already aborted.
  // The error should NOT be caught here — it propagates to the workflow
  // as a FatalError (wrapped by the step handler).
  const response = await globalThis.fetch('https://example.com', { signal });
  return response.status;
}

/**
 * E2E: Deterministic branching — if-check on signal.aborted takes same path
 * on first-run and replay.
 *
 * On first run: abort() hasn't been called yet, signal.aborted is false,
 * takes the else branch. On replay: hook_received was processed but
 * signal.aborted must STILL be false until abort() is called, so the
 * else branch is taken again. This ensures deterministic code paths.
 */
export async function abortDeterministicBranchWorkflow() {
  'use workflow';

  const controller = new AbortController();

  // This if-check MUST take the same branch on both first-run and replay.
  // If signal.aborted were set during event replay (before this code runs),
  // the if-branch would be taken on replay but not on first-run.
  let result: string;
  if (controller.signal.aborted) {
    result = 'was aborted'; // Should NEVER happen
  } else {
    controller.abort('test');
    result = 'just aborted'; // Should ALWAYS happen
  }

  // After abort(), signal.aborted should be true
  const state = await checkSignalState(controller.signal);

  return {
    result,
    aborted: state.aborted,
    reason: state.reason,
  };
}

/**
 * E2E: Listener-based reaction to abort. Tests that
 * `signal.addEventListener('abort', ...)` on the deserialized step-side
 * signal actually fires when the cancellation packet arrives — the same
 * path fetch's internal cancellation uses, but exercised directly so a
 * regression here can't be papered over by fetch-specific behavior.
 */
export async function abortListenerWorkflow() {
  'use workflow';
  const controller = new AbortController();

  // Listener step + delayed-abort step run in parallel. If listener
  // propagation works, the listener resolves the step within ~1s.
  const [stepResult] = await Promise.all([
    stepWaitingOnAbortListener(controller.signal),
    abortFromStep(controller, 1000),
  ]);

  return { stepResult };
}

/**
 * E2E: `throwIfAborted()` mid-flight. Distinct from
 * `abortThrowIfAbortedWorkflow` which only tests the synchronous-throw case
 * on an already-aborted signal. Here the signal starts non-aborted, the step
 * polls `signal.throwIfAborted()` in a loop, and a sibling step aborts after
 * 1s. The DOMException thrown by `throwIfAborted` should bubble out of the
 * step as a FatalError (no retries) and propagate to the workflow.
 */
export async function abortThrowIfAbortedMidFlightWorkflow() {
  'use workflow';
  const controller = new AbortController();

  try {
    const [result] = await Promise.all([
      stepPollingThrowIfAborted(controller.signal),
      abortFromStep(controller, 1000),
    ]);
    return { threw: false, result };
  } catch (err: any) {
    return {
      threw: true,
      message: err.message,
      isFatal: err.name === 'FatalError' || err.fatal === true,
    };
  }
}

/**
 * E2E: Deterministic branching when the abort comes from a STEP (not the
 * workflow body itself). Counterpart to `abortDeterministicBranchWorkflow`,
 * which tests the case where the workflow code calls `abort()` directly.
 *
 * The pair of `signal.aborted` reads must each take the same branch on the
 * first run and on every replay — even though the abort is recorded as a
 * `hook_received` event written by a step that runs on a different compute
 * instance. If signal.aborted flipped at the wrong logical point during
 * replay (e.g. immediately when the events consumer first sees the event,
 * rather than chained through promiseQueue at the suspension boundary that
 * matches the original flow), the branches would diverge across runs.
 */
export async function abortDeterministicBranchFromStepWorkflow() {
  'use workflow';
  const controller = new AbortController();

  // Pre-abort read. MUST be false on first-run AND replay.
  const beforeAborted = controller.signal.aborted;
  let beforeBranch: string;
  if (beforeAborted) {
    beforeBranch = 'unexpected-aborted'; // Should NEVER happen
  } else {
    beforeBranch = 'pre-abort'; // Should ALWAYS happen
  }

  // Step that aborts the controller via the patched abort() path. Writes
  // hook_received to the event log (and a stream cancellation packet) before
  // returning.
  await abortFromStep(controller);

  // A suspension is required after the step before the workflow's signal
  // reflects the abort. Step-initiated aborts go through the events consumer:
  // when `hook_received` is processed during replay, `signal._setAborted` is
  // chained on `promiseQueue.then(...)` in `workflow/abort-controller.ts`,
  // which only runs at the next checkpoint that drains the promise queue —
  // not synchronously after the step's await resolves. This mirrors how
  // step return values become visible: only at a suspension boundary.
  await sleep('1s');

  // Post-abort read. MUST be true on first-run AND replay — the events
  // consumer has now drained `_setAborted` for the hook_received event.
  const afterAborted = controller.signal.aborted;
  let afterBranch: string;
  if (afterAborted) {
    afterBranch = 'post-abort'; // Should ALWAYS happen
  } else {
    afterBranch = 'unexpected-not-aborted'; // Should NEVER happen
  }

  return {
    beforeAborted,
    beforeBranch,
    afterAborted,
    afterBranch,
  };
}

/**
 * Helper step that records its argument to a log array and returns it.
 */
async function logStep(entry: string): Promise<string> {
  'use step';
  return entry;
}

/**
 * E2E: Abort + Hook ordering matrix.
 *
 * Tests all 4 combinations of:
 * - Listener registration order (abort listener first vs hook.then first)
 * - Event trigger order (abort first vs resumeHook first)
 *
 * Each combination must produce a deterministic log order on both
 * first-run and replay.
 *
 * The `variant` parameter selects which combination to test:
 * - "listener-first-abort-first": addEventListener → hook.then → abort() → resumeHook
 * - "listener-first-hook-first":  addEventListener → hook.then → resumeHook → abort()
 * - "hook-first-abort-first":     hook.then → addEventListener → abort() → resumeHook
 * - "hook-first-hook-first":      hook.then → addEventListener → resumeHook → abort()
 */
export async function abortHookOrderingWorkflow(
  hookToken: string,
  variant: string
) {
  'use workflow';

  const controller = new AbortController();
  using hook = createHook<{ value: string }>({ token: hookToken });
  const log: string[] = [];

  if (variant === 'listener-first-abort-first') {
    // Register abort listener first, then hook.then
    controller.signal.addEventListener('abort', () => {
      log.push('abort-listener');
    });
    void hook.then(async (payload) => {
      log.push('hook-resolved:' + payload.value);
    });
    // Trigger abort first (hook resumed externally after)
    controller.abort();
    log.push('after-abort');
  } else if (variant === 'listener-first-hook-first') {
    // Register abort listener first, then hook.then
    controller.signal.addEventListener('abort', () => {
      log.push('abort-listener');
    });
    void hook.then(async (payload) => {
      log.push('hook-resolved:' + payload.value);
    });
    // Hook is resumed externally first, then abort
    // (we await a step to give the hook time to be resumed)
    await logStep('waiting');
    controller.abort();
    log.push('after-abort');
  } else if (variant === 'hook-first-abort-first') {
    // Register hook.then first, then abort listener
    void hook.then(async (payload) => {
      log.push('hook-resolved:' + payload.value);
    });
    controller.signal.addEventListener('abort', () => {
      log.push('abort-listener');
    });
    // Trigger abort first
    controller.abort();
    log.push('after-abort');
  } else if (variant === 'hook-first-hook-first') {
    // Register hook.then first, then abort listener
    void hook.then(async (payload) => {
      log.push('hook-resolved:' + payload.value);
    });
    controller.signal.addEventListener('abort', () => {
      log.push('abort-listener');
    });
    // Hook resumed externally first, then abort
    await logStep('waiting');
    controller.abort();
    log.push('after-abort');
  }

  // Wait long enough for the test harness to resume the hook (test sleeps
  // a few seconds before resumeHook). The `void hook.then(...)` callback
  // appends 'hook-resolved:hello' to the log on replay once the hook is
  // received; this sleep keeps the workflow alive so that resumption lands
  // before the workflow returns and `using hook` disposes it.
  await sleep('10s');

  return log;
}

//////////////////////////////////////////////////////////

async function processPayload(payload: { type: string; id?: number }) {
  'use step';
  return { processed: true, type: payload.type, id: payload.id };
}

/**
 * Workflow that uses a hook with concurrent sleep — tests that multiple
 * hook payloads are delivered correctly even when a sleep has no wait_completed.
 *
 * This is a regression test for a bug where the sleep's WorkflowSuspension
 * would terminate the workflow before all hook payloads were processed.
 */
export async function hookWithSleepWorkflow(token: string) {
  'use workflow';

  type Payload = { type: string; id?: number; done?: boolean };

  using hook = createHook<Payload>({ token });

  // Concurrent sleep that won't complete during the test
  void sleep('1d');

  const results: any[] = [];

  for await (const payload of hook) {
    // Process each payload through a step to prove we reached it
    const result = await processPayload(payload);
    results.push(result);

    if (payload.done) {
      break;
    }
  }

  return results;
}

//////////////////////////////////////////////////////////

/**
 * https://github.com/vercel/workflow/pull/1528 Regression test for false-positive
 * unconsumed event in for-await hook loops with steps: a hook iteration with
 * an unawaited sleep where the step is only invoked on the final payload.
 * The replay event log ends up with two `hook_received` events before a
 * single `step_created`, which is the exact shape that triggered the
 * false-positive "Corrupted event log" error in production.
 */
export async function hookWithSleepFinalStepWorkflow(token: string) {
  'use workflow';

  type Payload = { type: string; id?: number; done?: boolean };

  using hook = createHook<Payload>({ token });

  // Fire-and-forget timeout — the "concurrent pending entity" that interacts
  // with the hook iteration during replay.
  void sleep('1d');

  const seen: number[] = [];
  let finalResult: any;

  for await (const payload of hook) {
    if (typeof payload.id === 'number') {
      seen.push(payload.id);
    }
    if (payload.done) {
      finalResult = await processPayload(payload);
      break;
    }
  }

  return { seen, finalResult };
}

//////////////////////////////////////////////////////////

async function addNumbers(a: number, b: number) {
  'use step';
  return a + b;
}

/**
 * Validates that sleep() inside a loop with step calls actually delays
 * execution on each iteration (i.e., sleeps are honored on replay, not skipped).
 *
 * Reproduces the scenario from a user report claiming that:
 *   for (let i = 0; i < N; i++) {
 *     await someStep();
 *     await sleep(duration);
 *   }
 * ...fires all iterations instantly with zero delay.
 */
async function noopStep(iteration: number) {
  'use step';
  return { iteration, ts: Date.now() };
}

export async function sleepInLoopWorkflow() {
  'use workflow';
  const iterations = 3;
  const sleepMs = 3_000; // 3s between iterations (2 sleeps total)
  const timestamps: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const result = await noopStep(i);
    timestamps.push(result.ts);
    if (i < iterations - 1) {
      await sleep(sleepMs);
    }
  }

  const totalElapsed = timestamps[timestamps.length - 1] - timestamps[0];
  return { timestamps, totalElapsed };
}

//////////////////////////////////////////////////////////

/**
 * Control workflow: sleep + sequential steps (no hooks).
 * Proves that void sleep().then() does NOT interfere with sequential steps
 * whose events all exist in the log. This is a control test to show
 * the promiseQueue regression is specific to hooks.
 */
export async function sleepWithSequentialStepsWorkflow() {
  'use workflow';

  // Fire-and-forget sleep (same pattern as agent-stop)
  let shouldCancel = false;
  void sleep('1d').then(() => {
    shouldCancel = true;
  });

  const a = await addNumbers(1, 2);
  const b = await addNumbers(a, 3);
  const c = await addNumbers(b, 4);
  return { a, b, c, shouldCancel };
}

//////////////////////////////////////////////////////////

/**
 * Validates that import.meta.url is correctly polyfilled in CJS step bundles
 * and natively available in ESM step bundles.
 */
async function checkImportMetaUrl(): Promise<{
  isDefined: boolean;
  type: string;
  isFileUrl: boolean;
}> {
  'use step';
  const url = import.meta.url;
  return {
    isDefined: typeof url === 'string' && url.length > 0,
    type: typeof url,
    isFileUrl: typeof url === 'string' && url.startsWith('file://'),
  };
}

export async function importMetaUrlWorkflow() {
  'use workflow';
  return await checkImportMetaUrl();
}

//////////////////////////////////////////////////////////
// Regression test for #1577:
// getWorkflowMetadata()/getStepMetadata() called from a module-level helper
// function (not directly inside the step body) must still have access to the
// AsyncLocalStorage context.

const withStrictMetadataCheck = async <T>(fn: () => Promise<T>) => {
  const workflowMetadata = getWorkflowMetadata();
  const stepMetadata = getStepMetadata();

  return await fn().then((result) => ({
    result,
    workflowMetadata,
    stepMetadata,
  }));
};

async function metadataHelperStep(label: string): Promise<{
  label: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
}> {
  'use step';

  const { workflowMetadata, stepMetadata } = await withStrictMetadataCheck(
    async () => label
  );

  return {
    label,
    workflowRunId: workflowMetadata.workflowRunId,
    stepId: stepMetadata.stepId,
    attempt: stepMetadata.attempt,
  };
}

export async function metadataFromHelperWorkflow(label: string): Promise<{
  label: string;
  workflowRunId: string;
  stepId: string;
  attempt: number;
}> {
  'use workflow';

  return await metadataHelperStep(label);
}

//////////////////////////////////////////////////////////
// Getter Step Tests
//////////////////////////////////////////////////////////

/**
 * A class with a getter method marked as a step.
 * This tests the "use step" support for getter functions.
 * The class uses custom serialization so the `this` value can be
 * serialized across the workflow/step boundary.
 */
export class Sensor {
  constructor(
    public baseValue: number,
    public multiplier: number
  ) {}

  static [Symbol.for('workflow-serialize')](instance: Sensor) {
    return { baseValue: instance.baseValue, multiplier: instance.multiplier };
  }

  static [Symbol.for('workflow-deserialize')](data: {
    baseValue: number;
    multiplier: number;
  }) {
    return new Sensor(data.baseValue, data.multiplier);
  }

  /** Getter step: accessing this property triggers a step invocation */
  get reading() {
    'use step';
    return this.baseValue * this.multiplier;
  }

  /** Regular instance method step for comparison */
  async calibrate(offset: number): Promise<number> {
    'use step';
    return this.baseValue * this.multiplier + offset;
  }
}

/**
 * Workflow that tests getter steps on a class instance.
 * Uses `await instance.prop` to trigger step invocations via getters.
 */
export async function getterStepWorkflow(
  base: number,
  multiplier: number,
  offset: number
) {
  'use workflow';

  const sensor = new Sensor(base, multiplier);

  // Getter step: `await sensor.reading` triggers a step invocation
  const reading = await sensor.reading;

  // Regular instance method step for comparison
  const calibrated = await sensor.calibrate(offset);

  // Second sensor to verify different instances work
  const sensor2 = new Sensor(100, 2);
  const reading2 = await sensor2.reading;

  return {
    reading, // base * multiplier
    calibrated, // base * multiplier + offset
    reading2, // 100 * 2 = 200
  };
}

//////////////////////////////////////////////////////////
// start() inside workflow functions
//////////////////////////////////////////////////////////

/**
 * Child workflow used by startFromWorkflow.
 * Receives a hook token from its parent, processes a value,
 * and signals the parent via resumeHook before completing.
 */
export async function childWorkflowWithHookSignal(
  hookToken: string,
  value: number
) {
  'use workflow';
  const result = await processAndSignalParent(hookToken, value);
  return result;
}

async function processAndSignalParent(hookToken: string, value: number) {
  'use step';
  const processed = value * 3;
  await resumeHook(hookToken, { processed });
  return { processed };
}

/**
 * Parent workflow that calls start() directly to spawn a child workflow,
 * then waits for a hook signal from the child.
 */
export async function startFromWorkflow(inputValue: number) {
  'use workflow';
  const hook = createHook<{ processed: number }>();
  const childRun = await start(childWorkflowWithHookSignal, [
    hook.token,
    inputValue,
  ]);
  const signal = await hook;
  return {
    parentInput: inputValue,
    childRunId: childRun.runId,
    signalFromChild: signal,
  };
}

/**
 * Recursive Fibonacci workflow. start() is called directly to spawn
 * child workflows for fib(n-1) and fib(n-2).
 *
 * WORKER POOL CAVEAT: each `runA.returnValue` / `runB.returnValue` await
 * resolves by polling the child run's status inside a step that holds a
 * worker slot until the child completes. In worker-based worlds (notably
 * `world-postgres`), the peak number of these in-flight polls must fit
 * within `queueConcurrency`, or the workflow will deadlock — all slots
 * end up held by parents waiting for children that can't get a slot to
 * start. For `fib(n)`, the recursion tree produces roughly `2·(T(n)−leaves)`
 * concurrent polls at peak; fib(6) needs ~24 slots, fib(10) needs
 * hundreds. If you raise `n`, raise `queueConcurrency` accordingly.
 */
export async function fibonacciWorkflow(n: number): Promise<number> {
  'use workflow';
  if (!Number.isFinite(n)) {
    throw new FatalError(`fibonacciWorkflow requires a finite number for n`);
  }
  if (n <= 1) return n;

  const [runA, runB] = await Promise.all([
    start(fibonacciWorkflow, [n - 1]),
    start(fibonacciWorkflow, [n - 2]),
  ]);

  const [a, b] = await Promise.all([runA.returnValue, runB.returnValue]);
  return a + b;
}

//////////////////////////////////////////////////////////
// Distributed Abort Controller
//////////////////////////////////////////////////////////

// Message type written to the stream when abort fires
export type AbortMessage = {
  type: 'abort';
  reason?: string;
  expired: boolean;
};

// Helper to derive abort hook token from user-provided ID
function getAbortToken(id: string): string {
  return `distributed-abort:${id}`;
}

// Step function that writes the abort message to the stream
async function writeAbortSignal(reason?: string, expired = false) {
  'use step';
  const writable = getWritable<AbortMessage>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: 'abort', reason, expired });
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

/**
 * Workflow that backs the DistributedAbortController.
 * Waits for either:
 * 1. Manual abort via hook trigger
 * 2. TTL expiration
 *
 * After abort, sleeps until TTL + grace period to keep hook alive
 * for late subscribers.
 */
export async function distributedAbortControllerWorkflow(
  id: string,
  ttlMs: number,
  graceMs: number
) {
  'use workflow';

  const startTime = Date.now();
  const hook = createHook<{ reason?: string }>({ token: getAbortToken(id) });

  // Race: manual abort OR TTL expiration
  const result = await Promise.race([
    hook.then((payload) => ({
      reason: payload.reason,
      expired: false,
    })),
    sleep(ttlMs).then(() => ({
      reason: 'Controller expired',
      expired: true,
    })),
  ]);

  // Write the abort signal to the stream
  await writeAbortSignal(result.reason, result.expired);

  // Only sleep through grace period on TTL expiration (keeps hook alive for late subscribers).
  // Manual aborts complete immediately.
  if (result.expired) {
    const elapsed = Date.now() - startTime;
    const remainingTime = graceMs - (elapsed - ttlMs);
    if (remainingTime > 0) {
      await sleep(remainingTime);
    }
  }

  return { aborted: true, reason: result.reason, expired: result.expired };
}

/**
 * DistributedAbortController - a cross-process abort controller backed by a durable workflow.
 *
 * Usage:
 *   const controller = await DistributedAbortController.create('my-task-123');
 *   // In any process:
 *   controller.abort('User cancelled');
 *   // In any other process:
 *   const signal = await controller.signal;
 *   signal.addEventListener('abort', () => console.log('Aborted!'));
 */
export class DistributedAbortController {
  private constructor(
    public readonly id: string,
    public readonly runId: string
  ) {}

  /**
   * Creates or reconnects to a distributed abort controller.
   * If a controller with this ID already exists, reconnects to it.
   * Otherwise, starts a new workflow.
   */
  static async create(
    id: string,
    options: { ttlMs?: number; graceMs?: number } = {}
  ): Promise<DistributedAbortController> {
    const { ttlMs = 24 * 60 * 60 * 1000, graceMs = 60 * 60 * 1000 } = options;
    const token = getAbortToken(id);

    // Try to find an existing run with this hook token
    const existingHook = await getHookByToken(token).catch(() => null);

    if (existingHook) {
      // Reconnect to existing controller
      return new DistributedAbortController(id, existingHook.runId);
    }

    // Create a new workflow
    const run = await start(distributedAbortControllerWorkflow, [
      id,
      ttlMs,
      graceMs,
    ]);
    return new DistributedAbortController(id, run.runId);
  }

  /**
   * Triggers the abort signal across all processes.
   */
  async abort(reason?: string): Promise<void> {
    const token = getAbortToken(this.id);
    await resumeHook(token, { reason });
  }

  /**
   * Returns an AbortSignal that fires when the controller is aborted.
   * Listens to the workflow's output stream.
   */
  get signal(): Promise<AbortSignal> {
    return (async () => {
      const controller = new AbortController();
      const run = getRun<AbortMessage>(this.runId);
      const readable = await run.getReadable();
      const reader = readable.getReader();

      // Read from stream in background
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.type === 'abort') {
              controller.abort(value.reason);
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      })();

      return controller.signal;
    })();
  }
}

//////////////////////////////////////////////////////////
// WritableStream passed as argument to start()
//
// A parent workflow gets a WritableStream from getWritable() (its own
// output stream), and passes it through `start()` to a child
// workflow. The child workflow receives the WritableStream as a
// workflow argument and forwards it into a step, which writes raw
// Uint8Array bytes to it.
//
// The external reader on `parentRun.getReadable()` should observe the
// exact bytes the child step wrote.

async function writeBytesToWritable(
  writable: WritableStream<Uint8Array>,
  payload: string
) {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  writer.releaseLock();
}

export async function writableForwardedChildWorkflow(
  parentWritable: WritableStream<Uint8Array>,
  payload: string
) {
  'use workflow';
  await writeBytesToWritable(parentWritable, payload);
  return 'child-done';
}

// Variant 1: the parent calls `getWritable()` in the workflow body
// (workflow-context handle), passes the resulting fake handle through
// `start()`. The intermediary step that calls `start()` only exists
// because `start()` cannot be invoked from workflow code directly.
async function startChildWithWorkflowWritable(
  parentWritable: WritableStream<Uint8Array>,
  payload: string
) {
  'use step';
  const childRun = await start(writableForwardedChildWorkflow, [
    parentWritable,
    payload,
  ]);
  // Wait for the child to finish writing before letting the parent
  // close its own writable.
  await childRun.returnValue;
  return childRun.runId;
}

export async function writableForwardedFromWorkflowWorkflow(payload: string) {
  'use workflow';
  const writable = getWritable<Uint8Array>();
  const childRunId = await startChildWithWorkflowWritable(writable, payload);
  await stepCloseOutputStream(writable);
  return { childRunId };
}

// Variant 2: the parent's `getWritable()` is called inside the step
// that also calls `start()`, so the writable handed to the child is
// the real step-context `serialize.writable` (not a workflow-context
// fake handle that's later revived by a step). This exercises the
// step-side `getWritable()` tagging path directly.
async function startChildWithStepWritable(payload: string) {
  'use step';
  const writable = getWritable<Uint8Array>();
  const childRun = await start(writableForwardedChildWorkflow, [
    writable,
    payload,
  ]);
  await childRun.returnValue;
  await writable.close();
  return childRun.runId;
}

export async function writableForwardedFromStepWorkflow(payload: string) {
  'use workflow';
  const childRunId = await startChildWithStepWritable(payload);
  return { childRunId };
}

//////////////////////////////////////////////////////////
// Workflow Attributes MVP — workflow and step API.

/**
 * Calls `experimental_setAttributes` directly from the workflow body.
 * The call is dispatched through the `__builtin_set_attributes` step
 * bridge, so the mutation gets a `step_created`/`step_completed` event
 * pair. The third call sets a key to `undefined` and the test verifies
 * the key is absent from the final attribute map.
 */
export async function experimentalSetAttributesWorkflow(input: number) {
  'use workflow';
  await experimental_setAttributes({ phase: 'init', source: 'workflow-body' });
  const tripled = input * 3;
  await experimental_setAttributes({ phase: 'done' });
  await experimental_setAttributes({ source: undefined });
  return tripled;
}

async function setAttributesFromStep(input: number) {
  'use step';
  await experimental_setAttributes({
    phase: 'step-started',
    source: 'step-body',
    input: String(input),
  });
  await experimental_setAttributes({ phase: 'step-done' });
  return input * 4;
}

/**
 * Calls `experimental_setAttributes` from inside a normal user step. Step
 * bodies already run in host context, so the helper posts directly to the
 * world instead of creating a nested `__builtin_set_attributes` step.
 */
export async function experimentalSetAttributesInsideStepWorkflow(
  input: number
) {
  'use workflow';
  return setAttributesFromStep(input);
}

/**
 * Fire-and-forget pattern: `void experimental_setAttributes(...)` lets
 * the workflow body proceed without blocking on the attribute write.
 * Each `void` call queues a step on the workflow's next suspension —
 * any later `await` on a runtime primitive (a step, a sleep, a hook).
 * This is the canonical pattern for observability / tracking metadata
 * where the workflow doesn't depend on the write.
 *
 * Note: a `void` call placed *immediately before* `return` (with no
 * later `await`) is currently unreliable — the step is committed but
 * the queue worker skips it once `run_completed` lands. See the
 * `test.todo(...)` for `fire-and-forget` in `packages/core/e2e/e2e.test.ts`.
 */
export async function experimentalSetAttributesFireAndForgetWorkflow() {
  'use workflow';
  void experimental_setAttributes({ phase: 'init', mode: 'fire-and-forget' });
  await sleep('100ms');
  void experimental_setAttributes({ phase: 'mid' });
  await sleep('100ms');
  void experimental_setAttributes({ phase: 'done' });
  return 'completed';
}

/**
 * `Promise.all` of multiple `experimental_setAttributes` calls writing
 * disjoint keys: every key must land. The world-side per-run mutex (or
 * per-row atomic SQL update) serializes the writes; LWW-by-arrival only
 * matters when two calls touch the same key.
 */
export async function experimentalSetAttributesParallelWorkflow() {
  'use workflow';
  await Promise.all([
    experimental_setAttributes({ a: '1' }),
    experimental_setAttributes({ b: '2' }),
    experimental_setAttributes({ c: '3' }),
  ]);
  return 'done';
}

/**
 * Workflow throws after awaiting `experimental_setAttributes`. The
 * attribute write completes before the throw, so the persisted run row
 * should carry the attribute even though the run ends up `failed`.
 */
export async function experimentalSetAttributesThrowsAfterWorkflow() {
  'use workflow';
  await experimental_setAttributes({
    phase: 'about-to-fail',
    reason: 'intentional',
  });
  throw new FatalError('intentional failure to test attribute persistence');
}
