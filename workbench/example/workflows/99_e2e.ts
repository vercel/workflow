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
import { getRun, start } from 'workflow/api';
import { callThrower } from './helpers.js';

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

// Helper functions to test nested stack traces
function deepFunction() {
  throw new Error('Error from deeply nested function');
}

function middleFunction() {
  deepFunction();
}

function topLevelHelper() {
  middleFunction();
}

export async function nestedErrorWorkflow() {
  'use workflow';
  topLevelHelper();
  return 'never reached';
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
