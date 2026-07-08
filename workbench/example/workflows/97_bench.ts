// Benchmark workflows for performance measurement.
//
// The benchmark runner (packages/core/e2e/benchmark.test.ts) derives all
// metrics from wall-clock timestamps recorded here:
//
// - Every step records `start`/`end` (`Date.now()` at body entry/exit) and the
//   workflow returns the collected timings. The runner combines them with its
//   own client-side timestamp taken when `start()` is called to compute
//   time-to-first-step (TTFS), step-to-step overhead (STSO), and workflow
//   overhead (WO).
// - Streaming steps embed `writtenAt` into every chunk written to the default
//   output stream so a reader can compute stream latency (SL) as
//   `readTime - writtenAt` without needing a shared clock with the runner
//   process beyond NTP.

import { createHook, getWritable } from 'workflow';

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
 * Scenario 1: one step that streams data back to a reader.
 *
 * No hooks are created, so the first invocation runs in turbo mode. Used to
 * measure TTFS (turbo) and SL (turbo).
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
 * Scenario 3: registers a hook, then runs one step that streams data back.
 *
 * The fire-and-forget hook is never awaited — its `hook_created` event at the
 * first suspension makes the runtime exit turbo mode, so this scenario
 * measures the non-turbo TTFS and SL paths (contrast with
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
