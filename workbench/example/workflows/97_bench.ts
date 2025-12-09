// Benchmark workflows for performance testing

async function doWork() {
  'use step';
  // Simulate real work with a 1 second delay
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return 42;
}

// Workflow with no steps - pure orchestration
export async function noStepsWorkflow(input: number) {
  'use workflow';
  return input * 2;
}

// Workflow with 1 step
export async function oneStepWorkflow(input: number) {
  'use workflow';
  const result = await doWork();
  return result + input;
}

// Workflow with 10 sequential steps
export async function tenSequentialStepsWorkflow() {
  'use workflow';
  let result = 0;
  for (let i = 0; i < 10; i++) {
    result = await doWork();
  }
  return result;
}

// Workflow with 10 parallel steps
export async function tenParallelStepsWorkflow() {
  'use workflow';
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(doWork());
  }
  const results = await Promise.all(promises);
  return results.reduce((sum, val) => sum + val, 0);
}

// Step that generates a stream with ~5KB of data to simulate real work
async function genBenchStream(): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const encoder = new TextEncoder();
  // Generate 5KB of data in 50 chunks of ~100 bytes each
  const chunkSize = 100;
  const numChunks = 50;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < numChunks; i++) {
        // Generate a chunk with padding to reach ~100 bytes
        const content = `chunk-${i.toString().padStart(3, '0')}-${'x'.repeat(chunkSize - 11)}\n`;
        controller.enqueue(encoder.encode(content));
        // Small delay to avoid synchronous close issues on local world
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  });
}

// Step that transforms a stream by uppercasing the content
async function transformStream(
  stream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      controller.enqueue(encoder.encode(text.toUpperCase()));
    },
  });

  return stream.pipeThrough(transform);
}

// Workflow that generates and transforms a stream
export async function streamWorkflow() {
  'use workflow';
  const stream = await genBenchStream();
  const transformed = await transformStream(stream);
  return transformed;
}

//////////////////////////////////////////////////////////
// Stress test workflows for large concurrent step counts
//////////////////////////////////////////////////////////

async function stressTestStep(i: number) {
  'use step';
  // Simulate real work with a 1 second delay
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return i;
}

// Stress test: Promise.all with many concurrent steps
export async function promiseAllStressTestWorkflow(count: number) {
  'use workflow';
  const promises: Promise<number>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(stressTestStep(i));
  }
  const results = await Promise.all(promises);
  return results.length;
}

// Stress test: Promise.race with many concurrent steps (uses Map pattern from report)
export async function promiseRaceStressTestLargeWorkflow(count: number) {
  'use workflow';
  const runningTasks = new Map<number, Promise<number>>();
  for (let i = 0; i < count; i++) {
    runningTasks.set(i, stressTestStep(i));
  }

  const done: number[] = [];
  while (runningTasks.size > 0) {
    const result = await Promise.race(runningTasks.values());
    done.push(result);
    runningTasks.delete(result);
  }

  return done.length;
}
