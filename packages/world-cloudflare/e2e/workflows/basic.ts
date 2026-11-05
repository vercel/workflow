import { createHook, getStepMetadata, getWritable, sleep } from 'workflow';

async function add(a: number, b: number): Promise<number> {
  'use step';
  return a + b;
}

async function slow(ms: number, label: string): Promise<string> {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, ms));
  return label;
}

async function flaky(failures: number): Promise<string> {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt <= failures) {
    throw new Error(`flaky failure on attempt ${attempt}`);
  }
  return `ok on attempt ${attempt}`;
}

async function emit(writable: WritableStream<Uint8Array>, line: string) {
  'use step';
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(`${line}\n`));
  writer.releaseLock();
}

/** Sequential steps. */
export async function addition(a: number, b: number): Promise<number> {
  'use workflow';
  const x = await add(a, b);
  const y = await add(x, 10);
  return y;
}

/** Parallel fan-out of steps. */
export async function fanOut(n: number): Promise<number> {
  'use workflow';
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => add(i, 1))
  );
  return results.reduce((sum, v) => sum + v, 0);
}

/** A durable timer between two steps. */
export async function sleeper(seconds: number): Promise<number> {
  'use workflow';
  const start = await add(0, 1);
  await sleep(`${seconds}s`);
  return add(start, 1);
}

/** sleep() wins a race against a slow step. */
export async function race(stepMs: number, sleepSeconds: number) {
  'use workflow';
  const winner = await Promise.race([
    slow(stepMs, 'step'),
    sleep(`${sleepSeconds}s`).then(() => 'sleep'),
  ]);
  return winner;
}

/** A hook resumed from outside. */
export async function waitForHook(token: string) {
  'use workflow';
  const hook = createHook<{ value: number }>({ token });
  const first = await hook;
  const sum = await add(first.value, 1);
  return sum;
}

/** Step retries. */
export async function retrying(failures: number) {
  'use workflow';
  return flaky(failures);
}

/** Streams written from a step. */
export async function streaming(count: number) {
  'use workflow';
  const writable = getWritable<Uint8Array>();
  for (let i = 0; i < count; i++) {
    await emit(writable, `line ${i}`);
  }
  return count;
}

/** A hook resumed while a step body is running inline in the run object. */
export async function hookDuringStep(token: string) {
  'use workflow';
  const hook = createHook<{ value: number }>({ token });
  const [payload, label] = await Promise.all([hook, slow(3000, 'step')]);
  return `${label}:${payload.value}`;
}

/** Enough events before a sleep for the VM to be snapshotted while it waits. */
export async function snapshotted(steps: number, seconds: number) {
  'use workflow';
  let total = 0;
  for (let i = 0; i < steps; i++) {
    total = await add(total, i);
  }
  await sleep(`${seconds}s`);
  return add(total, 1000);
}
