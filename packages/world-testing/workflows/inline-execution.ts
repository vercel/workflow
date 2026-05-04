import { sleep, getWritable } from 'workflow';
import { defineHook } from 'workflow';

// --- Simple step ---

async function add(a: number, b: number): Promise<number> {
  'use step';
  return a + b;
}

// --- Stream step ---

async function writeToStream(
  writable: WritableStream,
  text: string
): Promise<string> {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
  return text;
}

async function closeOutputStream(writable: WritableStream): Promise<void> {
  'use step';
  const writer = writable.getWriter();
  await writer.close();
}

// --- Workflows ---

/**
 * 3 sequential add steps. No streams, no hooks, no sleeps.
 * Expected: 1 flow invocation (all steps inline).
 */
export async function sequentialStepsWorkflow(input: number): Promise<number> {
  'use workflow';
  const a = await add(input, 2);
  const b = await add(a, 3);
  const c = await add(b, 5);
  return c;
}

/**
 * 2 sequential steps that write to a stream, then close it.
 * Expected: 1 flow invocation (ops settle via synchronous flush).
 */
export async function sequentialStepsWithStreamWorkflow(): Promise<string> {
  'use workflow';
  const writable = getWritable();
  const a = await writeToStream(writable, 'hello');
  const b = await writeToStream(writable, ' world');
  await closeOutputStream(writable);
  return a + b;
}

/**
 * A single sleep(1s) followed by a step.
 * Expected: 2 flow invocations (1 to create the wait, 1 after it resumes).
 */
export async function sleepWorkflow(): Promise<number> {
  'use workflow';
  await sleep('1s');
  const result = await add(1, 2);
  return result;
}

/**
 * Promise.all with 2 add steps.
 * Expected: 2 flow invocations (1 inline + 1 background step continuation).
 */
export async function parallelStepsWorkflow(): Promise<number> {
  'use workflow';
  const [a, b] = await Promise.all([add(10, 1), add(20, 2)]);
  return a + b;
}

/**
 * Three sequential batches of Promise.all with 5 add steps each (15 total).
 * Used to study V2 handler behavior under parallel+sequential load:
 *   - event load frequency (full vs incremental)
 *   - redundant step executions from inline+background races
 *   - concurrent "all steps done" replay races
 *   - unconsumed-event skips from out-of-order replay visibility
 */
export async function threeBatchesOfFiveWorkflow(): Promise<number[]> {
  'use workflow';
  const batch1 = await Promise.all([
    add(1, 10),
    add(1, 20),
    add(1, 30),
    add(1, 40),
    add(1, 50),
  ]);
  const batch2 = await Promise.all([
    add(2, 10),
    add(2, 20),
    add(2, 30),
    add(2, 40),
    add(2, 50),
  ]);
  const batch3 = await Promise.all([
    add(3, 10),
    add(3, 20),
    add(3, 30),
    add(3, 40),
    add(3, 50),
  ]);
  return [...batch1, ...batch2, ...batch3];
}

// --- Hook ---

export const TestHook = defineHook<{ data: string; done?: boolean }>({});

/**
 * Creates a hook, waits for one resume, returns the payload.
 * Expected: 2 flow invocations (1 to create the hook, 1 after resume).
 */
export async function hookWorkflow(token: string): Promise<{ data: string }> {
  'use workflow';
  const hook = TestHook.create({ token });
  const event = await hook.next();
  return { data: event.data };
}
