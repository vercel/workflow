/**
 * Benchmark runner measuring the workflow runtime's core latency metrics
 * against a deployed workbench app.
 *
 * Metrics (all in milliseconds, reported as avg/p50/p90/p99):
 *
 * - TTFS  (time to first step): client-side timestamp taken when `start()` is
 *          called (the run_created request) → first step body execution.
 *          Measured for both the turbo path (no hooks) and the non-turbo path
 *          (a hook was registered before the step).
 * - STSO  (step-to-step overhead): gap between consecutive step body
 *          executions (`steps[i].start - steps[i-1].end`) in a workflow with
 *          many trivial sequential steps. Reported per step-index range
 *          (see STSO_BUCKETS) because early steps behave differently from
 *          late ones (first-invocation fast paths, growing event log).
 * - WO    (workflow overhead): total time the run spends outside of step
 *          bodies, from the client-side `start()` timestamp to the end of the
 *          last step body (the moment just before the final step_completed
 *          request is sent): `(lastStep.end - clientStart) - Σ(step durations)`.
 * - SL    (stream latency): time between a step writing the first chunk to
 *          the workflow's default output stream and that chunk becoming
 *          visible to a reader attached via `run.getReadable()`.
 *
 * Scenarios (defined in workbench/example/workflows/97_bench.ts):
 *
 * 1. benchStreamWorkflow          — 1 streaming step, turbo mode → TTFS + SL + WO
 * 2. benchSequentialStepsWorkflow — 1020 trivial sequential steps → STSO
 * 3. benchHookStreamWorkflow      — hook + 1 streaming step, non-turbo → TTFS + SL + WO
 *
 * Each scenario runs many iterations (env-tunable, see BENCH_* below) so the
 * percentiles are computed from real samples.
 *
 * The backend is selected exactly like the e2e tests (setupWorld): Vercel when
 * WORKFLOW_VERCEL_ENV is set, Postgres when WORKFLOW_TARGET_WORLD is
 * @workflow/world-postgres, local filesystem otherwise. Note that SL requires
 * `run.getReadable()` to work from a separate process, which the local world's
 * in-process streamer does not support — CI currently runs this file against
 * Vercel only.
 *
 * TTFS and WO compare a client-side clock against the deployment's clock, and
 * SL compares the step runner's clock against the client's; both machines are
 * NTP-synced in CI, so skew is small relative to the measured values.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, test } from 'vitest';
import { start } from '../src/runtime';
import { getWorkflowMetadata, setupWorld } from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

setupWorld(deploymentUrl);

const envInt = (name: string, fallback: number, min = 1): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
};

// Iteration counts. Stream scenarios yield one TTFS/SL/WO sample per
// iteration; the sequential scenario yields (stepCount - 1) STSO samples per
// iteration, so a single long run already provides solid percentiles.
const STREAM_ITERATIONS = envInt('BENCH_STREAM_ITERATIONS', 30);
const SEQUENTIAL_ITERATIONS = envInt('BENCH_SEQUENTIAL_ITERATIONS', 1);
const SEQUENTIAL_STEP_COUNT = envInt('BENCH_SEQUENTIAL_STEP_COUNT', 1020);
const WARMUP_ITERATIONS = envInt('BENCH_WARMUP_ITERATIONS', 2, 0);

// STSO percentiles are reported per step-index range: the gap between steps k
// and k+1 falls into the bucket where `from <= k < to`. Early gaps capture
// first-invocation behavior; late gaps capture steady state with a large
// event log.
const STSO_BUCKETS = [
  { from: 1, to: 20 },
  { from: 20, to: 120 },
  { from: 120, to: 1020 },
];
// Guard timeouts so a single stuck run fails fast instead of eating the job.
const RUN_TIMEOUT_MS = envInt('BENCH_RUN_TIMEOUT_MS', 120_000);
// An iteration can flake on transient network errors; grant each scenario a
// bounded fraction of spare (retry) attempts on top of its iteration count.
const MAX_FAILURE_RATIO = 0.2;

interface BenchStepTiming {
  start: number;
  end: number;
}

interface BenchStreamChunk {
  seq: number;
  writtenAt: number;
}

interface StreamIterationResult {
  runId: string;
  ttfsMs: number;
  woMs: number;
  slMs: number;
}

interface SequentialIterationResult {
  runId: string;
  /** stsoMs[i] is the gap between steps i+1 and i+2 (1-indexed). */
  stsoMs: number[];
}

const benchWf = (fn: string) =>
  getWorkflowMetadata(deploymentUrl, 'workflows/97_bench.ts', fn);

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
        ms
      );
      // Don't keep the process alive just for the guard.
      timer.unref?.();
    }),
  ]);
}

function timingsFromReturnValue(
  value: unknown,
  runId: string
): BenchStepTiming[] {
  const steps = (value as { steps?: BenchStepTiming[] } | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      `Run ${runId} returned no step timings: ${JSON.stringify(value)?.slice(0, 200)}`
    );
  }
  for (const step of steps) {
    if (typeof step?.start !== 'number' || typeof step?.end !== 'number') {
      throw new Error(
        `Run ${runId} returned malformed step timing: ${JSON.stringify(step)}`
      );
    }
  }
  return steps;
}

/** WO: total time outside of step bodies, from client start to last body end. */
function workflowOverheadMs(
  clientStart: number,
  steps: BenchStepTiming[]
): number {
  const lastEnd = steps[steps.length - 1].end;
  const inStep = steps.reduce((sum, s) => sum + (s.end - s.start), 0);
  return lastEnd - clientStart - inStep;
}

async function runStreamIteration(
  workflowFn: string
): Promise<StreamIterationResult> {
  const wf = await benchWf(workflowFn);
  const clientStart = Date.now();
  const run = await start(wf, []);
  try {
    // Attach the reader right away — before the step executes — so first-chunk
    // visibility is bounded by the streaming pipeline, not by when we read.
    const reader = run
      .getReadable<BenchStreamChunk>()
      .getReader() as ReadableStreamDefaultReader<BenchStreamChunk>;

    let slMs: number | undefined;
    let chunksSeen = 0;
    // Drain the whole stream (the step closes it); the first chunk yields the
    // SL sample. Intentionally no reader.cancel() — leave the reader behind on
    // timeout instead (cancellation of in-flight world streams can hang).
    await withTimeout(
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const readAt = Date.now();
          if (chunksSeen === 0) {
            if (typeof value?.writtenAt !== 'number') {
              throw new Error(
                `Malformed stream chunk: ${JSON.stringify(value)?.slice(0, 200)}`
              );
            }
            slMs = readAt - value.writtenAt;
          }
          chunksSeen++;
        }
      })(),
      RUN_TIMEOUT_MS,
      `${workflowFn} stream read (run ${run.runId})`
    );
    if (slMs === undefined) {
      throw new Error(`Run ${run.runId} produced no stream chunks`);
    }

    const returnValue = await withTimeout(
      run.returnValue,
      RUN_TIMEOUT_MS,
      `${workflowFn} returnValue (run ${run.runId})`
    );
    const steps = timingsFromReturnValue(returnValue, run.runId);

    return {
      runId: run.runId,
      ttfsMs: steps[0].start - clientStart,
      woMs: workflowOverheadMs(clientStart, steps),
      slMs,
    };
  } catch (error) {
    (error as Error).message += ` (run ${run.runId})`;
    throw error;
  }
}

async function runSequentialIteration(
  stepCount: number
): Promise<SequentialIterationResult> {
  const wf = await benchWf('benchSequentialStepsWorkflow');
  const run = await start(wf, [stepCount]);
  try {
    const returnValue = await withTimeout(
      run.returnValue,
      RUN_TIMEOUT_MS + stepCount * 2_000,
      `benchSequentialStepsWorkflow returnValue (run ${run.runId})`
    );
    const steps = timingsFromReturnValue(returnValue, run.runId);
    if (steps.length !== stepCount) {
      throw new Error(
        `Run ${run.runId} returned ${steps.length} step timings, expected ${stepCount}`
      );
    }

    const stsoMs: number[] = [];
    for (let i = 1; i < steps.length; i++) {
      stsoMs.push(steps[i].start - steps[i - 1].end);
    }

    return {
      runId: run.runId,
      stsoMs,
    };
  } catch (error) {
    (error as Error).message += ` (run ${run.runId})`;
    throw error;
  }
}

/**
 * Runs recorded iterations (plus warmups) sequentially — concurrency would
 * contend on the same deployment and skew latencies. Failed iterations are
 * retried (each scenario gets `extraAttempts` spare attempts on top of the
 * requested iteration count), so a transient failure doesn't zero out or
 * shrink the sample set; the scenario only fails when the attempt budget
 * can't produce the full number of iterations.
 */
async function runScenario<T>(
  name: string,
  iterations: number,
  iteration: () => Promise<T>,
  {
    warmupIterations = WARMUP_ITERATIONS,
    extraAttempts = Math.ceil(iterations * MAX_FAILURE_RATIO),
  }: { warmupIterations?: number; extraAttempts?: number } = {}
): Promise<T[]> {
  for (let i = 0; i < warmupIterations; i++) {
    try {
      await iteration();
    } catch (error) {
      // Warmup failures are non-fatal but worth surfacing.
      console.warn(`[bench] ${name} warmup ${i + 1} failed:`, error);
    }
  }

  const results: T[] = [];
  const failures: Error[] = [];
  const maxAttempts = iterations + extraAttempts;
  let attempts = 0;
  while (results.length < iterations && attempts < maxAttempts) {
    attempts++;
    try {
      results.push(await iteration());
    } catch (error) {
      failures.push(error as Error);
      console.warn(
        `[bench] ${name} attempt ${attempts}/${maxAttempts} failed:`,
        error
      );
    }
  }

  console.log(
    `[bench] ${name}: ${results.length}/${iterations} iterations succeeded (${attempts} attempts)`
  );
  if (results.length < iterations) {
    throw new Error(
      `${name}: only ${results.length}/${iterations} iterations succeeded after ${attempts} attempts; last error: ${failures[failures.length - 1]?.message}`
    );
  }
  return results;
}

// ============================================================================
// Stats & output
// ============================================================================

interface MetricStats {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  samples: number;
}

function computeStats(samples: number[]): MetricStats {
  if (samples.length === 0) {
    throw new Error('Cannot compute stats over zero samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (q: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1)
    ];
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    avg: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p50: round(percentile(50)),
    p90: round(percentile(90)),
    p99: round(percentile(99)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    samples: sorted.length,
  };
}

interface MetricRow extends MetricStats {
  /** Short metric id: ttfs | stso | wo | sl */
  metric: string;
  /** Human-readable scenario label */
  scenario: string;
  unit: 'ms';
}

const metricRows: MetricRow[] = [];

function recordMetric(metric: string, scenario: string, samples: number[]) {
  if (samples.length === 0) return;
  metricRows.push({ metric, scenario, unit: 'ms', ...computeStats(samples) });
}

function getBackend(): string {
  if (process.env.WORKFLOW_BENCH_BACKEND) {
    return process.env.WORKFLOW_BENCH_BACKEND;
  }
  if (process.env.WORKFLOW_VERCEL_ENV) return 'vercel';
  if (process.env.WORKFLOW_TARGET_WORLD?.includes('postgres')) {
    return 'postgres';
  }
  return 'local';
}

const SCENARIO_TURBO_STREAM = '1 step + stream (turbo)';
const SCENARIO_HOOK_STREAM = 'hook + 1 step + stream (non-turbo)';
const SCENARIO_SEQUENTIAL = `${SEQUENTIAL_STEP_COUNT} sequential steps`;

describe('workflow benchmarks', () => {
  test(
    'scenario: 1 step + stream (turbo)',
    { timeout: 30 * 60_000 },
    async () => {
      const results = await runScenario(
        SCENARIO_TURBO_STREAM,
        STREAM_ITERATIONS,
        () => runStreamIteration('benchStreamWorkflow')
      );
      recordMetric(
        'ttfs',
        SCENARIO_TURBO_STREAM,
        results.map((r) => r.ttfsMs)
      );
      recordMetric(
        'sl',
        SCENARIO_TURBO_STREAM,
        results.map((r) => r.slMs)
      );
      recordMetric(
        'wo',
        SCENARIO_TURBO_STREAM,
        results.map((r) => r.woMs)
      );
    }
  );

  test(
    'scenario: hook + 1 step + stream (non-turbo)',
    { timeout: 30 * 60_000 },
    async () => {
      const results = await runScenario(
        SCENARIO_HOOK_STREAM,
        STREAM_ITERATIONS,
        () => runStreamIteration('benchHookStreamWorkflow')
      );
      recordMetric(
        'ttfs',
        SCENARIO_HOOK_STREAM,
        results.map((r) => r.ttfsMs)
      );
      recordMetric(
        'sl',
        SCENARIO_HOOK_STREAM,
        results.map((r) => r.slMs)
      );
      recordMetric(
        'wo',
        SCENARIO_HOOK_STREAM,
        results.map((r) => r.woMs)
      );
    }
  );

  test('scenario: sequential steps', { timeout: 60 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_SEQUENTIAL,
      SEQUENTIAL_ITERATIONS,
      () => runSequentialIteration(SEQUENTIAL_STEP_COUNT),
      {
        // No warmup: STSO gaps are measured entirely on the deployment (the
        // stream scenarios already warmed the client + world), and a warmup
        // run of this scenario would cost as much as a recorded one.
        warmupIterations: 0,
        // A long run occasionally fails outright (e.g. replay divergence
        // under a large event log); give the default single iteration two
        // spare attempts instead of failing the whole scenario.
        extraAttempts: Math.max(2, Math.ceil(SEQUENTIAL_ITERATIONS * 0.5)),
      }
    );
    // Report STSO per step-index range. Gap k (between steps k and k+1,
    // 1-indexed) lives at stsoMs[k - 1].
    for (const { from, to } of STSO_BUCKETS) {
      if (from >= SEQUENTIAL_STEP_COUNT) continue;
      recordMetric(
        'stso',
        `${SCENARIO_SEQUENTIAL} (steps ${from}-${Math.min(to, SEQUENTIAL_STEP_COUNT)})`,
        results.flatMap((r) => r.stsoMs.slice(from - 1, to - 1))
      );
    }
  });

  afterAll(() => {
    if (metricRows.length === 0) {
      console.warn('[bench] No metrics collected; skipping results file');
      return;
    }
    const appName = process.env.APP_NAME || 'unknown';
    const backend = getBackend();
    const outputPath = path.resolve(
      process.cwd(),
      process.env.BENCH_OUTPUT_FILE ??
        `bench-results-${appName}-${backend}.json`
    );
    const results = {
      version: 1,
      app: appName,
      backend,
      generatedAt: new Date().toISOString(),
      commit: process.env.GITHUB_SHA || undefined,
      config: {
        streamIterations: STREAM_ITERATIONS,
        sequentialIterations: SEQUENTIAL_ITERATIONS,
        sequentialStepCount: SEQUENTIAL_STEP_COUNT,
        warmupIterations: WARMUP_ITERATIONS,
      },
      metrics: metricRows,
    };
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`[bench] Results written to ${outputPath}`);
    console.table(
      metricRows.map(({ metric, scenario, avg, p50, p90, p99, samples }) => ({
        metric,
        scenario,
        avg,
        p50,
        p90,
        p99,
        samples,
      }))
    );
  });
});
