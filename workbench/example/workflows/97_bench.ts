// Benchmark workflows for performance testing

async function doWork() {
  'use step';
  // Simulate real work with a 1 second delay
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return 42;
}

async function doWorkWithDelay(sleepMs: number) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
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

// Workflow with N sequential steps (parameterized)
export async function sequentialStepsWorkflow(
  count: number,
  sleepMs: number = 1000
) {
  'use workflow';
  let result = 0;
  for (let i = 0; i < count; i++) {
    result = await doWorkWithDelay(sleepMs);
  }
  return result;
}

// Workflow with 10 parallel steps
export async function tenParallelStepsWorkflow() {
  'use workflow';
  const promises: Promise<number>[] = [];
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

//////////////////////////////////////////////////////////
// Data payload workflows
//////////////////////////////////////////////////////////

async function processDataPayload(data: string) {
  'use step';
  const len = data.length;
  const checksum = data.charCodeAt(0) + data.charCodeAt(len - 1);
  return { data, len, checksum };
}

export async function sequentialDataPayloadWorkflow(
  count: number,
  payloadSize: number
) {
  'use workflow';
  const payload = 'x'.repeat(payloadSize);
  let lastLen = 0;
  for (let i = 0; i < count; i++) {
    const result = await processDataPayload(payload);
    lastLen = result.len;
  }
  return lastLen;
}

export async function concurrentDataPayloadWorkflow(
  count: number,
  payloadSize: number
) {
  'use workflow';
  const payload = 'x'.repeat(payloadSize);
  const promises: Promise<{ data: string; len: number; checksum: number }>[] =
    [];
  for (let i = 0; i < count; i++) {
    promises.push(processDataPayload(payload));
  }
  const results = await Promise.all(promises);
  return results.length;
}

//////////////////////////////////////////////////////////
// Stream stress test workflows
//////////////////////////////////////////////////////////

// Step: generate a large byte stream with known pattern for verification
// Each byte = (globalByteOffset) % 256, providing a unique pattern across the entire stream
async function genLargeStream(
  totalBytes: number
): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const chunkSize = 64 * 1024; // 64KB chunks
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let remaining = totalBytes;
      let totalBytesProcessed = 0;
      while (remaining > 0) {
        const size = Math.min(chunkSize, remaining);
        const chunk = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          chunk[i] = (totalBytesProcessed + i) % 256;
        }
        controller.enqueue(chunk);
        remaining -= size;
        totalBytesProcessed += size;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
}

// Step: transform stream by XOR-ing each byte (proves data is in memory, preserves size)
async function transformStreamXor(
  stream: ReadableStream<Uint8Array>,
  xorByte: number
): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const out = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        out[i] = chunk[i] ^ xorByte;
      }
      controller.enqueue(out);
    },
  });
  return stream.pipeThrough(transform);
}

// Step: consume multiple streams in parallel, verify total bytes, return as summary stream
async function consumeAndVerifyStreams(
  expectedBytesPerStream: number,
  ...streams: ReadableStream<Uint8Array>[]
): Promise<ReadableStream<Uint8Array>> {
  'use step';
  const streamByteCounts: number[] = [];

  await Promise.all(
    streams.map(async (s, idx) => {
      const reader = s.getReader();
      let streamBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBytes += value.length;
      }
      streamByteCounts[idx] = streamBytes;
    })
  );

  const totalBytes = streamByteCounts.reduce((sum, count) => sum + count, 0);

  // Verify each stream had the expected number of bytes
  for (let i = 0; i < streamByteCounts.length; i++) {
    if (streamByteCounts[i] !== expectedBytesPerStream) {
      throw new Error(
        `Stream ${i} correctness failure: expected ${expectedBytesPerStream} bytes, got ${streamByteCounts[i]}`
      );
    }
  }

  // Return a summary stream so the bench harness can measure TTFB/slurp
  const encoder = new TextEncoder();
  const summary = JSON.stringify({ totalBytes, streamCount: streams.length });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(summary));
      controller.close();
    },
  });
}

// Workflow 1: Pipeline — generate 1 stream, pipe through N XOR transform steps
// Returns the final transformed stream (same size as input)
export async function streamPipelineWorkflow(
  steps: number,
  totalBytes: number
) {
  'use workflow';
  let stream = await genLargeStream(totalBytes);
  for (let i = 0; i < steps; i++) {
    stream = await transformStreamXor(stream, (i + 1) % 256);
  }
  return stream;
}

// Workflow 2: N steps generate streams in parallel, one step consumes + verifies all
export async function parallelStreamsWorkflow(
  count: number,
  bytesPerStream: number
) {
  'use workflow';
  const promises: Promise<ReadableStream<Uint8Array>>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(genLargeStream(bytesPerStream));
  }
  const streams = await Promise.all(promises);
  return await consumeAndVerifyStreams(bytesPerStream, ...streams);
}

// Workflow 3: Fan-out fan-in — generate N streams, transform each, consume + verify all
export async function fanOutFanInStreamWorkflow(
  count: number,
  bytesPerStream: number
) {
  'use workflow';
  const genPromises: Promise<ReadableStream<Uint8Array>>[] = [];
  for (let i = 0; i < count; i++) {
    genPromises.push(genLargeStream(bytesPerStream));
  }
  const rawStreams = await Promise.all(genPromises);

  const transformPromises: Promise<ReadableStream<Uint8Array>>[] = [];
  for (let i = 0; i < rawStreams.length; i++) {
    transformPromises.push(transformStreamXor(rawStreams[i], (i + 1) % 256));
  }
  const transformedStreams = await Promise.all(transformPromises);

  return await consumeAndVerifyStreams(bytesPerStream, ...transformedStreams);
}
