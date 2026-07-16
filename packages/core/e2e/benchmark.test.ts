/**
 * Benchmark runner measuring the workflow runtime's core latency metrics
 * against a deployed workbench app.
 *
 * Metrics (all in milliseconds, reported as avg/p75/p90/p99):
 *
 * - TTFS  (time to first step): server-side `run_created` timestamp
 *          (Vercel-assigned `createdAt`) → first step body execution
 *          (`steps[0].start`, the deployment's clock). Both endpoints are
 *          Vercel-provided, so the measurement is independent of the CI
 *          runner's clock and its network path to api.vercel.com. Because the
 *          server anchor starts *after* the create request's inbound leg, a
 *          flat RTT_OVERHEAD_MS is added as an estimate of that client→ingress
 *          request overhead. Measured for both the turbo path (no hooks) and
 *          the non-turbo path (a hook was registered before the step).
 * - STSO  (step-to-step overhead): gap between consecutive step body
 *          executions (`steps[i].start - steps[i-1].end`) in a workflow with
 *          many trivial sequential steps. Both timestamps come from step
 *          bodies on the deployment, so STSO is already independent of the CI
 *          client and the api.vercel.com proxy. Reported per step-index range
 *          (see STSO_BUCKETS) because early steps behave differently from
 *          late ones (first-invocation fast paths, growing event log).
 * - WO    (workflow overhead): total time the run spends outside of step
 *          bodies over the whole sequential run, from the server-side
 *          `run_created` timestamp to the end of the last step body:
 *          `(lastStep.end - runCreatedServerMs) - Σ(step durations)`, plus the
 *          flat RTT_OVERHEAD_MS. Measured on the sequential scenario only — on
 *          a single-step workflow WO reduces algebraically to TTFS.
 * - SL    (stream latency): time between a step writing the first chunk to
 *          the workflow's default output stream and that chunk becoming
 *          visible to a reader attached via `run.getReadable()`. Unlike the
 *          other metrics this is inherently client-observed: it includes the
 *          api.vercel.com read path (a server-side measurement would need
 *          runtime/world changes and is a separate follow-up).
 *
 * Scenarios (defined in workbench/example/workflows/97_bench.ts):
 *
 * 1. benchStreamWorkflow          — 1 streaming step, turbo mode → TTFS + SL
 * 2. benchSequentialStepsWorkflow — 1020 trivial sequential steps → STSO + WO
 * 3. benchHookStreamWorkflow      — hook + 1 streaming step, non-turbo → TTFS + SL
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
 * TTFS/WO anchor on the Vercel-assigned `run_created` timestamp (fetched via
 * the world's event log) and end on the deployment's step-body clock; the only
 * residual skew is intra-Vercel (workflow-server vs step runner), NTP-bounded
 * and small. SL still compares the step runner's clock against the client's.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { getWorld, start } from '../src/runtime';
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

// TTFS/WO anchor on the Vercel-assigned `run_created` timestamp, which is
// stamped only after the client's create request has reached the ingress — so
// the server anchor excludes that client→api.vercel.com inbound leg. We add
// this flat estimate of the request overhead (RTT) back in, keeping the metric
// deterministic (no CI-network variance) while still approximating end-to-end.
// The observed inbound leg is ~100-200ms; 80ms is a conservative flat default.
const RTT_OVERHEAD_MS = envInt('BENCH_RTT_OVERHEAD_MS', 80, 0);

// Per-metric latency targets (ms) rendered as 🟢/🔴 marks in the PR comment.
const TTFS_TARGETS = { p75: 200, p90: 300, p99: 600 };
const SL_TARGETS = { p75: 50, p90: 60, p99: 125 };

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

interface BenchStreamChunk {
  seq: number;
  writtenAt: number;
}

interface StreamIterationResult {
  runId: string;
  /** Server-anchored TTFS (+ flat RTT estimate); the reported metric. */
  ttfsMs: number;
  /**
   * Client wall-clock TTFS (`steps[0].start - clientStart`), kept for
   * diagnostics only (logged/serialized, not reported as a metric). Comparing
   * it against `ttfsMs - RTT_OVERHEAD_MS` shows how well the flat 80ms tracks
   * the real client→ingress overhead.
   */
  ttfsWallMs: number;
  slMs: number;
}

interface SequentialIterationResult {
  runId: string;
  /** stsoMs[i] is the gap between steps i+1 and i+2 (1-indexed). */
  stsoMs: number[];
  /** Server-anchored whole-run workflow overhead (+ flat RTT estimate). */
  woMs: number;
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

/**
 * Vercel-assigned run-creation timestamp (epoch ms), read from the world's
 * event log so TTFS/WO anchor on a server clock rather than the CI runner's.
 * Prefers the `run_created` event's `createdAt` (server-stamped, distinct from
 * the client `occurredAt`); falls back to the run snapshot's `createdAt`.
 * Returns undefined if neither can be read, so callers can degrade to the
 * client anchor rather than dropping the sample.
 */
async function runCreatedServerMs(runId: string): Promise<number | undefined> {
  try {
    const world = await getWorld();
    const { data } = await world.events.list({ runId });
    const created = data.find((e) => e.eventType === 'run_created');
    const createdMs = created?.createdAt?.getTime?.();
    if (typeof createdMs === 'number' && Number.isFinite(createdMs)) {
      return createdMs;
    }
    const run = await world.runs.get(runId);
    const runCreatedMs = run.createdAt?.getTime?.();
    return typeof runCreatedMs === 'number' && Number.isFinite(runCreatedMs)
      ? runCreatedMs
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Raw WO: total time outside of step bodies, from `anchorMs` to the last step
 * body's exit. The caller supplies the server `run_created` timestamp as the
 * anchor and adds RTT_OVERHEAD_MS; the value is clamped at 0 to absorb small
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

    // Anchor TTFS at the Vercel-assigned run-creation time so the metric is
    // independent of the CI runner's clock and its path to api.vercel.com,
    // then add the flat RTT estimate for the create request's inbound leg.
    // If the server timestamp can't be read, degrade to the client anchor
    // (which already includes the real RTT — no flat estimate is added).
    const serverAnchor = await runCreatedServerMs(run.runId);
    const ttfsWallMs = steps[0].start - clientStart;
    const ttfsMs =
      serverAnchor !== undefined
        ? Math.max(0, steps[0].start - serverAnchor) + RTT_OVERHEAD_MS
        : ttfsWallMs;
    if (serverAnchor === undefined) {
      console.warn(
        `[bench] ${workflowFn} run ${run.runId}: no server run_created timestamp; TTFS degraded to client anchor`
      );
    }

    return {
      runId: run.runId,
      ttfsMs,
      ttfsWallMs,
      slMs,
    };
  } catch (error) {
    // A stream-read timeout alone can't distinguish "the run never executed"
    // (queue not delivering to this deployment) from "the read path is
    // broken" (run finished but chunks never became visible). Probe the run
    // state so the failure log answers that question.
    let runState = 'unknown';
    try {
      await withTimeout(run.returnValue, 5_000, 'run state probe');
      runState = 'run completed';
    } catch (probe) {
      runState = (probe as Error).message.startsWith('Timed out')
        ? 'run still not finished'
        : `run failed: ${(probe as Error).message}`;
    }
    (error as Error).message += ` (run ${run.runId}; ${runState})`;
    throw error;
  }
}

async function runSequentialIteration(
  stepCount: number
): Promise<SequentialIterationResult> {
  const wf = await benchWf('benchSequentialStepsWorkflow');
  const clientStart = Date.now();
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

    // Server-anchored whole-run WO (+ flat RTT). Degrade to the client start
    // if the server timestamp is unavailable (then the RTT is already
    // included, so no flat estimate is added).
    const serverAnchor = await runCreatedServerMs(run.runId);
    const woMs =
      serverAnchor !== undefined
        ? workflowOverheadMs(serverAnchor, steps) + RTT_OVERHEAD_MS
        : workflowOverheadMs(clientStart, steps);

    return {
      runId: run.runId,
      stsoMs,
      woMs,
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
  avg: number;
  p75: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
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
    avg: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p75: round(percentile(75)),
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

/**
 * Log the client wall-clock TTFS alongside the reported server-anchored TTFS
 * so the flat RTT_OVERHEAD_MS assumption can be validated from CI logs. Not a
 * reported metric — diagnostics only. `wall - (server - RTT)` is the residual
 * between the real client→ingress overhead and our flat estimate.
 */
function logTtfsWallDiagnostic(
  scenario: string,
  results: StreamIterationResult[]
) {
  if (results.length === 0) return;
  const wall = computeStats(results.map((r) => r.ttfsWallMs));
  const server = computeStats(results.map((r) => r.ttfsMs));
  console.log(
    `[bench] ${scenario} TTFS diagnostic: server+RTT avg ${server.avg}ms, ` +
      `client wall-clock avg ${wall.avg}ms (RTT flat estimate ${RTT_OVERHEAD_MS}ms)`
  );
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
const SCENARIO_TURBO_STREAM = 'stream';
const SCENARIO_HOOK_STREAM = 'hook + stream';
const SCENARIO_SEQUENTIAL = `${SEQUENTIAL_STEP_COUNT} steps`;
const SCENARIO_DESCRIPTIONS = [
  {
    name: SCENARIO_TURBO_STREAM,
    description:
      'one step that streams chunks back to the client; no hooks, so the run stays in turbo mode',
  },
  {
    name: SCENARIO_HOOK_STREAM,
    description:
      'registers a hook before the same streaming step, which exits turbo mode',
  },
  {
    name: SCENARIO_SEQUENTIAL,
    description: `${SEQUENTIAL_STEP_COUNT} trivial sequential steps; STSO is measured between consecutive steps in the given step ranges, and WO is the whole-run overhead outside step bodies`,
  },
];

describe('workflow benchmarks', () => {
  // Preflight: prove the deployment executes workflows at all before any
  // scenario spends its attempt budget. Without this, a target that accepts
  // run creation but never executes runs (e.g. queue not delivering to the
  // deployment) makes every iteration of every scenario wait out
  // RUN_TIMEOUT_MS, and the job dies at its time limit without a useful
  // error.
  beforeAll(async () => {
    const wf = await benchWf('benchSequentialStepsWorkflow');
    const run = await start(wf, [1]);
    try {
      const returnValue = await withTimeout(
        run.returnValue,
        PREFLIGHT_TIMEOUT_MS,
        `preflight run (run ${run.runId})`
      );
      timingsFromReturnValue(returnValue, run.runId);
      console.log(`[bench] preflight ok (run ${run.runId})`);
    } catch (error) {
      throw new Error(
        `Benchmark preflight failed — the deployment accepted the run but did not execute it to completion; aborting all scenarios. ${(error as Error).message}`
      );
    }
  }, PREFLIGHT_TIMEOUT_MS + 60_000);

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
        results.map((r) => r.ttfsMs),
        TTFS_TARGETS
      );
      logTtfsWallDiagnostic(SCENARIO_TURBO_STREAM, results);
      recordMetric(
        'sl',
        SCENARIO_TURBO_STREAM,
        results.map((r) => r.slMs),
        SL_TARGETS
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
        results.map((r) => r.ttfsMs),
        TTFS_TARGETS
      );
      logTtfsWallDiagnostic(SCENARIO_HOOK_STREAM, results);
      recordMetric(
        'sl',
        SCENARIO_HOOK_STREAM,
        results.map((r) => r.slMs),
        SL_TARGETS
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
    // WO: whole-run overhead outside step bodies (server-anchored + flat RTT).
    // Measured here rather than on the stream scenarios, where a single step
    // makes WO algebraically identical to TTFS.
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
      scenarios: SCENARIO_DESCRIPTIONS,
      metrics: metricRows,
    };
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`[bench] Results written to ${outputPath}`);
    console.table(
      metricRows.map(({ metric, scenario, avg, p75, p90, p99, samples }) => ({
        metric,
        scenario,
        avg,
        p75,
        p90,
        p99,
        samples,
      }))
    );
  });
});
