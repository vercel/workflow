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
//   step-to-step overhead (STSO), workflow overhead (WO), and — on the fan-out
//   scenario — the first/last step completion of a `Promise.all` (Fan-out
//   TTFS/TTLS).
//
// Streaming delivery performance is measured in durabench. The streaming
// steps here exercise the runtime's TTFS paths, not write-to-read latency.

import { createHook, getWritable } from 'workflow';

export interface BenchStepTiming {
  /** Date.now() at step body entry */
  start: number;
  /** Date.now() at step body exit (just before step_completed is sent) */
  end: number;
  /** 'queue-hop' if this is the first step body executed in this process
   * (module state persists across warm invocations, so a fresh process means
   * a cold start or a fresh dispatch from the queue after the previous
   * invocation ended); 'inline' for every subsequent step in the same
   * process. See {@link stepKind}. */
  kind: 'inline' | 'queue-hop';
}

// Process-global, initialized once per process. A fresh process (cold start,
// or redispatch via the queue after the prior invocation's ~duration limit)
// resets this to false, so the first step body it runs is tagged
// 'queue-hop'; every step after that in the same warm process is 'inline'.
let hasExecutedStepInProcess = false;

function stepKind(): 'inline' | 'queue-hop' {
  const kind = hasExecutedStepInProcess ? 'inline' : 'queue-hop';
  hasExecutedStepInProcess = true;
  return kind;
}

export interface BenchStreamChunk {
  seq: number;
  /** Date.now() in the step when this chunk was written */
  writtenAt: number;
}

async function timedNoopStep(index: number): Promise<BenchStepTiming> {
  'use step';
  const kind = stepKind();
  const start = Date.now();
  // No body work: `end - start` is ~0, so the gap between consecutive step
  // timings is pure framework overhead.
  void index;
  return { start, end: Date.now(), kind };
}

async function timedStreamingStep(chunks: number): Promise<BenchStepTiming> {
  'use step';
  const kind = stepKind();
  const start = Date.now();
  const writable = getWritable<BenchStreamChunk>();
  const writer = writable.getWriter();
  for (let i = 0; i < chunks; i++) {
    await writer.write({ seq: i, writtenAt: Date.now() });
  }
  writer.releaseLock();
  await writable.close();
  return { start, end: Date.now(), kind };
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
 * Fan-out scenario: `count` trivial steps started together in one
 * `Promise.all`.
 *
 * Every step is dispatched from the same suspension, so the run's step
 * timings describe how the runtime spreads a fan-out: the earliest step body
 * to finish is the first branch a caller could observe, the latest is when
 * the whole fan-out is joinable. The runner turns those into Fan-out
 * TTFS/TTLS. Steps are the same no-op bodies the sequential scenario uses, so
 * the spread is dispatch and concurrency cost, not body work.
 */
export async function benchFanOutStepsWorkflow(count: number): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const pending: Promise<BenchStepTiming>[] = [];
  for (let i = 0; i < count; i++) {
    pending.push(timedNoopStep(i));
  }
  return { steps: await Promise.all(pending) };
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
