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

type Outcome =
  | 'completed'
  | 'CORRUPTED_EVENT_LOG'
  | 'USER_ERROR'
  | 'RUNTIME_ERROR'
  | 'stuck'
  | 'other';

interface ReproConfig {
  attempts: number;
  concurrency: number;
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
}

interface ReproRunResult {
  attempt: number;
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
  attempts: envNumber('EVENT_LOG_RACE_REPRO_ATTEMPTS', 60),
  concurrency: envNumber('EVENT_LOG_RACE_REPRO_CONCURRENCY', 12),
  iterations: envNumber('EVENT_LOG_RACE_REPRO_ITERATIONS', 3),
  sleepMs: envNumber('EVENT_LOG_RACE_REPRO_SLEEP_MS', 5000),
  resumeDelayMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_DELAY_MS', 5000),
  resumeJitterMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_JITTER_MS', 5000),
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
};

async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  const run = await rawStart<T>(...args);
  trackRun(run, {
    testName: 'event-log-race-repro',
    workflowFile: 'workflows/101_hook_sleep_repro.ts',
    workflowFn: 'hookSleepReproWorkflow',
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

async function pollTerminalRun(
  run: Run<unknown>,
  startedAt: number
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
        token: '',
        runId: run.runId,
        outcome: 'other',
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

async function runAttempt(attempt: number): Promise<ReproRunResult> {
  const startedAt = Date.now();
  const token = `event-log-race-${Date.now()}-${attempt}-${Math.random()
    .toString(36)
    .slice(2)}`;

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      'workflows/101_hook_sleep_repro.ts',
      'hookSleepReproWorkflow'
    );
    const run = await start(workflow, [
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

    const runResult = await pollTerminalRun(run, startedAt);
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
          token,
          outcome: 'other',
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
          token,
          outcome: 'other',
          errorCode: 'NO_WAKE_BRANCH',
          errorMessage: 'Run completed without taking the hook wake branch.',
        };
      }
    }

    return {
      ...runResult,
      attempt,
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
      token,
      outcome: 'other',
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
    }
  );
}

function writeResults(results: ReproRunResult[]) {
  fs.writeFileSync(
    RESULT_PATH,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        deploymentUrl,
        config,
        distribution: summarize(results),
        results,
      },
      null,
      2
    )
  );
}

const testTimeoutMs =
  config.runTimeoutMs * Math.ceil(config.attempts / config.concurrency) +
  60_000;

describe('event log race repro', () => {
  beforeAll(() => {
    setupWorld(deploymentUrl);
  });

  test(
    'hook/sleep race does not corrupt or stall runs',
    { timeout: testTimeoutMs },
    async () => {
      const attempts = Array.from(
        { length: config.attempts },
        (_, index) => index + 1
      );
      const results = await mapLimit(attempts, config.concurrency, runAttempt);
      writeResults(results);

      const nonCompleted = results.filter(
        (result) => result.outcome !== 'completed'
      );
      expect(nonCompleted).toEqual([]);
    }
  );
});
