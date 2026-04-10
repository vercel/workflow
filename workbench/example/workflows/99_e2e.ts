// Test path alias resolution - imports a helper from outside the workbench directory
/** biome-ignore-all lint/complexity/noStaticOnlyClass: <explanation> */
import { pathsAliasHelper } from '@repo/lib/steps/paths-alias-test';
import {
  createHook,
  createWebhook,
  FatalError,
  fetch,
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
  type RequestWithResponse,
  RetryableError,
  sleep,
} from 'workflow';
import { getRun, Run, resumeHook, start } from 'workflow/api';
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
// Instance Method Step Tests
//////////////////////////////////////////////////////////

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

  return {
    initialValue,
    added, // initialValue + 10
    multiplied, // initialValue * 3
    description, // { label: 'test counter', value: initialValue }
    added2, // 100 + 50 = 150
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
 */
export async function fibonacciWorkflow(n: number): Promise<number> {
  'use workflow';
  if (n <= 1) return n;

  const [runA, runB] = await Promise.all([
    start(fibonacciWorkflow, [n - 1]),
    start(fibonacciWorkflow, [n - 2]),
  ]);

  const [a, b] = await Promise.all([runA.returnValue, runB.returnValue]);
  return a + b;
}
