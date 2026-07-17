// Benchmark workflows for performance measurement.
//
// The benchmark runner (packages/core/e2e/benchmark.test.ts) triggers these
// workflows through an in-deployment route (workbench app `/api/bench`) that
// stamps `clientStart` with the deployment's own clock right before calling
// `start()`. Every metric is then derived from timestamps recorded on the
// deployment — never from the CI runner's clock or its path to
// api.vercel.com:
//
// - Every step records `start`/`end` (`Date.now()` at body entry/exit) and the
//   workflow returns the collected timings. The runner combines them with the
//   in-deployment `clientStart` to compute time-to-first-step (TTFS),
//   step-to-step overhead (STSO), and workflow overhead (WO).
// - `benchSlWorkflow` measures stream latency (SL) entirely on the deployment:
//   a reader step and a writer step run in parallel on a dedicated namespaced
//   stream, and the workflow returns both the writer's `writtenAt` and the
//   reader's `readAt` so SL (`readAt - writtenAt`) excludes the client read
//   path.

import { createHook, getWorkflowMetadata, getWritable } from 'workflow';
import { getRun } from 'workflow/api';

export interface BenchStepTiming {
  /** Date.now() at step body entry */
  start: number;
  /** Date.now() at step body exit (just before step_completed is sent) */
  end: number;
}

export interface BenchStreamChunk {
  seq: number;
  /** Date.now() in the step when this chunk was written */
  writtenAt: number;
}

export interface BenchStreamLatency {
  /** Date.now() in the writer step when the first chunk was written */
  writtenAt: number;
  /** Date.now() in the reader step when the first chunk was received */
  readAt: number;
}

// Dedicated stream for the SL scenario, kept off the default output stream so
// it never interacts with the default-stream lifecycle.
const SL_STREAM_NAMESPACE = 'bench-sl';
// The writer waits this long before writing its first chunk so the parallel
// reader step is guaranteed to be attached and blocked on the stream first.
// SL then reflects live write->read propagation (pub/sub wake + delivery),
// not a warm read of an already-written chunk. The wait happens before
// `writtenAt` is stamped, so it never enters the SL measurement.
const SL_WRITE_DELAY_MS = 750;

async function timedNoopStep(index: number): Promise<BenchStepTiming> {
  'use step';
  const start = Date.now();
  // No body work: `end - start` is ~0, so the gap between consecutive step
  // timings is pure framework overhead.
  void index;
  return { start, end: Date.now() };
}

async function timedStreamingStep(chunks: number): Promise<BenchStepTiming> {
  'use step';
  const start = Date.now();
  const writable = getWritable<BenchStreamChunk>();
  const writer = writable.getWriter();
  for (let i = 0; i < chunks; i++) {
    await writer.write({ seq: i, writtenAt: Date.now() });
  }
  writer.releaseLock();
  // Close so the benchmark reader's read loop terminates.
  await writable.close();
  return { start, end: Date.now() };
}

/**
 * Scenario 1a: one trivial no-op step — no stream, no hooks (turbo mode). The
 * cleanest TTFS measurement, with no stream machinery in the step body.
 */
export async function benchStepWorkflow(): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const step = await timedNoopStep(0);
  return { steps: [step] };
}

/**
 * Scenario 1b: one step that streams data back. No hooks, so the first
 * invocation runs in turbo mode. Used to measure TTFS (turbo) with a streaming
 * step body (contrast with {@link benchStepWorkflow}).
 */
export async function benchStreamWorkflow(): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const step = await timedStreamingStep(3);
  return { steps: [step] };
}

/**
 * Scenario 2: N trivial sequential steps. Used to measure STSO (the gap
 * between consecutive step body executions), reported per step-index range.
 */
export async function benchSequentialStepsWorkflow(count: number): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const steps: BenchStepTiming[] = [];
  for (let i = 0; i < count; i++) {
    steps.push(await timedNoopStep(i));
  }
  return { steps };
}

/**
 * Scenario 3: registers a hook, then runs one step.
 *
 * The fire-and-forget hook is never awaited — its `hook_created` event at the
 * first suspension makes the runtime exit turbo mode, so this scenario
 * measures the non-turbo TTFS path (contrast with
 * {@link benchStreamWorkflow}).
 */
export async function benchHookStreamWorkflow(): Promise<{
  steps: BenchStepTiming[];
  hookToken: string;
}> {
  'use workflow';
  const hook = createHook<never>();
  const step = await timedStreamingStep(3);
  return { steps: [step], hookToken: hook.token };
}

/** Reader half of the SL scenario: attaches to the dedicated stream and blocks
 * on the first chunk, stamping `readAt` the instant it arrives. Reads via
 * `getRun(runId).getReadable()` — the same in-deployment path a co-located
 * consumer uses, so the api.vercel.com read path is never involved. */
async function slReaderStep(): Promise<BenchStreamLatency> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const run = getRun<BenchStreamChunk>(workflowRunId);
  const reader = run
    .getReadable<BenchStreamChunk>({ namespace: SL_STREAM_NAMESPACE })
    .getReader();
  try {
    const { value } = await reader.read();
    const readAt = Date.now();
    if (!value || typeof value.writtenAt !== 'number') {
      throw new Error(
        `bench SL reader: malformed first chunk ${JSON.stringify(value)?.slice(0, 120)}`
      );
    }
    return { writtenAt: value.writtenAt, readAt };
  } finally {
    // Best-effort: don't let a hanging cancel fail the run.
    reader.cancel().catch(() => {});
  }
}

/** Writer half of the SL scenario: waits so the reader is attached first, then
 * writes a single chunk stamped with `writtenAt` and closes the stream. */
async function slWriterStep(): Promise<void> {
  'use step';
  const writable = getWritable<BenchStreamChunk>({
    namespace: SL_STREAM_NAMESPACE,
  });
  const writer = writable.getWriter();
  await new Promise((resolve) => setTimeout(resolve, SL_WRITE_DELAY_MS));
  await writer.write({ seq: 0, writtenAt: Date.now() });
  writer.releaseLock();
  await writable.close();
}

/**
 * Scenario 4: stream latency (SL), measured entirely on the deployment.
 *
 * The reader and writer steps run in parallel on a dedicated namespaced
 * stream. The reader attaches and blocks; the writer waits {@link
 * SL_WRITE_DELAY_MS} (guaranteeing the reader is blocked first) and then
 * writes. Both `writtenAt` and `readAt` are step-body `Date.now()` values on
 * the deployment, so the returned SL is independent of the CI client and the
 * api.vercel.com read path.
 */
export async function benchSlWorkflow(): Promise<{ sl: BenchStreamLatency }> {
  'use workflow';
  const [sl] = await Promise.all([slReaderStep(), slWriterStep()]);
  return { sl };
}
