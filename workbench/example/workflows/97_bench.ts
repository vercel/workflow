// Benchmark workflows for performance testing

async function doWork() {
  'use step';
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

// Step that generates a stream with 10 chunks
async function genBenchStream(): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(encoder.encode(`${i}\n`));
        // Small delay to avoid synchronous close issues on local world
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.close();
    },
  });
}

// Step that transforms a stream by doubling each number
async function doubleNumbers(
  stream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const num = parseInt(line, 10);
          controller.enqueue(encoder.encode(`${num * 2}\n`));
        }
      }
    },
  });

  return stream.pipeThrough(transformStream);
}

// Workflow that generates and transforms a stream
export async function streamWorkflow() {
  'use workflow';
  const stream = await genBenchStream();
  const doubled = await doubleNumbers(stream);
  return doubled;
}

//////////////////////////////////////////////////////////
// Stress test workflows for large concurrent step counts
//////////////////////////////////////////////////////////

async function stressTestStep(i: number) {
  'use step';
  // Minimal work to isolate the overhead of concurrent step tracking
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
