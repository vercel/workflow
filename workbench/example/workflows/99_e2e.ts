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

// Use Symbol.for() directly instead of importing from 'workflow' to avoid
// pulling in server-side dependencies when this file is bundled for the client.
// The SWC plugin recognizes these symbols by their string keys.
const WORKFLOW_SERIALIZE = Symbol.for('workflow-serialize');
const WORKFLOW_DESERIALIZE = Symbol.for('workflow-deserialize');
import { getRun, start } from 'workflow/api';
import { callThrower, stepThatThrowsFromHelper } from './helpers.js';

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
    specificDelay(1000, 'b'), // "b" should always win
    specificDelay(3000, 'c'),
  ]);
  return winner;
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

  const hook = createHook<Payload>({
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

export async function webhookWorkflow(
  token: string,
  token2: string,
  token3: string
) {
  'use workflow';

  type Payload = { url: string; method: string; body: string };
  const payloads: Payload[] = [];

  const webhookWithDefaultResponse = createWebhook({ token });

  const res = new Response('Hello from static response!', { status: 402 });
  console.log('res', res);
  const webhookWithStaticResponse = createWebhook({
    token: token2,
    respondWith: res,
  });
  const webhookWithManualResponse = createWebhook({
    token: token3,
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

export async function sleepingWorkflow() {
  'use workflow';
  const startTime = Date.now();
  await sleep('10s');
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
      workflowRunId: workflowMetadata.workflowRunId,
      workflowStartedAt: workflowMetadata.workflowStartedAt,
      url: workflowMetadata.url,
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

export async function hookCleanupTestWorkflow(
  token: string,
  customData: string
) {
  'use workflow';

  type Payload = { message: string; customData: string };

  const hook = createHook<Payload>({
    token,
    metadata: { customData },
  });

  // Wait for exactly one payload
  const payload = await hook;

  return {
    message: payload.message,
    customData: payload.customData,
    hookCleanupTestData: 'workflow_completed',
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

// NOTE: Tests for `this` serialization in step functions (ChainableService and
// thisSerializationWorkflow) are disabled because the SWC plugin currently forbids
// `this` usage in step functions. This restriction could be lifted in the future.

//////////////////////////////////////////////////////////
// Custom Serialization E2E Test
//////////////////////////////////////////////////////////

/**
 * A custom class with user-defined serialization using WORKFLOW_SERIALIZE/WORKFLOW_DESERIALIZE symbols.
 * The SWC plugin detects these symbols and generates the classId and registration automatically.
 */
export class Point {
  constructor(
    public x: number,
    public y: number
  ) {}

  /** Custom serialization - converts instance to plain object */
  static [WORKFLOW_SERIALIZE](instance: Point) {
    return { x: instance.x, y: instance.y };
  }

  /** Custom deserialization - reconstructs instance from plain object */
  static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
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
