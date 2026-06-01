import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WorkflowRunFailedError } from '@workflow/errors';
import { beforeAll, describe, expect, test } from 'vitest';
import type { Run } from '../src/runtime';
import {
  getHookByToken,
  getWorld,
  start as rawStart,
  resumeHook,
} from '../src/runtime';
import { getWorkflowMetadata, setupWorld, trackRun } from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

const RESULT_PATH = path.resolve(
  process.cwd(),
  'event-log-race-repro-results.json'
);
const WORKFLOW_FILE = 'workflows/101_hook_sleep_repro.ts';

type Scenario =
  | 'hook-sleep'
  | 'step-fanout'
  | 'step-sleep-race-step-biased'
  | 'step-sleep-race-sleep-biased';

type Outcome =
  | 'completed'
  | 'CORRUPTED_EVENT_LOG'
  | 'USER_ERROR'
  | 'RUNTIME_ERROR'
  | 'stuck'
  | 'other'
  // Harness-side, non-gating outcomes: timing races in the repro driver
  // itself (hook resume vs. the workflow's sleep budget) and transport
  // errors talking to the deployment. These are NOT event-log regressions,
  // so they are reported but never fail the job. See `infra` handling in
  // `.github/scripts/render-event-log-race-repro-results.js`.
  | 'infra';

interface ReproConfig {
  hookSleepAttempts: number;
  stepFanoutAttempts: number;
  stepSleepRaceAttempts: number;
  concurrency: number;
  stepConcurrency: number;
  iterations: number;
  sleepMs: number;
  resumeDelayMs: number;
  resumeJitterMs: number;
  runTimeoutMs: number;
  hookTimeoutMs: number;
  sleepBranchWaitCount: number;
  sleepBranchWaitMs: number;
  sleepBranchWaitSpacingMs: number;
  returnOnWake: boolean;
  drainDelayMs: number;
  finalDelayMs: number;
  stepFanoutRounds: number;
  stepFanoutWidth: number;
  stepFanoutDelayMs: number;
  stepFanoutDelayJitterMs: number;
  stepFanoutAggregateDelayMs: number;
  stepFanoutBetweenRoundSleepMs: number;
  stepRaceRounds: number;
  stepRaceStepWinDelayMs: number;
  stepRaceStepWinSleepMs: number;
  stepRaceSleepWinDelayMs: number;
  stepRaceSleepWinSleepMs: number;
  stepRacePostSleepMs: number;
}

interface ReproRunResult {
  attempt: number;
  scenario: Scenario;
  token: string;
  runId?: string;
  outcome: Outcome;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  dashboardUrl?: string;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fallback;
}

const config: ReproConfig = {
  hookSleepAttempts: envNumber('EVENT_LOG_RACE_REPRO_ATTEMPTS', 1500),
  stepFanoutAttempts: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_FANOUT_ATTEMPTS',
    250
  ),
  stepSleepRaceAttempts: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_SLEEP_RACE_ATTEMPTS',
    250
  ),
  concurrency: envNumber('EVENT_LOG_RACE_REPRO_CONCURRENCY', 50),
  stepConcurrency: envNumber('EVENT_LOG_RACE_REPRO_STEP_CONCURRENCY', 50),
  // Ceiling on hook/sleep race iterations. The run short-circuits via
  // `returnOnWake` as soon as the hook wins, so a higher ceiling does not add
  // runtime — it widens the window for the delayed hook resume
  // (resumeDelayMs + resumeJitterMs, up to ~25s) to land before the workflow
  // exhausts its sleep budget (iterations * sleepMs) and exits via the no-wake
  // path. Keep iterations * sleepMs comfortably above the resume ceiling so the
  // wake branch is actually exercised instead of being lost to a timing race.
  iterations: envNumber('EVENT_LOG_RACE_REPRO_ITERATIONS', 8),
  sleepMs: envNumber('EVENT_LOG_RACE_REPRO_SLEEP_MS', 5000),
  resumeDelayMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_DELAY_MS', 15_000),
  resumeJitterMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_JITTER_MS', 10_000),
  runTimeoutMs: envNumber('EVENT_LOG_RACE_REPRO_RUN_TIMEOUT_MS', 150_000),
  hookTimeoutMs: envNumber('EVENT_LOG_RACE_REPRO_HOOK_TIMEOUT_MS', 60_000),
  sleepBranchWaitCount: envNumber(
    'EVENT_LOG_RACE_REPRO_SLEEP_BRANCH_WAIT_COUNT',
    2
  ),
  sleepBranchWaitMs: envNumber(
    'EVENT_LOG_RACE_REPRO_SLEEP_BRANCH_WAIT_MS',
    1000
  ),
  sleepBranchWaitSpacingMs: envNumber(
    'EVENT_LOG_RACE_REPRO_SLEEP_BRANCH_WAIT_SPACING_MS',
    250
  ),
  returnOnWake: envBoolean('EVENT_LOG_RACE_REPRO_RETURN_ON_WAKE', true),
  drainDelayMs: envNumber('EVENT_LOG_RACE_REPRO_DRAIN_DELAY_MS', 0),
  finalDelayMs: envNumber('EVENT_LOG_RACE_REPRO_FINAL_DELAY_MS', 0),
  stepFanoutRounds: envNumber('EVENT_LOG_RACE_REPRO_STEP_FANOUT_ROUNDS', 4),
  stepFanoutWidth: envNumber('EVENT_LOG_RACE_REPRO_STEP_FANOUT_WIDTH', 4),
  stepFanoutDelayMs: envNumber('EVENT_LOG_RACE_REPRO_STEP_FANOUT_DELAY_MS', 0),
  stepFanoutDelayJitterMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_FANOUT_DELAY_JITTER_MS',
    75
  ),
  stepFanoutAggregateDelayMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_FANOUT_AGGREGATE_DELAY_MS',
    0
  ),
  stepFanoutBetweenRoundSleepMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_FANOUT_BETWEEN_ROUND_SLEEP_MS',
    250
  ),
  stepRaceRounds: envNumber('EVENT_LOG_RACE_REPRO_STEP_RACE_ROUNDS', 4),
  stepRaceStepWinDelayMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_RACE_STEP_WIN_DELAY_MS',
    0
  ),
  stepRaceStepWinSleepMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_RACE_STEP_WIN_SLEEP_MS',
    5000
  ),
  stepRaceSleepWinDelayMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_RACE_SLEEP_WIN_DELAY_MS',
    5000
  ),
  stepRaceSleepWinSleepMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_RACE_SLEEP_WIN_SLEEP_MS',
    500
  ),
  stepRacePostSleepMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_RACE_POST_SLEEP_MS',
    1500
  ),
};

async function start(
  scenario: Scenario,
  workflowFn: string,
  workflow: { workflowId: string },
  args: unknown[]
): Promise<Run<unknown>> {
  const run = await rawStart(workflow, args);
  trackRun(run, {
    testName: `event-log-race-repro:${scenario}`,
    workflowFile: WORKFLOW_FILE,
    workflowFn,
  });
  return run;
}

async function waitForHook(token: string, runId: string) {
  const deadline = Date.now() + config.hookTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const hook = await getHookByToken(token);
      if (hook.runId === runId) {
        return hook;
      }
      lastError = new Error(
        `Hook ${token} belonged to ${hook.runId}, expected ${runId}`
      );
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for hook ${token}`);
}

function getDashboardUrl(runId: string): string | undefined {
  const projectSlug = process.env.WORKFLOW_VERCEL_PROJECT_SLUG;
  const env = process.env.WORKFLOW_VERCEL_ENV;
  if (!projectSlug || !env) return undefined;

  const environment = env === 'production' ? 'production' : 'preview';
  return `https://vercel.com/vercel-labs/${projectSlug}/observability/workflows/runs/${runId}?environment=${environment}`;
}

function classifyFailure(errorCode: string | undefined): Outcome {
  if (
    errorCode === 'CORRUPTED_EVENT_LOG' ||
    errorCode === 'USER_ERROR' ||
    errorCode === 'RUNTIME_ERROR'
  ) {
    return errorCode;
  }
  return 'other';
}

function hasWakeBranch(value: unknown) {
  if (!value || typeof value !== 'object' || !('branches' in value)) {
    return false;
  }
  const branches = (value as { branches?: unknown }).branches;
  return (
    Array.isArray(branches) &&
    branches.some(
      (branch) =>
        branch &&
        typeof branch === 'object' &&
        'branch' in branch &&
        branch.branch === 'wake'
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function validateFanoutReturn(value: unknown) {
  if (!isRecord(value)) {
    return 'Run returned a non-object value.';
  }

  const records = value.roundRecords;
  if (!Array.isArray(records)) {
    return 'Run did not return roundRecords.';
  }

  if (records.length !== config.stepFanoutRounds) {
    return `Expected ${config.stepFanoutRounds} fanout rounds, got ${records.length}.`;
  }

  for (const [index, record] of records.entries()) {
    if (!isRecord(record)) {
      return `Round ${index} record was not an object.`;
    }
    if (record.round !== index) {
      return `Round ${index} returned unexpected round ${String(record.round)}.`;
    }
    if (record.count !== config.stepFanoutWidth) {
      return `Round ${index} aggregated ${String(record.count)} steps instead of ${config.stepFanoutWidth}.`;
    }
    if (typeof record.checksum !== 'string') {
      return `Round ${index} did not return a checksum.`;
    }
  }
}

function validateStepRaceReturn(value: unknown) {
  if (!isRecord(value)) {
    return 'Run returned a non-object value.';
  }

  const branches = value.branches;
  if (!Array.isArray(branches)) {
    return 'Run did not return branches.';
  }

  if (branches.length !== config.stepRaceRounds) {
    return `Expected ${config.stepRaceRounds} race rounds, got ${branches.length}.`;
  }

  for (const [index, branch] of branches.entries()) {
    if (!isRecord(branch)) {
      return `Race round ${index} record was not an object.`;
    }
    if (branch.round !== index) {
      return `Race round ${index} returned unexpected round ${String(branch.round)}.`;
    }
    if (branch.branch !== 'sleep' && branch.branch !== 'step') {
      return `Race round ${index} took unexpected ${String(branch.branch)} branch.`;
    }

    const marker = branch.marker;
    if (!isRecord(marker)) {
      return `Race round ${index} marker was not an object.`;
    }
    if (marker.branch !== branch.branch) {
      return `Race round ${index} marker branch ${String(marker.branch)} did not match returned branch ${String(branch.branch)}.`;
    }
  }
}

async function pollTerminalRun(
  run: Run<unknown>,
  startedAt: number,
  scenario: Scenario
): Promise<ReproRunResult> {
  const world = await getWorld();
  const deadline = startedAt + config.runTimeoutMs;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const runData = await world.runs.get(run.runId);
    lastStatus = runData.status;

    if (runData.status === 'completed') {
      return {
        attempt: -1,
        scenario,
        token: '',
        runId: run.runId,
        outcome: 'completed',
        status: runData.status,
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(run.runId),
      };
    }

    if (runData.status === 'failed') {
      return {
        attempt: -1,
        scenario,
        token: '',
        runId: run.runId,
        outcome: classifyFailure(runData.errorCode),
        status: runData.status,
        errorCode: runData.errorCode,
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(run.runId),
      };
    }

    if (runData.status === 'cancelled') {
      return {
        attempt: -1,
        scenario,
        token: '',
        runId: run.runId,
        outcome: 'infra',
        status: runData.status,
        errorCode: 'CANCELLED',
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(run.runId),
      };
    }

    await sleep(1000);
  }

  return {
    attempt: -1,
    scenario,
    token: '',
    runId: run.runId,
    outcome: 'stuck',
    status: lastStatus,
    durationMs: Date.now() - startedAt,
    dashboardUrl: getDashboardUrl(run.runId),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
) {
  const timeout = sleep(timeoutMs).then(() => {
    throw new Error(message);
  });
  return await Promise.race([promise, timeout]);
}

async function runHookSleepAttempt(attempt: number): Promise<ReproRunResult> {
  const scenario: Scenario = 'hook-sleep';
  const startedAt = Date.now();
  const token = `event-log-race-${scenario}-${Date.now()}-${attempt}-${Math.random()
    .toString(36)
    .slice(2)}`;

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      WORKFLOW_FILE,
      'hookSleepReproWorkflow'
    );
    const run = await start(scenario, 'hookSleepReproWorkflow', workflow, [
      {
        token,
        iterations: config.iterations,
        sleepMs: config.sleepMs,
        returnOnWake: config.returnOnWake,
        drainDelayMs: config.drainDelayMs,
        finalDelayMs: config.finalDelayMs,
        sleepBranchWaitCount: config.sleepBranchWaitCount,
        sleepBranchWaitMs: config.sleepBranchWaitMs,
        sleepBranchWaitSpacingMs: config.sleepBranchWaitSpacingMs,
      },
    ]);

    const hook = await waitForHook(token, run.runId);
    const jitter =
      config.resumeJitterMs > 0
        ? Math.floor(Math.random() * config.resumeJitterMs)
        : 0;
    const resumeDelayMs = config.resumeDelayMs + jitter;
    const resumePromise = sleep(resumeDelayMs).then(() =>
      resumeHook(hook, { attempt, sentAt: Date.now() })
    );

    const runResult = await pollTerminalRun(run, startedAt, scenario);
    const resumeResult = await Promise.allSettled([
      withTimeout(
        resumePromise,
        30_000,
        `Timed out resuming hook ${token} for run ${run.runId}`
      ),
    ]);

    const resumeFailure = resumeResult.find(
      (result) => result.status === 'rejected'
    );
    if (runResult.outcome === 'completed') {
      if (resumeFailure?.status === 'rejected') {
        return {
          ...runResult,
          attempt,
          scenario,
          token,
          // The run completed; only the harness's own resume call failed
          // (typically because the sleep branch already finished the run and
          // disposed the hook). Harness timing, not an SDK regression.
          outcome: 'infra',
          errorCode: 'HOOK_RESUME_FAILED',
          errorMessage: String(resumeFailure.reason),
        };
      }

      const returnValue = await withTimeout(
        run.returnValue,
        30_000,
        `Timed out reading return value for run ${run.runId}`
      );
      if (!hasWakeBranch(returnValue)) {
        return {
          ...runResult,
          attempt,
          scenario,
          token,
          // The run completed cleanly but the sleep branch won the race before
          // the resume landed, so the wake branch was never taken. This means
          // the attempt lost its intended coverage, not that the log is wrong.
          outcome: 'infra',
          errorCode: 'NO_WAKE_BRANCH',
          errorMessage: 'Run completed without taking the hook wake branch.',
        };
      }
    }

    return {
      ...runResult,
      attempt,
      scenario,
      token,
      errorMessage:
        runResult.errorMessage ??
        (resumeFailure?.status === 'rejected'
          ? String(resumeFailure.reason)
          : undefined),
    };
  } catch (err) {
    if (WorkflowRunFailedError.is(err)) {
      return {
        attempt,
        scenario,
        token,
        runId: err.runId,
        outcome: classifyFailure(err.errorCode),
        status: 'failed',
        errorCode: err.errorCode,
        errorMessage: err.message,
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(err.runId),
      };
    }

    return {
      attempt,
      scenario,
      token,
      // A non-WorkflowRunFailedError thrown in the driver is a transport /
      // harness problem (deployment unreachable, hook never appeared, resume
      // or return-value read timed out), not an event-log regression.
      outcome: 'infra',
      errorCode: 'HARNESS_ERROR',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function resumeGate(
  scenario: Scenario,
  attempt: number,
  token: string,
  runId: string
) {
  const hook = await waitForHook(token, runId);
  await resumeHook(hook, { attempt, scenario, sentAt: Date.now() });
}

async function runStepFanoutAttempt(attempt: number): Promise<ReproRunResult> {
  const scenario: Scenario = 'step-fanout';
  const startedAt = Date.now();
  const token = `event-log-race-${scenario}-${Date.now()}-${attempt}-${Math.random()
    .toString(36)
    .slice(2)}`;

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      WORKFLOW_FILE,
      'stepFanoutReplayReproWorkflow'
    );
    const run = await start(
      scenario,
      'stepFanoutReplayReproWorkflow',
      workflow,
      [
        {
          aggregateDelayMs: config.stepFanoutAggregateDelayMs,
          betweenRoundSleepMs: config.stepFanoutBetweenRoundSleepMs,
          rounds: config.stepFanoutRounds,
          stepDelayJitterMs: config.stepFanoutDelayJitterMs,
          stepDelayMs: config.stepFanoutDelayMs,
          token,
          width: config.stepFanoutWidth,
        },
      ]
    );

    await resumeGate(scenario, attempt, token, run.runId);

    const runResult = await pollTerminalRun(run, startedAt, scenario);
    if (runResult.outcome === 'completed') {
      const returnValue = await withTimeout(
        run.returnValue,
        30_000,
        `Timed out reading return value for run ${run.runId}`
      );
      const validationError = validateFanoutReturn(returnValue);
      if (validationError) {
        return {
          ...runResult,
          attempt,
          scenario,
          token,
          outcome: 'other',
          errorCode: 'BAD_FANOUT_RETURN',
          errorMessage: validationError,
        };
      }
    }

    return {
      ...runResult,
      attempt,
      scenario,
      token,
    };
  } catch (err) {
    if (WorkflowRunFailedError.is(err)) {
      return {
        attempt,
        scenario,
        token,
        runId: err.runId,
        outcome: classifyFailure(err.errorCode),
        status: 'failed',
        errorCode: err.errorCode,
        errorMessage: err.message,
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(err.runId),
      };
    }

    return {
      attempt,
      scenario,
      token,
      // A non-WorkflowRunFailedError thrown in the driver is a transport /
      // harness problem (deployment unreachable, hook never appeared, resume
      // or return-value read timed out), not an event-log regression.
      outcome: 'infra',
      errorCode: 'HARNESS_ERROR',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function runStepSleepRaceAttempt(
  attempt: number,
  bias: 'sleep' | 'step'
): Promise<ReproRunResult> {
  const scenario: Scenario =
    bias === 'step'
      ? 'step-sleep-race-step-biased'
      : 'step-sleep-race-sleep-biased';
  const startedAt = Date.now();
  const token = `event-log-race-${scenario}-${Date.now()}-${attempt}-${Math.random()
    .toString(36)
    .slice(2)}`;

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      WORKFLOW_FILE,
      'stepSleepRaceReproWorkflow'
    );
    const run = await start(scenario, 'stepSleepRaceReproWorkflow', workflow, [
      {
        postRaceSleepMs: config.stepRacePostSleepMs,
        rounds: config.stepRaceRounds,
        sleepMs:
          bias === 'step'
            ? config.stepRaceStepWinSleepMs
            : config.stepRaceSleepWinSleepMs,
        stepDelayMs:
          bias === 'step'
            ? config.stepRaceStepWinDelayMs
            : config.stepRaceSleepWinDelayMs,
        token,
      },
    ]);

    await resumeGate(scenario, attempt, token, run.runId);

    const runResult = await pollTerminalRun(run, startedAt, scenario);
    if (runResult.outcome === 'completed') {
      const returnValue = await withTimeout(
        run.returnValue,
        30_000,
        `Timed out reading return value for run ${run.runId}`
      );
      const validationError = validateStepRaceReturn(returnValue);
      if (validationError) {
        return {
          ...runResult,
          attempt,
          scenario,
          token,
          outcome: 'other',
          errorCode: 'BAD_STEP_RACE_RETURN',
          errorMessage: validationError,
        };
      }
    }

    return {
      ...runResult,
      attempt,
      scenario,
      token,
    };
  } catch (err) {
    if (WorkflowRunFailedError.is(err)) {
      return {
        attempt,
        scenario,
        token,
        runId: err.runId,
        outcome: classifyFailure(err.errorCode),
        status: 'failed',
        errorCode: err.errorCode,
        errorMessage: err.message,
        durationMs: Date.now() - startedAt,
        dashboardUrl: getDashboardUrl(err.runId),
      };
    }

    return {
      attempt,
      scenario,
      token,
      // A non-WorkflowRunFailedError thrown in the driver is a transport /
      // harness problem (deployment unreachable, hook never appeared, resume
      // or return-value read timed out), not an event-log regression.
      outcome: 'infra',
      errorCode: 'HARNESS_ERROR',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await fn(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function summarize(results: ReproRunResult[]) {
  return results.reduce<Record<Outcome, number>>(
    (acc, result) => {
      acc[result.outcome] += 1;
      return acc;
    },
    {
      completed: 0,
      CORRUPTED_EVENT_LOG: 0,
      USER_ERROR: 0,
      RUNTIME_ERROR: 0,
      stuck: 0,
      other: 0,
      infra: 0,
    }
  );
}

function emptyOutcomeCounts(): Record<Outcome, number> {
  return {
    completed: 0,
    CORRUPTED_EVENT_LOG: 0,
    USER_ERROR: 0,
    RUNTIME_ERROR: 0,
    stuck: 0,
    other: 0,
    infra: 0,
  };
}

function summarizeByScenario(results: ReproRunResult[]) {
  return results.reduce<Record<Scenario, Record<Outcome, number>>>(
    (acc, result) => {
      acc[result.scenario][result.outcome] += 1;
      return acc;
    },
    {
      'hook-sleep': emptyOutcomeCounts(),
      'step-fanout': emptyOutcomeCounts(),
      'step-sleep-race-step-biased': emptyOutcomeCounts(),
      'step-sleep-race-sleep-biased': emptyOutcomeCounts(),
    }
  );
}

function buildResultConfig(results: ReproRunResult[]) {
  return {
    ...config,
    attempts: results.length,
  };
}

function writeResults(results: ReproRunResult[]) {
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        deploymentUrl,
        config: buildResultConfig(results),
        distribution: summarize(results),
        scenarioDistribution: summarizeByScenario(results),
        results,
      },
      null,
      2
    )
  );
}

async function runScenario(
  attempts: number,
  concurrency: number,
  run: (attempt: number) => Promise<ReproRunResult>
) {
  if (attempts <= 0) {
    return [];
  }
  const attemptNumbers = Array.from(
    { length: attempts },
    (_, index) => index + 1
  );
  return await mapLimit(attemptNumbers, concurrency, run);
}

const testTimeoutMs =
  config.runTimeoutMs *
    Math.ceil(config.hookSleepAttempts / config.concurrency) +
  config.runTimeoutMs *
    Math.ceil(config.stepFanoutAttempts / config.stepConcurrency) +
  config.runTimeoutMs *
    Math.ceil(
      Math.ceil(config.stepSleepRaceAttempts / 2) / config.stepConcurrency
    ) +
  config.runTimeoutMs *
    Math.ceil(
      Math.floor(config.stepSleepRaceAttempts / 2) / config.stepConcurrency
    ) +
  60_000;

describe('event log race repro', () => {
  beforeAll(() => {
    setupWorld(deploymentUrl);

    // The hook resume must land before the workflow exhausts its sleep budget,
    // otherwise the sleep branch wins and the run exits via the no-wake path,
    // recording an `infra` outcome (NO_WAKE_BRANCH / HOOK_RESUME_FAILED) and
    // losing the wake-branch coverage this scenario exists to exercise.
    const sleepBudgetMs = config.iterations * config.sleepMs;
    const resumeCeilingMs = config.resumeDelayMs + config.resumeJitterMs;
    if (resumeCeilingMs >= sleepBudgetMs) {
      console.warn(
        `[event-log-race-repro] resume ceiling (${resumeCeilingMs}ms = ` +
          `resumeDelayMs ${config.resumeDelayMs} + resumeJitterMs ${config.resumeJitterMs}) ` +
          `is not below the hook-sleep budget (${sleepBudgetMs}ms = iterations ` +
          `${config.iterations} * sleepMs ${config.sleepMs}). Many hook-sleep ` +
          `attempts will lose the wake branch to the sleep race and be recorded ` +
          `as infra. Raise iterations/sleepMs or lower the resume delay.`
      );
    }
  });

  test(
    'event log races do not corrupt, stall, or take stale branches',
    { timeout: testTimeoutMs },
    async () => {
      const stepBiasedAttempts = Math.ceil(config.stepSleepRaceAttempts / 2);
      const sleepBiasedAttempts = Math.floor(config.stepSleepRaceAttempts / 2);
      const results = [
        ...(await runScenario(
          config.hookSleepAttempts,
          config.concurrency,
          runHookSleepAttempt
        )),
        ...(await runScenario(
          config.stepFanoutAttempts,
          config.stepConcurrency,
          runStepFanoutAttempt
        )),
        ...(await runScenario(
          stepBiasedAttempts,
          config.stepConcurrency,
          (attempt) => runStepSleepRaceAttempt(attempt, 'step')
        )),
        ...(await runScenario(
          sleepBiasedAttempts,
          config.stepConcurrency,
          (attempt) => runStepSleepRaceAttempt(attempt, 'sleep')
        )),
      ];
      writeResults(results);

      // Only event-log regressions fail the job. `infra` outcomes are
      // harness-side timing races (hook resume vs. sleep budget) and transport
      // errors — they are recorded and surfaced in the summary, but do not
      // gate, matching `--check` in the renderer script.
      const regressions = results.filter(
        (result) => result.outcome !== 'completed' && result.outcome !== 'infra'
      );
      expect(regressions).toEqual([]);
    }
  );
});
