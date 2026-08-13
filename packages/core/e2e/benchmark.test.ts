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
 *          bodies on the deployment. Reported split by whether the step
 *          ending the gap was 'inline' (same warm process as the step before
 *          it) or a 'queue-hop' (first step of a fresh process — cold start
 *          or a redispatch after the prior invocation's duration limit) —
 *          the two have very different cost profiles and averaging them
 *          together hides that. The workflow itself tags each step's kind
 *          (see workflows/97_bench.ts's `stepKind`).
 * - Fan-out TTFS/TTLS: the two ends of a single `Promise.all` over many trivial
 *          steps, both anchored on the same in-deployment `clientStart`. TTFS is
 *          the earliest step body to *finish* (`min(step.end) - clientStart`) —
 *          the first branch a caller could observe — and TTLS the latest
 *          (`max(step.end) - clientStart`), when the whole fan-out is joinable.
 *          The step bodies are no-ops, so TTLS - TTFS is the spread the runtime
 *          adds across the fan-out (dispatch + concurrency), not body work.
 *          Reported as separate rows so a change that speeds up the first
 *          branch while stretching the tail is visible instead of averaged out.
 * - WO    (workflow overhead): total time the run spends outside of step
 *          bodies over the whole sequential run, from the in-deployment
 *          `clientStart` to the end of the last step body:
 *          `(lastStep.end - clientStart) - Σ(step durations)`. Measured on the
 *          sequential scenario only — on a single-step workflow WO reduces
 *          algebraically to TTFS.
 * - CRTT  (chunk round-trip time): per-chunk write->read latency, measured
 *          on the deployment by benchCrttWorkflow. The "round trip" is
 *          deployment -> stream backend -> reader on the SAME deployment
 *          (one clock domain), not an echo to the writer. NAMING: CRTT is
 *          reserved for this same-clock measurement; the future production
 *          cross-clock one-way metric is CTT. Every delta embeds
 *          { seq, writtenAt }; writer and reader run in parallel behind a
 *          reader-ready barrier (chunk 0 is a live delivery). CRTT subsumes
 *          the retired SL/SO rows: SL = the seq-0 slice, SO = last-chunk RTT
 *          + stall accumulation, at ~100x the samples. Aggregation happens
 *          INSIDE the reader step: index buckets (seq 0 / 1-20 / 21+), fixed
 *          log-bin histograms, and mean-RTT profiles over stream progress
 *          and chunk size; the runner merges per-iteration summaries (exact
 *          best/avg/count/hist, percentile-of-percentiles for p50-p99).
 *          Per-index rows are artifact-only (detail: true). No targets yet.
 * - CDV   (chunk delay variation, "delivery jitter"): for seq-adjacent
 *          chunks received back to back, cdv_i = CTT_i - CTT_{i-1}, computed
 *          from RAW unclamped timestamps. Each gap subtracts same-clock
 *          stamps, so CDV is skew-free — the one per-chunk stat measurable
 *          in production across clock domains. Positives are clumps/stalls,
 *          negatives catch-up, means telescope away — the sample unit is
 *          each run's MAX positive cdv. Writer pauses self-exclude, which is
 *          why write slip (writtenAt - scheduledAt vs the open-loop absolute
 *          schedule) stays as artifact-only data: it is the producer-stall
 *          guard neither CRTT nor CDV can see.
 * - STREAM TABLE: stream scenarios render as one row each in their own
 *          table: writer/reader sustained rates (steady window, 10% trimmed
 *          each side), first-chunk RTT (seq-0, the retired SL signal), CRTT
 *          p75/p90/p99, CDV max. Cells are medians of per-run values (kept
 *          in the artifacts). No 🔴/🟢 marks until targets attach.
 *
 * Scenarios (defined in workbench/example/workflows/97_bench.ts):
 *
 * 1. benchStepWorkflow            — 1 no-op step, turbo mode → TTFS (turbo)
 * 2. benchStreamWorkflow          — 1 streaming step, turbo mode → TTFS (turbo)
 * 3. benchHookStreamWorkflow      — hook + 1 step, non-turbo → TTFS (non-turbo)
 * 4. benchSequentialStepsWorkflow — 1020 trivial sequential steps → STSO + WO
 * 5. benchFanOutStepsWorkflow     — Promise.all over 100 trivial steps
 *                                   → Fan-out TTFS + Fan-out TTLS
 * 6. benchCrttWorkflow            — paced stream of self-timestamping chunks →
 *                                   CRTT/CDV/rates (llm-shaped and size-sweep
 *                                   variants)
 * 7. benchReplayWorkflow          — replays REAL captured stream cadences
 *                                   (write instants + chunk sizes from the
 *                                   capture, speed multiplier the only knob)
 *                                   → replay rows
 *
 * Each scenario runs many iterations (env-tunable, see BENCH_* below) so the
 * percentiles are computed from real samples.
 *
 * The backend is selected exactly like the e2e tests (setupWorld): Vercel when
 * WORKFLOW_VERCEL_ENV is set, Postgres when WORKFLOW_TARGET_WORLD is
 * @workflow/world-postgres, local filesystem otherwise. CRTT is measured
 * inside the workflow (not by a reader in this process), so it does not
 * depend on `run.getReadable()` working across processes; CI still runs this
 * file against Vercel only.
 *
 * All timestamps are deployment-side, so the only residual skew is intra-Vercel
 * (between step-runner instances in the same region), NTP-bounded and small
 * relative to the measured values.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { getTrustedSourcesHeaders } from '../../../scripts/trusted-sources-headers.mjs';
import { BENCH_CADENCES } from '../../../workbench/example/workflows/97_bench_cadence';
import {
  type BenchDelayTail,
  type BenchRttMeanProfile,
  type BenchRttSummary,
  type BenchSteadyRate,
  mergeMeanProfiles,
  mergeRttSummaries,
  RTT_HIST_EDGES_MS,
  RTT_INDEX_BUCKETS,
} from '../../../workbench/example/workflows/97_bench_rtt';
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

// Iteration counts. The stream/hook scenarios yield one sample per
// iteration; the sequential scenario yields (stepCount - 1) STSO samples per
// iteration, so a single long run already provides solid percentiles.
const STREAM_ITERATIONS = envInt('BENCH_STREAM_ITERATIONS', 30);
// Each CRTT iteration yields one RTT sample per chunk (300 by default), so
// few iterations already give thousands of samples per bucket.
const CRTT_ITERATIONS = envInt('BENCH_CRTT_ITERATIONS', 10);
const SEQUENTIAL_ITERATIONS = envInt('BENCH_SEQUENTIAL_ITERATIONS', 1);
const SEQUENTIAL_STEP_COUNT = envInt('BENCH_SEQUENTIAL_STEP_COUNT', 1020);
// The fan-out scenario yields exactly one TTFS and one TTLS sample per
// iteration (they are whole-run properties), so it needs several iterations for
// percentiles — but each iteration executes FANOUT_STEP_COUNT steps, so it gets
// fewer than the single-step scenarios to keep the job's wall time bounded.
const FANOUT_ITERATIONS = envInt('BENCH_FANOUT_ITERATIONS', 10);
const FANOUT_STEP_COUNT = envInt('BENCH_FANOUT_STEP_COUNT', 100);
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

// CRTT workload: model a haiku-size LLM streaming tokens — ~100 tokens/sec
// for 3 seconds (300 chunks). The writer paces itself so the write phase
// spans exactly `CRTT_CHUNK_COUNT * CRTT_INTERVAL_MS` ms.
const CRTT_CHUNK_RATE_PER_SEC = envInt('BENCH_CRTT_CHUNK_RATE', 100);
const CRTT_DURATION_SECONDS = envInt('BENCH_CRTT_DURATION_SECONDS', 3);
const CRTT_CHUNK_COUNT = CRTT_CHUNK_RATE_PER_SEC * CRTT_DURATION_SECONDS;
const CRTT_INTERVAL_MS = 1000 / CRTT_CHUNK_RATE_PER_SEC;

// Replay workload: REAL captured cadences (provenance in
// 97_bench_cadence.ts) — every write instant and chunk size comes from a
// capture, one per boundary (eve = demanding envelope protocol, gateway =
// typical raw SSE). The speed multiplier is the only chosen parameter; 2x
// matches how real fast-tier models behave (same chunk sizes, compressed
// time) and exceeds every fast tier measured.
const REPLAY_SPEED = envInt('BENCH_REPLAY_SPEED', 2);
const REPLAY_CADENCE_EVE = 'eve-gpt-5.6-sol-2000t'; // 2593 ev / 52.4s / 16.4MiB
const REPLAY_CADENCE_GATEWAY = 'gateway-gpt-5.4-nano-2000t'; // 1765 ev / 19.9s / 322KiB
// Eve replays cost ~26s (2x) / ~52s (1x) wall per iteration — few
// iterations there, more on the cheap gateway row. 1x = reality (not
// implied by a strained 2x row, and the more linear regression detector);
// 2x = headroom.
/**
 * Cross-system cadence identity: durabench carries its own copy of each
 * capture, so both sides hash canonical event tuples (format-independent).
 * CANONICAL FORM (keep in sync with durabench): sha256 over UTF-8
 * "v1\n" + "<offsetMs>,<bytes>\n" per event, base-10, LF separators.
 */
function cadenceSemanticSha256(cadenceId: string): string {
  const cadence = BENCH_CADENCES[cadenceId];
  const hash = createHash('sha256');
  hash.update('v1\n');
  for (let i = 0; i < cadence.offsetsMs.length; i++) {
    hash.update(`${cadence.offsetsMs[i]},${cadence.sizes[i]}\n`);
  }
  return hash.digest('hex');
}

const REPLAY_EVE_ITERATIONS = envInt('BENCH_REPLAY_EVE_ITERATIONS', 3);
const REPLAY_REALITY_ITERATIONS = envInt('BENCH_REPLAY_REALITY_ITERATIONS', 2);
const REPLAY_GATEWAY_ITERATIONS = envInt('BENCH_REPLAY_GATEWAY_ITERATIONS', 3);

// Guard timeouts so a single stuck run fails fast instead of eating the job.
const RUN_TIMEOUT_MS = envInt('BENCH_RUN_TIMEOUT_MS', 120_000);
// Extra guard time granted per step for the multi-step scenarios (sequential and
// fan-out), on top of RUN_TIMEOUT_MS. Deliberately loose: it exists to kill a
// stuck run, not to assert a per-step budget.
const PER_STEP_TIMEOUT_ALLOWANCE_MS = 2_000;
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
  /** 'queue-hop' if this was the first step body executed in its process
   * (cold start or a fresh dispatch after the prior invocation ended);
   * 'inline' for later steps in the same warm process. Set by the workflow
   * itself (see workflows/97_bench.ts) — ground truth, not inferred. */
  kind: 'inline' | 'queue-hop';
}

interface StreamIterationResult {
  runId: string;
  /** `steps[0].start - clientStart`, both deployment-side clocks. */
  ttfsMs: number;
}

interface SequentialIterationResult {
  runId: string;
  /** Datadog trace id for the `/api/bench` request that started this run, when
   * the deployment's route reports one (older deployments won't). */
  traceId?: string;
  /** STSO gaps preceding an 'inline' step (same warm process as the step
   * before it) — the framework's pure step-to-step overhead. */
  stsoInlineMs: number[];
  /** STSO gaps preceding a 'queue-hop' step (first step of a fresh process:
   * cold start or a redispatch via the queue after the prior invocation's
   * duration limit) — dispatch + reinit overhead, not step-body cost. */
  stsoQueueHopMs: number[];
  /** Whole-run workflow overhead, anchored on the in-deployment clientStart. */
  woMs: number;
}

interface FanOutIterationResult {
  runId: string;
  /** Datadog trace id for the `/api/bench` request that started this run, when
   * the deployment's route reports one. */
  traceId?: string;
  /** `min(step.end) - clientStart`: the first of the parallel steps to finish. */
  fanOutTtfsMs: number;
  /** `max(step.end) - clientStart`: the last of them, i.e. when the whole
   * `Promise.all` is joinable. */
  fanOutTtlsMs: number;
}

/** Mirrors BenchChunkRttResult in workflows/97_bench.ts: per-bucket RTT
 * summaries aggregated inside the reader step (buckets without samples are
 * absent). */
interface BenchChunkRttResult {
  received: number;
  all?: BenchRttSummary;
  byIndex: Partial<Record<string, BenchRttSummary>>;
  progress?: BenchRttMeanProfile;
  size?: BenchRttMeanProfile;
  cdv?: BenchChunkCdv;
  delivered?: BenchSteadyRate;
}

/** Mirrors BenchChunkCdv in workflows/97_bench.ts. */
interface BenchChunkCdv {
  pairs: number;
  skippedPairs: number;
  positive?: BenchDelayTail;
  progress?: BenchRttMeanProfile;
}

interface CrttIterationResult {
  runId: string;
  crtt: BenchChunkRttResult;
  /** Writer-side pacing slip for the run (artifact-only guard). */
  writeSlip?: BenchDelayTail;
  /** Writer-side achieved sustained rate over the steady window. */
  achieved?: BenchSteadyRate;
}

/** Response shape of the in-deployment `POST /api/bench` trigger route. */
interface BenchTriggerResponse {
  runId: string;
  /** Date.now() stamped in the route immediately before start(). */
  clientStart: number;
  /** Datadog trace id for this request, when the route reports one. */
  traceId?: string;
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
  return {
    runId: data.runId,
    clientStart: data.clientStart,
    // Optional: a deployment built before the route reported it simply logs
    // the run id without a trace link.
    traceId: typeof data.traceId === 'string' ? data.traceId : undefined,
  };
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
  const { runId, clientStart, traceId } = await triggerBenchRun(
    'benchSequentialStepsWorkflow',
    [stepCount]
  );
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS + stepCount * PER_STEP_TIMEOUT_ALLOWANCE_MS,
      `benchSequentialStepsWorkflow returnValue (run ${runId})`
    );
    const steps = timingsFromReturnValue(returnValue, runId);
    if (steps.length !== stepCount) {
      throw new Error(
        `Run ${runId} returned ${steps.length} step timings, expected ${stepCount}`
      );
    }

    const stsoInlineMs: number[] = [];
    const stsoQueueHopMs: number[] = [];
    for (let i = 1; i < steps.length; i++) {
      const gap = steps[i].start - steps[i - 1].end;
      (steps[i].kind === 'queue-hop' ? stsoQueueHopMs : stsoInlineMs).push(gap);
    }

    return {
      runId,
      traceId,
      stsoInlineMs,
      stsoQueueHopMs,
      woMs: workflowOverheadMs(clientStart, steps),
    };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runFanOutIteration(
  stepCount: number
): Promise<FanOutIterationResult> {
  const { runId, clientStart, traceId } = await triggerBenchRun(
    'benchFanOutStepsWorkflow',
    [stepCount]
  );
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS + stepCount * PER_STEP_TIMEOUT_ALLOWANCE_MS,
      `benchFanOutStepsWorkflow returnValue (run ${runId})`
    );
    const steps = timingsFromReturnValue(returnValue, runId);
    if (steps.length !== stepCount) {
      throw new Error(
        `Run ${runId} returned ${steps.length} step timings, expected ${stepCount}`
      );
    }
    // Both ends of the fan-out come off step-body exit timestamps, so a run
    // whose first branch lands early but whose tail drags reports two different
    // numbers rather than one blended average. Reduced rather than spread into
    // Math.min/max: the step count is env-tunable, and a large fan-out would
    // overflow the argument limit.
    let firstEnd = Number.POSITIVE_INFINITY;
    let lastEnd = Number.NEGATIVE_INFINITY;
    for (const { end } of steps) {
      if (end < firstEnd) firstEnd = end;
      if (end > lastEnd) lastEnd = end;
    }
    return {
      runId,
      traceId,
      // Deployment-side clocks on both sides; clamp to absorb tiny skew.
      fanOutTtfsMs: Math.max(0, firstEnd - clientStart),
      fanOutTtlsMs: Math.max(0, lastEnd - clientStart),
    };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runCrttIteration(
  variant: 'llm' | 'sweep',
  chunkCount: number,
  intervalMs: number
): Promise<CrttIterationResult> {
  const { runId } = await triggerBenchRun('benchCrttWorkflow', [
    chunkCount,
    intervalMs,
    variant,
  ]);
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      // The writer streams for the whole generation window before the run can
      // complete, so extend the guard past the base run timeout by that window.
      RUN_TIMEOUT_MS + chunkCount * intervalMs,
      `benchCrttWorkflow (${variant}) returnValue (run ${runId})`
    );
    const { crtt, writeSlip, achieved } =
      (returnValue as
        | {
            crtt?: BenchChunkRttResult;
            writeSlip?: BenchDelayTail;
            achieved?: BenchSteadyRate;
          }
        | undefined) ?? {};
    if (!crtt || !crtt.all || typeof crtt.all.avg !== 'number') {
      throw new Error(
        `Run ${runId} returned no chunk-RTT summaries: ${JSON.stringify(returnValue)?.slice(0, 200)}`
      );
    }
    if (crtt.received !== chunkCount) {
      throw new Error(
        `Run ${runId} consumed ${crtt.received} chunks, expected ${chunkCount}`
      );
    }
    return { runId, crtt, writeSlip, achieved };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

async function runReplayIteration(
  cadenceId: string,
  speed: number
): Promise<CrttIterationResult> {
  const cadence = BENCH_CADENCES[cadenceId];
  const { runId } = await triggerBenchRun('benchReplayWorkflow', [
    cadenceId,
    speed,
  ]);
  try {
    const returnValue = await withTimeout(
      getReturnValue(runId),
      RUN_TIMEOUT_MS + cadence.spanMs / speed,
      `benchReplayWorkflow (${cadenceId} ${speed}x) returnValue (run ${runId})`
    );
    const { crtt, writeSlip, achieved } =
      (returnValue as
        | {
            crtt?: BenchChunkRttResult;
            writeSlip?: BenchDelayTail;
            achieved?: BenchSteadyRate;
          }
        | undefined) ?? {};
    if (!crtt || !crtt.all || typeof crtt.all.avg !== 'number') {
      throw new Error(
        `Run ${runId} returned no chunk-RTT summaries: ${JSON.stringify(returnValue)?.slice(0, 200)}`
      );
    }
    if (crtt.received !== cadence.events) {
      throw new Error(
        `Run ${runId} consumed ${crtt.received} chunks, expected ${cadence.events}`
      );
    }
    return { runId, crtt, writeSlip, achieved };
  } catch (error) {
    (error as Error).message += ` (run ${runId})`;
    throw error;
  }
}

/**
 * Median across per-iteration values (undefined skipped); even counts
 * average the two middles — lower-middle would report the better of a
 * 2-run scenario's runs and call it the median.
 */
function medianOf(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => typeof v === 'number');
  if (present.length === 0) return undefined;
  const sorted = [...present].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Records the write-slip detail row for a stream variant (artifact-only,
 * never rendered). The sample unit is each run's MAX slip: one producer
 * stall among thousands of chunks vanishes into a pooled p99 but is, by
 * construction, that run's max. Slip is the guard for producer stalls,
 * which neither per-chunk RTT (late writes are stamped late) nor CDV
 * (writer pauses grow both gaps equally) can see.
 */
function recordSlipDetailRow(
  scenario: string,
  group: string,
  tails: readonly (BenchDelayTail | undefined)[]
) {
  const samples = tails.flatMap((tail) => (tail ? [tail.maxMs] : []));
  if (samples.length === 0) return;
  metricRows.push({
    metric: 'slip',
    scenario,
    unit: 'ms',
    group,
    detail: true,
    ...computeStats(samples),
  });
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
  /** Median; only recorded for CRTT rows (the exit criteria track median and
   * average per-chunk RTT). Kept in the JSON, not shown in the PR comment. */
  p50?: number;
  p75: number;
  p90: number;
  p99: number;
  samples: number;
  /** Every sample (ms, ascending), not just the percentiles above: the PR
   * comment diffs the whole STSO distribution against `main`, and
   * percentiles alone hide *how many* samples moved and by how much. */
  raw: number[];
  /** Fixed-bin histogram of the samples, for rows whose raw samples never
   * reach this process (CRTT: aggregation happens in the reader step on the
   * deployment). Fixed shared edges make the PR comment's distribution diff
   * against `main` exact — the renderer only diffs matching-edge rows. */
  hist?: { edgesMs: number[]; counts: number[] };
  /** Drill-down rows (e.g. CRTT per-bucket splits): kept out of the PR
   * comment's main results table and rendered in a collapsed section. */
  detail?: boolean;
  /** Mean RTT per tenth of the stream (CRTT headline rows): the drift/trend
   * readout, rendered as a progress sparkline in the drill-down. Null
   * entries are empty bins (rendered as gaps, never as zero). */
  progressAvgMs?: (number | null)[];
  /** Mean RTT per log size bin (CRTT sweep headline row): the size→latency
   * curve, rendered as a size sparkline in the drill-down. Null entries are
   * bins the sweep left empty. */
  sizeAvgMs?: (number | null)[];
  /** Mean POSITIVE CDV per tenth of the stream (stream headline rows),
   * rendered as a delivery-jitter sparkline in the drill-down: localizes
   * where delivery clumping/stalls concentrate. Complements the stream
   * table's CDV max column, which says the worst stall's size but not
   * where. */
  cdvAvgMs?: (number | null)[];
  /** Stream-scenario columns (marks the row for the PR comment's separate
   * stream table): writer/reader sustained rates over the steady window and
   * the median worst delivery stall, medians across iterations with the
   * per-run values retained in `runs`. */
  stream?: {
    iterations: number;
    wrCps?: number;
    wrKiBps?: number;
    rdCps?: number;
    rdKiBps?: number;
    /** Median across runs of each run's seq-0 RTT — the stream-open path,
     * before any buffering/backpressure (the retired SL signal). */
    firstMs?: number;
    cdvMaxMs?: number;
    runs: {
      wrCps?: number;
      wrKiBps?: number;
      rdCps?: number;
      rdKiBps?: number;
      firstMs?: number;
      cdvMaxMs?: number;
      slipMaxMs?: number;
    }[];
  };
  /** Short group/bucket labels for drill-down rendering (CRTT: variant and
   * index/size bucket). */
  group?: string;
  bucket?: string;
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
    raw: sorted,
  };
}

interface MetricRow extends MetricStats {
  /** Short metric id: ttfs | fanout-ttfs | fanout-ttls | stso | wo | sl | so */
  metric: string;
  /** Short scenario label; explained via scenario descriptions in the output */
  scenario: string;
  unit: 'ms';
  /** Latency targets rendered as pass/fail marks in the PR comment */
  targets?: MetricTargets;
}

const metricRows: MetricRow[] = [];
// Per-run seq-0 RTTs from every stream scenario, pooled into the
// 'first chunk (pooled)' main-table row in afterAll.
const firstChunkRttSamples: number[] = [];

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
 * Records one CRTT row from per-iteration summaries. Unlike recordMetric
 * there are no raw samples in this process — the reader step aggregated them
 * on the deployment — so the row is the mergeRttSummaries merge: exact
 * count/best/avg/histogram, percentile-of-percentiles for p50-p99. `samples`
 * is the total chunk count across iterations. The merged fixed-bin histogram
 * rides along for the PR comment's sparkline drill-down (exact vs `main`,
 * where the percentiles are approximations). Rows with `detail` are not
 * rendered at all — they carry the per-index-bucket splits in the results
 * JSON (with baseline annotations) so a headline regression can be localized
 * from the artifacts. No targets yet (see the CRTT header note), so no 🔴
 * marks render.
 */
// Mean RTT per profile bin; sums/counts merge exactly across iterations,
// so these avgs are exact like the histogram. Empty bins become null so
// the renderer can show them as gaps rather than zeros.
function profileAvgs(profile?: BenchRttMeanProfile) {
  return profile?.totalMs.map((total, i) =>
    profile.counts[i] > 0
      ? Math.round((total / profile.counts[i]) * 10) / 10
      : null
  );
}

/** Records an artifact-only per-index-bucket CRTT row (never rendered). */
function recordCrttDetailRow(
  scenario: string,
  summaries: readonly (BenchRttSummary | undefined)[],
  { group, bucket }: { group: string; bucket: string }
) {
  const merged = mergeRttSummaries(summaries);
  if (!merged) return;
  metricRows.push({
    metric: 'crtt',
    scenario,
    unit: 'ms',
    best: merged.best,
    avg: merged.avg,
    p50: merged.p50,
    p75: merged.p75,
    p90: merged.p90,
    p99: merged.p99,
    samples: merged.count,
    raw: [],
    hist: { edgesMs: RTT_HIST_EDGES_MS, counts: merged.hist },
    detail: true,
    group,
    bucket,
  });
}

/**
 * Records one stream-scenario row (headline of the PR comment's STREAM
 * table). CRTT percentiles are percentile-of-percentiles across iterations
 * (count/best/avg/histograms are exact); rates, first-chunk RTT, and CDV
 * max are medians of per-run values, kept per-run in `stream.runs`.
 */
function recordStreamRow(
  scenario: string,
  group: string,
  results: readonly CrttIterationResult[],
  {
    size,
  }: {
    /** Include the size→latency profile (sweep variant only). */
    size?: boolean;
  } = {}
) {
  const merged = mergeRttSummaries(results.map((r) => r.crtt.all));
  if (!merged) return;
  for (const r of results) {
    const first = r.crtt.byIndex?.['seq 0']?.avg;
    if (typeof first === 'number') firstChunkRttSamples.push(first);
  }
  const runs = results.map((r) => ({
    wrCps: r.achieved?.chunksPerSec,
    wrKiBps: r.achieved?.kibPerSec,
    rdCps: r.crtt.delivered?.chunksPerSec,
    rdKiBps: r.crtt.delivered?.kibPerSec,
    // Single sample (the run's seq-0 chunk), so avg IS that run's value.
    firstMs: r.crtt.byIndex?.['seq 0']?.avg,
    cdvMaxMs: r.crtt.cdv?.positive?.maxMs,
    slipMaxMs: r.writeSlip?.maxMs,
  }));
  metricRows.push({
    metric: 'stream',
    scenario,
    unit: 'ms',
    best: merged.best,
    avg: merged.avg,
    p50: merged.p50,
    p75: merged.p75,
    p90: merged.p90,
    p99: merged.p99,
    samples: merged.count,
    raw: [],
    hist: { edgesMs: RTT_HIST_EDGES_MS, counts: merged.hist },
    group,
    bucket: 'all',
    // Nulls (empty bins) are preserved: the renderer draws them as gaps.
    // Mapping them to 0 would claim "measured no jitter/latency here"
    // rather than "no samples here" — CDV progress bins are legitimately
    // empty wherever a tenth of the stream had no positive-cdv chunks.
    progressAvgMs: profileAvgs(
      mergeMeanProfiles(results.map((r) => r.crtt.progress))
    ),
    sizeAvgMs: size
      ? profileAvgs(mergeMeanProfiles(results.map((r) => r.crtt.size)))
      : undefined,
    cdvAvgMs: profileAvgs(
      mergeMeanProfiles(results.map((r) => r.crtt.cdv?.progress))
    ),
    stream: {
      iterations: results.length,
      wrCps: medianOf(runs.map((r) => r.wrCps)),
      wrKiBps: medianOf(runs.map((r) => r.wrKiBps)),
      rdCps: medianOf(runs.map((r) => r.rdCps)),
      rdKiBps: medianOf(runs.map((r) => r.rdKiBps)),
      firstMs: medianOf(runs.map((r) => r.firstMs)),
      cdvMaxMs: medianOf(runs.map((r) => r.cdvMaxMs)),
      runs,
    },
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
const SCENARIO_FANOUT = `Promise.all(${FANOUT_STEP_COUNT} steps)`;
// Stream scenario labels, doubling as the stream-table rows' scenario keys;
// the per-bucket detail rows are keyed `paced control (<bucket>)` and slip
// detail rows `write slip (<variant>)`. All new baseline keys, so the
// stream deltas stay blank until `main` produces them.
// Synthetic rows are named for their role: the metronome is the control
// (diagnostic anchor + flush-cadence probe); the sweep isolates size
// causally (rotation decouples size from position; the replay ramp
// couples them).
const SCENARIO_PACED_CONTROL = 'paced control (100/s, 60B)';
const SCENARIO_SIZE_SWEEP = 'size sweep (100/s, 160B-12KB)';
// Capture id + speed IS the baseline key: a re-capture is a new workload
// and starts a new baseline by construction.
// Parenthesized speed, not `@2x`: GitHub renders @<word> as a user mention.
const SCENARIO_REPLAY_EVE = `replay ${REPLAY_CADENCE_EVE} (${REPLAY_SPEED}x)`;
const SCENARIO_REPLAY_REALITY = `replay ${REPLAY_CADENCE_EVE} (1x)`;
const SCENARIO_REPLAY_GATEWAY = `replay ${REPLAY_CADENCE_GATEWAY} (1x)`;
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
    name: SCENARIO_FANOUT,
    description: `${FANOUT_STEP_COUNT} trivial no-op steps started together in a single Promise.all; Fan-out TTFS is the first of them to complete and Fan-out TTLS the last, both from the in-deployment clientStart, so their gap is the spread the runtime adds across the fan-out`,
  },
  {
    name: SCENARIO_PACED_CONTROL,
    description: `the control: ${CRTT_CHUNK_COUNT} tiny (~60B) deltas metronome-paced at ${CRTT_CHUNK_RATE_PER_SEC}/s — zero workload structure, so it reads the transport floor and flush cadence, and disambiguates transport-wide vs workload-specific when a replay row moves`,
  },
  {
    name: SCENARIO_SIZE_SWEEP,
    description: `same pacing as the control with deltas padded in rotation across seven log-spaced sizes (~160B–12KB) — rotation decouples size from stream position, so it isolates whether chunk size causes latency`,
  },
  {
    name: SCENARIO_REPLAY_GATEWAY,
    description: `raw provider SSE cadence captured at the AI gateway boundary (gpt-5.4-nano, the most popular gateway model; per-token deltas p50 208B = the modal production chunk size), replayed exactly as measured — the typical customer's workload; its CDV is the typical customer's real delivery jitter`,
  },
  {
    name: SCENARIO_REPLAY_REALITY,
    description: `a captured eve turn (gpt-5.6-sol, the most-used demanding eve model; ~2000 output tokens = production p50 turn length) replayed exactly as measured — eve's envelope protocol re-ships the cumulative message so sizes ramp 142B→13KB; the demanding outlier tenant's reality`,
  },
  {
    name: SCENARIO_REPLAY_EVE,
    description: `the same eve capture at ${REPLAY_SPEED}x — the headroom/stress row; real fast-tier models emit the same chunk sizes at proportionally higher rate, so time compression is a faithful speed model`,
  },
  {
    name: 'first chunk (pooled)',
    description: `every run's seq-0 RTT pooled across all stream scenarios — the first chunk precedes any workload differentiation, so pooling samples one shared stream-open path with exact percentiles`,
  },
];
// Cross-system cadence identity: the full semantic hash lands in
// config.replayCadences (rendered as its own "Replay cadences" legend line
// and copyable from the artifacts); durabench computes the same hash over
// its copy (see cadenceSemanticSha256).

// Datadog APM permalink for a trace id. The benchmark deployment exports its
// OTel spans to Datadog, and `/api/bench` returns the trace id of the request
// that started each run.
const DATADOG_TRACE_URL = 'https://app.datadoghq.com/apm/trace/';

/**
 * Datadog APM search for the spans tagged with a given `workflow.run.id`.
 *
 * The permalink above opens the *trigger's* trace, which under the default
 * `WORKFLOW_TRACE_MODE=linked` holds only `workflow.start` plus span links out
 * to the per-invocation trace roots — an entry point to the run rather than the
 * run itself. This search lands straight on the execution spans, which is where
 * an STSO investigation actually goes, so both are logged.
 *
 * Depends on `workflow.run.id` being an indexed span tag in the Datadog org. If
 * it isn't, this returns an empty search and the trace permalink stays the way
 * in; neither link is load-bearing for the benchmark itself.
 */
function datadogRunSearchUrl(runId: string): string {
  const query = encodeURIComponent(`@workflow.run.id:${runId}`);
  return `https://app.datadoghq.com/apm/traces?query=${query}`;
}

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

  test('scenario: paced control', { timeout: 30 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_PACED_CONTROL,
      CRTT_ITERATIONS,
      () => runCrttIteration('llm', CRTT_CHUNK_COUNT, CRTT_INTERVAL_MS)
    );
    // One rendered row per stream scenario (in the separate stream table);
    // the index-bucket rows split RTT by position in the stream for the
    // results artifacts only (flat across runs so far), as do slip tails.
    recordStreamRow(SCENARIO_PACED_CONTROL, 'control', results);
    for (const bucket of RTT_INDEX_BUCKETS) {
      recordCrttDetailRow(
        `paced control (${bucket})`,
        results.map((r) => r.crtt.byIndex[bucket]),
        { group: 'control', bucket }
      );
    }
    recordSlipDetailRow(
      'write slip (paced control)',
      'control',
      results.map((r) => r.writeSlip)
    );
  });

  test('scenario: size sweep', { timeout: 30 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_SIZE_SWEEP,
      CRTT_ITERATIONS,
      () => runCrttIteration('sweep', CRTT_CHUNK_COUNT, CRTT_INTERVAL_MS)
    );
    // The size→latency profile only makes sense here: the llm-shaped
    // deltas all land in the smallest size bin.
    recordStreamRow(SCENARIO_SIZE_SWEEP, 'sweep', results, {
      size: true,
    });
    recordSlipDetailRow(
      'write slip (size sweep)',
      'sweep',
      results.map((r) => r.writeSlip)
    );
  });

  // The replay scenarios run (and therefore render) in ascending difficulty:
  // gateway 1x (typical customer as measured, the lightest total load) →
  // eve 1x (demanding workload as measured) → eve 2x (stress). The gateway
  // capture deliberately has no 2x row: nano at 1x already sits at the fast
  // end of measured gateway rates, and a first run showed gateway-2x tails
  // statistically identical to eve 2x — headroom is eve 2x's job.

  test(
    'scenario: replay (gateway gpt-5.4-nano 2000t, 1x reality)',
    { timeout: 30 * 60_000 },
    async () => {
      const results = await runScenario(
        SCENARIO_REPLAY_GATEWAY,
        REPLAY_GATEWAY_ITERATIONS,
        () => runReplayIteration(REPLAY_CADENCE_GATEWAY, 1),
        // ~20s wall per run; one warmup — earlier scenarios already warmed
        // the deployment and stream path.
        { warmupIterations: 1 }
      );
      recordStreamRow(SCENARIO_REPLAY_GATEWAY, 'gw 1x', results);
      recordSlipDetailRow(
        `write slip (${REPLAY_CADENCE_GATEWAY} 1x)`,
        'gw 1x',
        results.map((r) => r.writeSlip)
      );
    }
  );

  test(
    'scenario: replay (eve gpt-5.6-sol 2000t, 1x reality)',
    { timeout: 30 * 60_000 },
    async () => {
      const results = await runScenario(
        SCENARIO_REPLAY_REALITY,
        REPLAY_REALITY_ITERATIONS,
        () => runReplayIteration(REPLAY_CADENCE_EVE, 1),
        // ~52s wall per run; no warmup — the gateway 1x replay just ran, so
        // the replay path is warm.
        { warmupIterations: 0 }
      );
      recordStreamRow(SCENARIO_REPLAY_REALITY, 'eve 1x', results);
      recordSlipDetailRow(
        `write slip (${REPLAY_CADENCE_EVE} 1x)`,
        'eve 1x',
        results.map((r) => r.writeSlip)
      );
    }
  );

  test(
    'scenario: replay (eve gpt-5.6-sol 2000t, 2x)',
    { timeout: 30 * 60_000 },
    async () => {
      const results = await runScenario(
        SCENARIO_REPLAY_EVE,
        REPLAY_EVE_ITERATIONS,
        () => runReplayIteration(REPLAY_CADENCE_EVE, REPLAY_SPEED),
        // No warmup: the same cadence already replayed at 1x above, so
        // everything this touches is warm.
        { warmupIterations: 0 }
      );
      recordStreamRow(SCENARIO_REPLAY_EVE, 'eve 2x', results);
      recordSlipDetailRow(
        `write slip (${REPLAY_CADENCE_EVE} ${REPLAY_SPEED}x)`,
        'eve 2x',
        results.map((r) => r.writeSlip)
      );
    }
  );

  test('scenario: fan-out steps', { timeout: 60 * 60_000 }, async () => {
    const results = await runScenario(
      SCENARIO_FANOUT,
      FANOUT_ITERATIONS,
      () => runFanOutIteration(FANOUT_STEP_COUNT),
      {
        // No warmup: a warmup iteration costs a whole fan-out run, the earlier
        // scenarios already warmed the client and the world, and cold starts
        // are kept in these numbers on purpose (see the file header).
        warmupIterations: 0,
      }
    );
    // Same reason the sequential scenario logs its runs: when a percentile
    // moves, the investigation starts in APM, and the run ids behind these
    // samples are only available here.
    for (const { runId, traceId } of results) {
      console.log(
        `[bench] ${SCENARIO_FANOUT} run ${runId}` +
          (traceId ? ` — trace ${DATADOG_TRACE_URL}${traceId}` : '') +
          ` — spans ${datadogRunSearchUrl(runId)}`
      );
    }
    // No targets: fan-out latency under contention is a new population, and the
    // single-step TTFS targets describe a different shape of run.
    recordMetric(
      'fanout-ttfs',
      SCENARIO_FANOUT,
      results.map((r) => r.fanOutTtfsMs)
    );
    recordMetric(
      'fanout-ttls',
      SCENARIO_FANOUT,
      results.map((r) => r.fanOutTtlsMs)
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
    // Name the runs behind the STSO histograms in this job's own log, right
    // where they were produced. When a bucket looks wrong the investigation
    // starts in APM, and this saves the usual hunt by deployment id + time
    // window. Logged rather than rendered into the PR comment so it is also
    // there for a local `pnpm bench` and for a run whose comment step never
    // gets to execute.
    for (const { runId, traceId } of results) {
      console.log(
        `[bench] ${SCENARIO_SEQUENTIAL} run ${runId}` +
          (traceId ? ` — trace ${DATADOG_TRACE_URL}${traceId}` : '') +
          ` — spans ${datadogRunSearchUrl(runId)}`
      );
    }
    // Report STSO split by whether the step that ends the gap was 'inline'
    // (same warm process as the step before it — pure framework overhead) or
    // a 'queue-hop' (first step of a fresh process — dispatch + reinit cost).
    // Ground truth from the workflow itself (see workflows/97_bench.ts), not
    // inferred from step index or trace timestamps. No targets yet: the two
    // populations are new, and the old per-index-window targets described a
    // different (index-bucketed) grouping.
    recordMetric(
      'stso',
      `${SCENARIO_SEQUENTIAL} (inline)`,
      results.flatMap((r) => r.stsoInlineMs)
    );
    recordMetric(
      'stso',
      `${SCENARIO_SEQUENTIAL} (queue-hop)`,
      results.flatMap((r) => r.stsoQueueHopMs)
    );
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
    // Pooled first-chunk RTTs: seq 0 precedes any workload differentiation
    // (no queue depth / backpressure), so every scenario samples one shared
    // stream-open path — the one valid cross-scenario pool. ~TTFS-sized
    // sample set, exact percentiles (raw samples, no merge).
    if (firstChunkRttSamples.length > 0) {
      metricRows.push({
        metric: 'crtt',
        scenario: 'first chunk (pooled)',
        unit: 'ms',
        ...computeStats(firstChunkRttSamples),
      });
    }
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
        crttIterations: CRTT_ITERATIONS,
        crttChunkCount: CRTT_CHUNK_COUNT,
        crttChunkRatePerSec: CRTT_CHUNK_RATE_PER_SEC,
        crttDurationSeconds: CRTT_DURATION_SECONDS,
        replaySpeed: REPLAY_SPEED,
        replayEveIterations: REPLAY_EVE_ITERATIONS,
        replayRealityIterations: REPLAY_REALITY_ITERATIONS,
        replayGatewayIterations: REPLAY_GATEWAY_ITERATIONS,
        replayCadences: [REPLAY_CADENCE_EVE, REPLAY_CADENCE_GATEWAY].map(
          (id) => {
            const c = BENCH_CADENCES[id];
            return {
              id,
              model: c.model,
              capturedAt: c.capturedAt,
              eveCommit: c.eveCommit,
              events: c.events,
              spanMs: c.spanMs,
              totalBytes: c.totalBytes,
              semanticSha256: cadenceSemanticSha256(id),
            };
          }
        ),
        sequentialIterations: SEQUENTIAL_ITERATIONS,
        sequentialStepCount: SEQUENTIAL_STEP_COUNT,
        fanoutIterations: FANOUT_ITERATIONS,
        fanoutStepCount: FANOUT_STEP_COUNT,
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
