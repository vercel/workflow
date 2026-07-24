/**
 * Benchmark runner measuring the workflow runtime's core latency metrics
 * against a deployed workbench app.
 *
 * Every run is triggered through an in-deployment route (`POST /api/bench` on
 * the workbench app) rather than by calling `start()` from this CI process. The
 * route stamps `clientStart` with the deployment's own clock immediately before
 * `start()`, so the CI runner's request — and its entire path through
 * api.vercel.com — sits OUTSIDE every measured window. As a result none of the
 * metrics below depend on the CI runner's clock or its network path to the
 * proxy; they are computed purely from Vercel-side timestamps.
 *
 * Metrics (all in milliseconds, reported as best/p75/p90/p99; avg is kept in
 * the JSON for reference but not shown in the PR comment):
 *
 * The best (fastest) sample is reported alongside the upper percentiles so
 * warm-start latency (the fast floor) is visible next to the cold-start tail:
 * the workbench deployment cold-starts the `/flow` invocation for a large
 * fraction of runs (bursty, low-traffic), which inflates p75+. Cold starts are
 * kept in the numbers on purpose — they are part of real bursty-workload
 * latency — and the best sample shows what a fully warm trigger looks like.
 *
 * - TTFS  (time to first step): `steps[0].start` (first step body execution,
 *          deployment clock) minus the in-deployment `clientStart` returned by
 *          the trigger route. Because `start()` runs inside the deployment, the
 *          turbo path (no hooks) can exercise the runtime's in-process fast
 *          path; the non-turbo path (a hook registered before the step)
 *          exercises the dispatch path. Both are proxy-independent. TTFS
 *          includes the VQS dispatch hop and any `/flow` cold start (see the
 *          best-sample note above).
 * - STSO  (step-to-step overhead): gap between consecutive step body
 *          executions (`steps[i].start - steps[i-1].end`) in a workflow with
 *          many trivial sequential steps. Both timestamps come from step
 *          bodies on the deployment. Reported per step-index range (see
 *          STSO_BUCKETS) because early steps behave differently from late ones
 *          (first-invocation fast paths, growing event log).
 * - WO    (workflow overhead): total time the run spends outside of step
 *          bodies over the whole sequential run, from the in-deployment
 *          `clientStart` to the end of the last step body:
 *          `(lastStep.end - clientStart) - Σ(step durations)`. Measured on the
 *          sequential scenario only — on a single-step workflow WO reduces
 *          algebraically to TTFS.
 * - SL    (stream latency): live write->read propagation for the default
 *          output stream, measured entirely on the deployment by
 *          `benchSlWorkflow`: a reader step and a writer step run in parallel,
 *          the reader blocks on the first chunk, and the workflow returns both
 *          the writer's `writtenAt` and the reader's `readAt`. SL is
 *          `readAt - writtenAt`, so it excludes the api.vercel.com read path
 *          the old client-observed metric included.
 * - SO    (stream overhead): end-to-end write+consume time in excess of a
 *          modelled generation window, measured on the deployment by
 *          `benchSoWorkflow`. A writer streams fake 4-byte LLM-token chunks at
 *          a fixed rate for a fixed duration while a parallel reader drains the
 *          whole stream; SO is `(doneAt - writtenAt) - chunkCount*intervalMs`,
 *          i.e. the overhead/backpressure the stream adds on top of the token
 *          rate. Same setup as SL, but the reader stamps `doneAt` after the
 *          last chunk rather than `readAt` on the first.
 *
 * Scenarios (defined in workbench/example/workflows/97_bench.ts):
 *
 * 1. benchStepWorkflow            — 1 no-op step, turbo mode → TTFS (turbo)
 * 2. benchStreamWorkflow          — 1 streaming step, turbo mode → TTFS (turbo)
 * 3. benchHookStreamWorkflow      — hook + 1 step, non-turbo → TTFS (non-turbo)
 * 4. benchSequentialStepsWorkflow — 1020 trivial sequential steps → STSO + WO
 * 5. benchSlWorkflow              — parallel reader/writer steps → SL
 * 6. benchSoWorkflow              — paced LLM-shaped stream, drained → SO
 *
 * Each scenario runs many iterations (env-tunable, see BENCH_* below) so the
 * percentiles are computed from real samples.
 *
 * The backend is selected exactly like the e2e tests (setupWorld): Vercel when
 * WORKFLOW_VERCEL_ENV is set, Postgres when WORKFLOW_TARGET_WORLD is
 * @workflow/world-postgres, local filesystem otherwise. Because SL is now
 * measured inside the workflow (not by a reader in this process), it no longer
 * depends on `run.getReadable()` working across processes; CI still runs this
 * file against Vercel only.
 *
 * All timestamps are deployment-side, so the only residual skew is intra-Vercel
 * (between step-runner instances in the same region), NTP-bounded and small
 * relative to the measured values.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { getTrustedSourcesHeaders } from '../../../scripts/trusted-sources-headers.mjs';
import { getRun } from '../src/runtime';
import { setupWorld } from './utils';

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

// Iteration counts. The stream/hook/SL scenarios yield one sample per
// iteration; the sequential scenario yields (stepCount - 1) STSO samples per
// iteration, so a single long run already provides solid percentiles.
const STREAM_ITERATIONS = envInt('BENCH_STREAM_ITERATIONS', 30);
const SL_ITERATIONS = envInt('BENCH_SL_ITERATIONS', STREAM_ITERATIONS);
const SO_ITERATIONS = envInt('BENCH_SO_ITERATIONS', STREAM_ITERATIONS);
const SEQUENTIAL_ITERATIONS = envInt('BENCH_SEQUENTIAL_ITERATIONS', 1);
const SEQUENTIAL_STEP_COUNT = envInt('BENCH_SEQUENTIAL_STEP_COUNT', 1020);
const WARMUP_ITERATIONS = envInt('BENCH_WARMUP_ITERATIONS', 2, 0);

// Methodology version — bump whenever the measurement window changes in a way
// that makes numbers incomparable across runs (e.g. the switch from a
// CI/proxy-inclusive clock to the in-deployment trigger). The PR-comment
// renderer keys baseline deltas on this, so old-methodology baselines on `main`
// are not diffed against new-methodology runs (deltas stay blank until `main`
// has produced a same-version baseline). v2 = in-deployment trigger.
const BENCH_METHODOLOGY_VERSION = 2;

// Per-metric latency targets (ms) rendered as 🟢/🔴 marks in the PR comment.
// Provisional: now that the proxy leg is out of every window, these will be
// re-tightened once a few in-deployment baselines land.
const TTFS_TARGETS = { p75: 200, p90: 300, p99: 600 };
const SL_TARGETS = { p75: 50, p90: 60, p99: 125 };

// SO scenario: model a haiku-size LLM streaming tokens — ~100 tokens/sec, each
// token a 4-byte chunk, for 3 seconds (300 chunks). The writer paces itself so
// the write phase spans exactly `SO_CHUNK_COUNT * SO_INTERVAL_MS` ms; SO is the
// end-to-end write+consume time beyond that window (see runSoIteration). These
// derive `SO_NOMINAL_DURATION_MS`, the single value subtracted from the
// measured span, so the workflow's write span and the subtraction never drift.
const SO_CHUNK_RATE_PER_SEC = envInt('BENCH_SO_CHUNK_RATE', 100);
const SO_DURATION_SECONDS = envInt('BENCH_SO_DURATION_SECONDS', 3);
const SO_CHUNK_COUNT = SO_CHUNK_RATE_PER_SEC * SO_DURATION_SECONDS;
const SO_INTERVAL_MS = 1000 / SO_CHUNK_RATE_PER_SEC;
const SO_NOMINAL_DURATION_MS = SO_CHUNK_COUNT * SO_INTERVAL_MS;
// Provisional, like TTFS/SL above: re-tighten once in-deployment baselines land.
const SO_TARGETS = { p75: 250, p90: 500, p99: 1000 };

// STSO percentiles are reported for sampled step-index windows: the gap
// between steps k and k+1 counts toward the window where `from <= k < to`.
// The early window captures first-invocation behavior; the later ones capture
// steady state with an increasingly large event log.
const STSO_BUCKETS = [
  { from: 1, to: 20, targets: { p75: 20, p90: 30, p99: 60 } },
  { from: 101, to: 120, targets: { p75: 30, p90: 45, p99: 90 } },
  { from: 1001, to: 1020, targets: { p75: 40, p90: 60, p99: 120 } },
];
// Guard timeouts so a single stuck run fails fast instead of eating the job.
const RUN_TIMEOUT_MS = envInt('BENCH_RUN_TIMEOUT_MS', 120_000);
// Preflight guard: a trivial 1-step run must complete within this window
// before any scenario spends its attempt budget (see beforeAll below).
const PREFLIGHT_TIMEOUT_MS = envInt('BENCH_PREFLIGHT_TIMEOUT_MS', 180_000);
// An iteration can flake on transient network errors; grant each scenario a
// bounded fraction of spare (retry) attempts on top of its iteration count.
const MAX_FAILURE_RATIO = 0.2;
// When a scenario has produced zero successful iterations after this many
// attempts, the target is systematically broken (not flaking) — abort the
// scenario instead of burning the full attempt budget at RUN_TIMEOUT_MS per
// attempt.
const ZERO_SUCCESS_ABORT_ATTEMPTS = 3;

interface BenchStepTiming {
  start: number;
  end: number;
}

interface BenchStreamLatency {
  writtenAt: number;
  readAt: number;
}

interface BenchStreamOverhead {
  writtenAt: number;
  doneAt: number;
  received: number;
}

interface StreamIterationResult {
  runId: string;
  /** `steps[0].start - clientStart`, both deployment-side clocks. */
  ttfsMs: number;
}

interface SequentialIterationResult {
  runId: string;
  /** stsoMs[i] is the gap between steps i+1 and i+2 (1-indexed). */
  stsoMs: number[];
  /** Whole-run workflow overhead, anchored on the in-deployment clientStart. */
  woMs: number;
}

interface SlIterationResult {
  runId: string;
  /** `readAt - writtenAt`, both deployment-side step-body clocks. */
  slMs: number;
}

interface SoIterationResult {
  runId: string;
  /** `(doneAt - writtenAt) - SO_NOMINAL_DURATION_MS`, deployment-side clocks. */
  soMs: number;
}

/** Response shape of the in-deployment `POST /api/bench` trigger route. */
interface BenchTriggerResponse {
  runId: string;
  /** Date.now() stamped in the route immediately before start(). */
  clientStart: number;
}

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

/**
 * Trigger a benchmark workflow via the in-deployment route so `clientStart` is
 * stamped by the deployment's clock (excluding the CI->ingress request path).
 * Returns the created run id and that anchor.
 */
async function triggerBenchRun(
  workflowFn: string,
  args: unknown[] = []
): Promise<BenchTriggerResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(await getTrustedSourcesHeaders()),
  };
  const response = await fetch(`${deploymentUrl}/api/bench`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workflowFn, args }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `bench trigger for ${workflowFn} failed: ${response.status} ${body.slice(0, 300)}`
    );
  }
  const data = (await response.json()) as Partial<BenchTriggerResponse>;
  if (typeof data.runId !== 'string' || typeof data.clientStart !== 'number') {
    throw new Error(
      `bench trigger for ${workflowFn} returned malformed body: ${JSON.stringify(data)?.slice(0, 200)}`
    );
  }
  return { runId: data.runId, clientStart: data.clientStart };
}

/** Poll a run's return value to completion (the handle polls internally). */
async function getReturnValue(runId: string): Promise<unknown> {
  const run = await getRun(runId);
  return run.returnValue;
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

/**
 * WO: total time outside of step bodies, from `anchorMs` (the in-deployment
 * clientStart) to the last step body's exit. Clamped at 0 to absorb small
 * intra-Vercel clock skew.
 */
function workflowOverheadMs(
  anchorMs: number,
  steps: BenchStepTiming[]
): number {
  const lastEnd = steps[steps.length - 1].end;
  const inStep = steps.reduce((sum, s) => sum + (s.end - s.start), 0);
  return Math.max(0, lastEnd - anchorMs - inStep);
}

async function runStreamIteration(
  workflowFn: string
): Promise<StreamIterationResult> {
  const { runId, clientStart } = await triggerBenchRun(workflowFn);
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS,
      `${workflowFn} returnValue (run ${runId})`
    );
    const steps = timingsFromReturnValue(returnValue, runId);
    return {
      runId,
      // Both timestamps are deployment-side; clamp to absorb tiny skew.
      ttfsMs: Math.max(0, steps[0].start - clientStart),
    };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runSequentialIteration(
  stepCount: number
): Promise<SequentialIterationResult> {
  const { runId, clientStart } = await triggerBenchRun(
    'benchSequentialStepsWorkflow',
    [stepCount]
  );
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS + stepCount * 2_000,
      `benchSequentialStepsWorkflow returnValue (run ${runId})`
    );
    const steps = timingsFromReturnValue(returnValue, runId);
    if (steps.length !== stepCount) {
      throw new Error(
        `Run ${runId} returned ${steps.length} step timings, expected ${stepCount}`
      );
    }

    const stsoMs: number[] = [];
    for (let i = 1; i < steps.length; i++) {
      stsoMs.push(steps[i].start - steps[i - 1].end);
    }

    return {
      runId,
      stsoMs,
      woMs: workflowOverheadMs(clientStart, steps),
    };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runSlIteration(): Promise<SlIterationResult> {
  const { runId } = await triggerBenchRun('benchSlWorkflow');
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS,
      `benchSlWorkflow returnValue (run ${runId})`
    );
    const sl = (returnValue as { sl?: BenchStreamLatency } | undefined)?.sl;
    if (
      !sl ||
      typeof sl.writtenAt !== 'number' ||
      typeof sl.readAt !== 'number'
    ) {
      throw new Error(
        `Run ${runId} returned no stream-latency sample: ${JSON.stringify(returnValue)?.slice(0, 200)}`
      );
    }
    return { runId, slMs: Math.max(0, sl.readAt - sl.writtenAt) };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runSoIteration(): Promise<SoIterationResult> {
  const { runId } = await triggerBenchRun('benchSoWorkflow', [
    SO_CHUNK_COUNT,
    SO_INTERVAL_MS,
  ]);
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      // The writer streams for the whole generation window before the run can
      // complete, so extend the guard past the base run timeout by that window.
      RUN_TIMEOUT_MS + SO_NOMINAL_DURATION_MS,
      `benchSoWorkflow returnValue (run ${runId})`
    );
    const so = (returnValue as { so?: BenchStreamOverhead } | undefined)?.so;
    if (
      !so ||
      typeof so.writtenAt !== 'number' ||
      typeof so.doneAt !== 'number'
    ) {
      throw new Error(
        `Run ${runId} returned no stream-overhead sample: ${JSON.stringify(returnValue)?.slice(0, 200)}`
      );
    }
    if (so.received !== SO_CHUNK_COUNT) {
      throw new Error(
        `Run ${runId} consumed ${so.received} chunks, expected ${SO_CHUNK_COUNT}`
      );
    }
    // Both timestamps are deployment-side; subtract the modelled generation
    // window and clamp to absorb tiny intra-Vercel skew.
    return {
      runId,
      soMs: Math.max(0, so.doneAt - so.writtenAt - SO_NOMINAL_DURATION_MS),
    };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
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
      if (results.length === 0 && attempts >= ZERO_SUCCESS_ABORT_ATTEMPTS) {
        throw new Error(
          `${name}: no successful iterations after ${attempts} attempts — target looks systematically broken, aborting scenario; last error: ${(error as Error).message}`
        );
      }
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
  /** Fastest (best) sample — the warm-start floor vs the cold-start tail. */
  best: number;
  /** Mean; kept in the JSON for reference but not shown in the PR comment. */
  avg: number;
  p75: number;
  p90: number;
  p99: number;
  samples: number;
}

interface MetricTargets {
  p75?: number;
  p90?: number;
  p99?: number;
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
    best: round(sorted[0]),
    avg: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p75: round(percentile(75)),
    p90: round(percentile(90)),
    p99: round(percentile(99)),
    samples: sorted.length,
  };
}

interface MetricRow extends MetricStats {
  /** Short metric id: ttfs | stso | wo | sl */
  metric: string;
  /** Short scenario label; explained via scenario descriptions in the output */
  scenario: string;
  unit: 'ms';
  /** Latency targets rendered as pass/fail marks in the PR comment */
  targets?: MetricTargets;
}

const metricRows: MetricRow[] = [];

function recordMetric(
  metric: string,
  scenario: string,
  samples: number[],
  targets?: MetricTargets
) {
  if (samples.length === 0) return;
  metricRows.push({
    metric,
    scenario,
    unit: 'ms',
    targets,
    ...computeStats(samples),
  });
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

// Short scenario labels for the results table; the descriptions are rendered
// as a legend at the bottom of the PR comment.
const SCENARIO_STEP = 'step';
const SCENARIO_TURBO_STREAM = 'stream';
const SCENARIO_HOOK_STREAM = 'hook + stream';
const SCENARIO_SEQUENTIAL = `${SEQUENTIAL_STEP_COUNT} steps`;
const SCENARIO_STREAM_LATENCY = 'stream latency';
const SCENARIO_STREAM_OVERHEAD = 'stream overhead';
const SCENARIO_DESCRIPTIONS = [
  {
    name: SCENARIO_STEP,
    description:
      'one trivial no-op step, no stream; no hooks, so the run stays in turbo mode (in-process fast path)',
  },
  {
    name: SCENARIO_TURBO_STREAM,
    description:
      'one streaming step; no hooks, so the run stays in turbo mode (in-process fast path)',
  },
  {
    name: SCENARIO_HOOK_STREAM,
    description:
      'registers a hook before one step, which exits turbo mode (dispatch path)',
  },
  {
    name: SCENARIO_SEQUENTIAL,
    description: `${SEQUENTIAL_STEP_COUNT} trivial sequential steps; STSO is measured between consecutive steps in the given step ranges, and WO is the whole-run overhead outside step bodies`,
  },
  {
    name: SCENARIO_STREAM_LATENCY,
    description:
      'parallel reader/writer steps on a dedicated stream; SL is the in-deployment write->read propagation (readAt - writtenAt)',
  },
  {
    name: SCENARIO_STREAM_OVERHEAD,
    description: `writer streams ${SO_CHUNK_COUNT} 4-byte chunks paced at ${SO_CHUNK_RATE_PER_SEC}/s for ${SO_DURATION_SECONDS}s (a haiku-size LLM's token throughput) while a parallel reader drains the whole stream; SO is the end-to-end write+consume time beyond the ${SO_DURATION_SECONDS}s generation window (overhead/backpressure)`,
  },
];

describe('workflow benchmarks', () => {
  // Preflight: prove the deployment executes workflows (and the trigger route
  // works) before any scenario spends its attempt budget. Without this, a
  // target that accepts run creation but never executes runs (e.g. queue not
  // delivering to the deployment) makes every iteration of every scenario wait
  // out RUN_TIMEOUT_MS, and the job dies at its time limit without a useful
  // error.
  beforeAll(async () => {
    const { runId } = await triggerBenchRun(
      'benchSequentialStepsWorkflow',
      [1]
    );
    try {
      const returnValue = await withTimeout(
        getReturnValue(runId),
        PREFLIGHT_TIMEOUT_MS,
        `preflight run (run ${runId})`
      );
      timingsFromReturnValue(returnValue, runId);
      console.log(`[bench] preflight ok (run ${runId})`);
    } catch (error) {
      throw new Error(
        `Benchmark preflight failed — the deployment accepted the run but did not execute it to completion; aborting all scenarios. ${(error as Error).message}`
      );
    }
  }, PREFLIGHT_TIMEOUT_MS + 60_000);

  test('scenario: 1 no-op step (turbo)', { timeout: 30 * 60_000 }, async () => {
    const results = await runScenario(SCENARIO_STEP, STREAM_ITERATIONS, () =>
      runStreamIteration('benchStepWorkflow')
    );
    recordMetric(
      'ttfs',
      SCENARIO_STEP,
      results.map((r) => r.ttfsMs),
      TTFS_TARGETS
    );
  });

  test(
    'scenario: 1 streaming step (turbo)',
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
        results.map((r) => r.ttfsMs),
        TTFS_TARGETS
      );
    }
  );

  test(
    'scenario: hook + 1 step (non-turbo)',
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
        results.map((r) => r.ttfsMs),
        TTFS_TARGETS
      );
    }
  );

  test('scenario: stream latency', { timeout: 30 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_STREAM_LATENCY,
      SL_ITERATIONS,
      () => runSlIteration()
    );
    recordMetric(
      'sl',
      SCENARIO_STREAM_LATENCY,
      results.map((r) => r.slMs),
      SL_TARGETS
    );
  });

  test('scenario: stream overhead', { timeout: 30 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_STREAM_OVERHEAD,
      SO_ITERATIONS,
      () => runSoIteration()
    );
    recordMetric(
      'so',
      SCENARIO_STREAM_OVERHEAD,
      results.map((r) => r.soMs),
      SO_TARGETS
    );
  });

  test('scenario: sequential steps', { timeout: 60 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_SEQUENTIAL,
      SEQUENTIAL_ITERATIONS,
      () => runSequentialIteration(SEQUENTIAL_STEP_COUNT),
      {
        // No warmup: STSO gaps are measured entirely on the deployment (the
        // other scenarios already warmed the client + world), and a warmup
        // run of this scenario would cost as much as a recorded one.
        warmupIterations: 0,
        // A long run occasionally fails outright (e.g. replay divergence
        // under a large event log); give the default single iteration two
        // spare attempts instead of failing the whole scenario.
        extraAttempts: Math.max(2, Math.ceil(SEQUENTIAL_ITERATIONS * 0.5)),
      }
    );
    // Report STSO per step-index window. Gap k (between steps k and k+1,
    // 1-indexed) lives at stsoMs[k - 1].
    for (const { from, to, targets } of STSO_BUCKETS) {
      if (from >= SEQUENTIAL_STEP_COUNT) continue;
      recordMetric(
        'stso',
        `${SCENARIO_SEQUENTIAL} (${from}-${Math.min(to, SEQUENTIAL_STEP_COUNT)})`,
        results.flatMap((r) => r.stsoMs.slice(from - 1, to - 1)),
        targets
      );
    }
    // WO: whole-run overhead outside step bodies, anchored on the in-deployment
    // clientStart. Measured here rather than on the stream scenarios, where a
    // single step makes WO algebraically identical to TTFS.
    recordMetric(
      'wo',
      SCENARIO_SEQUENTIAL,
      results.map((r) => r.woMs)
    );
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
      // Measurement-methodology version; baseline deltas only compare runs
      // with the same value (see annotateWithBaseline in the renderer).
      methodologyVersion: BENCH_METHODOLOGY_VERSION,
      app: appName,
      backend,
      generatedAt: new Date().toISOString(),
      commit: process.env.GITHUB_SHA || undefined,
      config: {
        streamIterations: STREAM_ITERATIONS,
        slIterations: SL_ITERATIONS,
        soIterations: SO_ITERATIONS,
        soChunkCount: SO_CHUNK_COUNT,
        soChunkRatePerSec: SO_CHUNK_RATE_PER_SEC,
        soDurationSeconds: SO_DURATION_SECONDS,
        sequentialIterations: SEQUENTIAL_ITERATIONS,
        sequentialStepCount: SEQUENTIAL_STEP_COUNT,
        warmupIterations: WARMUP_ITERATIONS,
      },
      scenarios: SCENARIO_DESCRIPTIONS,
      metrics: metricRows,
    };
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`[bench] Results written to ${outputPath}`);
    console.table(
      metricRows.map(
        ({ metric, scenario, best, avg, p75, p90, p99, samples }) => ({
          metric,
          scenario,
          best,
          avg,
          p75,
          p90,
          p99,
          samples,
        })
      )
    );
  });
});
