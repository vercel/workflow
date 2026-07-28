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

/**
 * Deliberate reproduction harness for `CORRUPTED_EVENT_LOG`.
 *
 * A corrupted event log needs three things at once: several invocations
 * replaying one run concurrently, at least one write derived from an event load
 * that is missing a committed event, and control flow whose *step count* depends
 * on the missing event. The last one is the amplifier — correlation IDs are
 * positional ordinals of one seeded sequence, so a replay that emits a different
 * number of steps renames every entity after that point and the divergence
 * becomes unrecoverable rather than a benign retry.
 *
 * The `step-storm` and `hook-storm` scenarios supply all three by construction
 * (see `workflows/103_event_log_corruption_repro.ts`). `hook-sleep` is retained
 * as a low-attempt calibration control: it is the shape that has historically
 * produced a nonzero — but very low, ~0.1% — corruption rate, so its rate is the
 * yardstick the storms are meant to beat.
 *
 * This job is a *measurement*, not a pass/fail gate on the SDK's happy path:
 * every non-`completed`, non-`infra` outcome is reported and fails the test, so
 * a corruption shows up loudly and the sticky PR comment can be diffed between a
 * baseline run and a fix run.
 */

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

const RESULT_PATH = path.resolve(
  process.cwd(),
  'event-log-race-repro-results.json'
);
const STORM_WORKFLOW_FILE = 'workflows/103_event_log_corruption_repro.ts';
const CONTROL_WORKFLOW_FILE = 'workflows/101_hook_sleep_repro.ts';

type Scenario = 'step-storm' | 'hook-storm' | 'hook-sleep';

type Outcome =
  | 'completed'
  | 'CORRUPTED_EVENT_LOG'
  | 'USER_ERROR'
  | 'RUNTIME_ERROR'
  | 'stuck'
  | 'other'
  // Harness-side, non-gating outcomes: timing races in the repro driver
  // itself (hook resume vs. the workflow's watchdog budget) and transport
  // errors talking to the deployment. These are NOT event-log regressions,
  // so they are reported but never fail the job. See `infra` handling in
  // `.github/scripts/render-event-log-race-repro-results.js`.
  | 'infra';

interface ReproConfig {
  stepStormAttempts: number;
  hookStormAttempts: number;
  hookSleepAttempts: number;
  concurrency: number;
  runTimeoutMs: number;
  hookTimeoutMs: number;
  /** Rounds of racing branches per run. More rounds = more chances for a bad
   *  write, and a longer log so a divergence has room to surface. */
  rounds: number;
  /** Racing branches per round. Each one is an independent wake source, so this
   *  is the main dial on how many invocations replay the run at once. */
  width: number;
  watchdogMs: number;
  stepDelayMs: number;
  stepDelayJitterMs: number;
  jitterBuckets: number;
  betweenRoundSleepMs: number;
  reconcileBase: number;
  attrWrites: number;
  /** `step-storm`: cadence of resumes to the never-read poke hook. Each one is
   *  an out-of-band `hook_received` write plus an extra invocation. */
  pokeIntervalMs: number;
  pokeJitterMs: number;
  /** `hook-storm`: per-index delay between resumes inside a round's burst. Set
   *  so the burst straddles `watchdogMs` and the straggler count varies. */
  hookResumeStaggerMs: number;
  hookResumeOffsetMs: number;
  /** `hook-sleep` control knobs. */
  iterations: number;
  sleepMs: number;
  resumeDelayMs: number;
  resumeJitterMs: number;
  sleepBranchWaitCount: number;
  sleepBranchWaitMs: number;
  sleepBranchWaitSpacingMs: number;
  returnOnWake: boolean;
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
  errorName?: string;
  durationMs: number;
  dashboardUrl?: string;
  /** Diagnostics from the driver: how much racing pressure the attempt actually
   *  applied. A run that corrupts with `stragglers: 0` in every round would mean
   *  the step-count amplifier was not the trigger. */
  pressure?: {
    resumesSent: number;
    resumesFailed: number;
    stragglers?: number;
  };
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
  stepStormAttempts: envNumber('EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS', 600),
  hookStormAttempts: envNumber('EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS', 600),
  hookSleepAttempts: envNumber('EVENT_LOG_RACE_REPRO_ATTEMPTS', 200),
  concurrency: envNumber('EVENT_LOG_RACE_REPRO_CONCURRENCY', 40),
  runTimeoutMs: envNumber('EVENT_LOG_RACE_REPRO_RUN_TIMEOUT_MS', 240_000),
  hookTimeoutMs: envNumber('EVENT_LOG_RACE_REPRO_HOOK_TIMEOUT_MS', 60_000),
  rounds: envNumber('EVENT_LOG_RACE_REPRO_ROUNDS', 6),
  width: envNumber('EVENT_LOG_RACE_REPRO_WIDTH', 8),
  watchdogMs: envNumber('EVENT_LOG_RACE_REPRO_WATCHDOG_MS', 2500),
  stepDelayMs: envNumber('EVENT_LOG_RACE_REPRO_STEP_DELAY_MS', 2200),
  stepDelayJitterMs: envNumber(
    'EVENT_LOG_RACE_REPRO_STEP_DELAY_JITTER_MS',
    250
  ),
  jitterBuckets: envNumber('EVENT_LOG_RACE_REPRO_JITTER_BUCKETS', 5),
  betweenRoundSleepMs: envNumber(
    'EVENT_LOG_RACE_REPRO_BETWEEN_ROUND_SLEEP_MS',
    1000
  ),
  reconcileBase: envNumber('EVENT_LOG_RACE_REPRO_RECONCILE_BASE', 2),
  attrWrites: envNumber('EVENT_LOG_RACE_REPRO_ATTR_WRITES', 1),
  pokeIntervalMs: envNumber('EVENT_LOG_RACE_REPRO_POKE_INTERVAL_MS', 750),
  pokeJitterMs: envNumber('EVENT_LOG_RACE_REPRO_POKE_JITTER_MS', 250),
  hookResumeStaggerMs: envNumber(
    'EVENT_LOG_RACE_REPRO_HOOK_RESUME_STAGGER_MS',
    400
  ),
  hookResumeOffsetMs: envNumber(
    'EVENT_LOG_RACE_REPRO_HOOK_RESUME_OFFSET_MS',
    0
  ),
  iterations: envNumber('EVENT_LOG_RACE_REPRO_ITERATIONS', 8),
  sleepMs: envNumber('EVENT_LOG_RACE_REPRO_SLEEP_MS', 5000),
  resumeDelayMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_DELAY_MS', 15_000),
  resumeJitterMs: envNumber('EVENT_LOG_RACE_REPRO_RESUME_JITTER_MS', 10_000),
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
};

function stormInput(token: string) {
  return {
    attrWrites: config.attrWrites,
    betweenRoundSleepMs: config.betweenRoundSleepMs,
    jitterBuckets: config.jitterBuckets,
    reconcileBase: config.reconcileBase,
    rounds: config.rounds,
    stepDelayJitterMs: config.stepDelayJitterMs,
    stepDelayMs: config.stepDelayMs,
    token,
    watchdogMs: config.watchdogMs,
    width: config.width,
  };
}

async function start(
  scenario: Scenario,
  workflowFile: string,
  workflowFn: string,
  workflow: { workflowId: string },
  args: unknown[]
): Promise<Run<unknown>> {
  const run = await rawStart(workflow, args);
  trackRun(run, {
    testName: `event-log-race-repro:${scenario}`,
    workflowFile,
    workflowFn,
  });
  return run;
}

/** Set once the run reaches a terminal state, so driver pumps stop pushing. */
interface DriverState {
  done: boolean;
  resumesSent: number;
  resumesFailed: number;
}

async function waitForHook(
  token: string,
  runId: string,
  state: DriverState,
  timeoutMs = config.hookTimeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline && !state.done) {
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
  return `https://vercel.com/vercel-labs/${projectSlug}/workflows/runs/${runId}?environment=${environment}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function hasWakeBranch(value: unknown) {
  if (!isRecord(value)) return false;
  const branches = value.branches;
  return (
    Array.isArray(branches) &&
    branches.some((branch) => isRecord(branch) && branch.branch === 'wake')
  );
}

/**
 * Consistency check for one round of a storm ledger. Returns the round's
 * observed straggler count, or the first disagreement found.
 */
function validateStormRound(
  record: unknown,
  index: number
): { error?: string; stragglers?: number } {
  if (!isRecord(record)) {
    return { error: `Round ${index} record was not an object.` };
  }
  if (record.round !== index) {
    return {
      error: `Round ${index} returned unexpected round ${String(record.round)}.`,
    };
  }

  const branches = record.branches;
  if (!Array.isArray(branches) || branches.length !== config.width) {
    return {
      error: `Round ${index} recorded ${Array.isArray(branches) ? branches.length : 'no'} branches instead of ${config.width}.`,
    };
  }

  const stragglers = branches.filter(
    (branch) => isRecord(branch) && branch.winner === 'watchdog'
  ).length;
  if (record.stragglers !== stragglers) {
    return {
      error: `Round ${index} reported ${String(record.stragglers)} stragglers but recorded ${stragglers} watchdog branches.`,
    };
  }
  if (record.reconciled !== config.reconcileBase + stragglers) {
    return {
      error: `Round ${index} reconciled ${String(record.reconciled)} steps instead of ${config.reconcileBase + stragglers}.`,
    };
  }

  return { stragglers };
}

/**
 * Checks the storm ledger for internal consistency. This is the *silent*
 * corruption detector: a run whose replay diverged but still reached
 * `completed` will usually disagree with itself here — a round whose reconcile
 * width does not match its own straggler count, or a missing round/branch.
 */
function validateStormReturn(value: unknown): {
  error?: string;
  stragglers?: number;
} {
  if (!isRecord(value)) {
    return { error: 'Run returned a non-object value.' };
  }

  const ledger = value.ledger;
  if (!Array.isArray(ledger)) {
    return { error: 'Run did not return a ledger.' };
  }
  if (ledger.length !== config.rounds) {
    return {
      error: `Expected ${config.rounds} rounds, got ${ledger.length}.`,
    };
  }

  let stragglers = 0;
  for (const [index, record] of ledger.entries()) {
    const round = validateStormRound(record, index);
    if (round.error) return { error: round.error };
    stragglers += round.stragglers ?? 0;
  }

  return { stragglers };
}

async function pollTerminalRun(
  run: Run<unknown>,
  startedAt: number,
  scenario: Scenario
): Promise<ReproRunResult> {
  const world = await getWorld();
  const deadline = startedAt + config.runTimeoutMs;
  let lastStatus: string | undefined;
  const base = {
    attempt: -1,
    scenario,
    token: '',
    runId: run.runId,
    dashboardUrl: getDashboardUrl(run.runId),
  };

  while (Date.now() < deadline) {
    const runData = await world.runs.get(run.runId);
    lastStatus = runData.status;

    if (runData.status === 'completed') {
      return {
        ...base,
        outcome: 'completed',
        status: runData.status,
        durationMs: Date.now() - startedAt,
      };
    }

    if (runData.status === 'failed') {
      // The machine-readable reason is the plaintext top-level `errorCode`.
      // `error` is rehydrated into an `Error` instance carrying only
      // `name`/`message`, so reading `error.code` misclassifies every real
      // failure as `other` — which is exactly how earlier runs of this job
      // reported corruptions.
      const failure = runData as {
        errorCode?: string;
        error?: { name?: string; message?: string };
      };
      return {
        ...base,
        outcome: classifyFailure(failure.errorCode),
        status: runData.status,
        errorCode: failure.errorCode,
        errorMessage: failure.error?.message,
        errorName: failure.error?.name,
        durationMs: Date.now() - startedAt,
      };
    }

    if (runData.status === 'cancelled') {
      return {
        ...base,
        outcome: 'infra',
        status: runData.status,
        errorCode: 'CANCELLED',
        durationMs: Date.now() - startedAt,
      };
    }

    await sleep(1000);
  }

  return {
    ...base,
    outcome: 'stuck',
    status: lastStatus,
    durationMs: Date.now() - startedAt,
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

function harnessFailure(
  scenario: Scenario,
  attempt: number,
  token: string,
  startedAt: number,
  err: unknown
): ReproRunResult {
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

/**
 * Runs a driver pump alongside the terminal-state poll. The pump keeps applying
 * pressure (hook resumes) for as long as the run is alive, and is torn down as
 * soon as the run is terminal so a pending hook wait cannot outlive it.
 *
 * Pump failures never fail the attempt: a resume racing the hook's disposal is
 * the expected outcome for a branch whose watchdog already fired, and counting
 * those is more useful than treating them as regressions.
 */
async function drive(
  run: Run<unknown>,
  startedAt: number,
  scenario: Scenario,
  pump: (state: DriverState) => Promise<void>
) {
  const state: DriverState = { done: false, resumesFailed: 0, resumesSent: 0 };
  const pumpPromise = pump(state).catch(() => {
    // Swallowed by design — see the note above.
  });
  try {
    return {
      runResult: await pollTerminalRun(run, startedAt, scenario),
      state,
    };
  } finally {
    state.done = true;
    await pumpPromise;
  }
}

async function tryResume(
  state: DriverState,
  hook: Awaited<ReturnType<typeof getHookByToken>>,
  payload: unknown
) {
  state.resumesSent += 1;
  try {
    await resumeHook(hook, payload);
  } catch {
    // A resume landing after the workflow disposed the hook is expected.
    state.resumesFailed += 1;
  }
}

/**
 * `step-storm`: the racing branches settle on their own (a step completion beats
 * or loses to the watchdog), and the driver's only job is to keep resuming the
 * never-read poke hook. Each poke is an out-of-band `hook_received` — a write
 * with no replay snapshot behind it — plus one more invocation replaying the run
 * concurrently with whatever the branches are doing.
 */
async function runStepStormAttempt(attempt: number): Promise<ReproRunResult> {
  const scenario: Scenario = 'step-storm';
  const startedAt = Date.now();
  const token = makeToken(scenario, attempt);

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      STORM_WORKFLOW_FILE,
      'stepStormReproWorkflow'
    );
    const run = await start(
      scenario,
      STORM_WORKFLOW_FILE,
      'stepStormReproWorkflow',
      workflow,
      [stormInput(token)]
    );

    const { runResult, state } = await drive(
      run,
      startedAt,
      scenario,
      async (driverState) => {
        const hook = await waitForHook(`${token}:poke`, run.runId, driverState);
        while (!driverState.done) {
          await tryResume(driverState, hook, {
            index: -1,
            round: -1,
            sentAt: Date.now(),
          });
          const jitter =
            config.pokeJitterMs > 0
              ? Math.floor(Math.random() * config.pokeJitterMs)
              : 0;
          await sleep(config.pokeIntervalMs + jitter);
        }
      }
    );

    return await finishStormAttempt(
      run,
      runResult,
      state,
      attempt,
      scenario,
      token
    );
  } catch (err) {
    return harnessFailure(scenario, attempt, token, startedAt, err);
  }
}

/**
 * `hook-storm`: the production shape. Each branch waits for its own hook
 * delivery with a watchdog timeout, so every resume both settles a branch and
 * wakes its own invocation. A round's `width` hooks are all created by one
 * suspension, so waiting for index 0 to exist is enough to know the rest do —
 * the driver then staggers resumes across the watchdog deadline so some branches
 * settle and some straggle, and the reconcile width differs per round.
 */
async function runHookStormAttempt(attempt: number): Promise<ReproRunResult> {
  const scenario: Scenario = 'hook-storm';
  const startedAt = Date.now();
  const token = makeToken(scenario, attempt);

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      STORM_WORKFLOW_FILE,
      'hookStormReproWorkflow'
    );
    const run = await start(
      scenario,
      STORM_WORKFLOW_FILE,
      'hookStormReproWorkflow',
      workflow,
      [stormInput(token)]
    );

    const { runResult, state } = await drive(
      run,
      startedAt,
      scenario,
      async (driverState) => {
        for (let round = 0; round < config.rounds; round += 1) {
          if (driverState.done) return;

          // Round `n`'s hooks only exist once round `n - 1` finished, so this
          // wait doubles as the round barrier.
          await waitForHook(`${token}:${round}:0`, run.runId, driverState);
          if (config.hookResumeOffsetMs > 0) {
            await sleep(config.hookResumeOffsetMs);
          }

          await Promise.all(
            Array.from({ length: config.width }, async (_, index) => {
              if (index > 0) {
                await sleep(index * config.hookResumeStaggerMs);
              }
              if (driverState.done) return;
              let hook: Awaited<ReturnType<typeof getHookByToken>>;
              try {
                hook = await waitForHook(
                  `${token}:${round}:${index}`,
                  run.runId,
                  driverState,
                  5000
                );
              } catch {
                // The branch's watchdog already fired and disposed the hook.
                driverState.resumesFailed += 1;
                return;
              }
              await tryResume(driverState, hook, {
                index,
                round,
                sentAt: Date.now(),
              });
            })
          );
        }
      }
    );

    return await finishStormAttempt(
      run,
      runResult,
      state,
      attempt,
      scenario,
      token
    );
  } catch (err) {
    return harnessFailure(scenario, attempt, token, startedAt, err);
  }
}

async function finishStormAttempt(
  run: Run<unknown>,
  runResult: ReproRunResult,
  state: DriverState,
  attempt: number,
  scenario: Scenario,
  token: string
): Promise<ReproRunResult> {
  const pressure = {
    resumesFailed: state.resumesFailed,
    resumesSent: state.resumesSent,
  };

  if (runResult.outcome !== 'completed') {
    return { ...runResult, attempt, pressure, scenario, token };
  }

  const returnValue = await withTimeout(
    run.returnValue,
    30_000,
    `Timed out reading return value for run ${run.runId}`
  );
  const validation = validateStormReturn(returnValue);
  if (validation.error) {
    return {
      ...runResult,
      attempt,
      errorCode: 'BAD_STORM_LEDGER',
      errorMessage: validation.error,
      outcome: 'other',
      pressure,
      scenario,
      token,
    };
  }

  return {
    ...runResult,
    attempt,
    pressure: { ...pressure, stragglers: validation.stragglers },
    scenario,
    token,
  };
}

/**
 * The calibration control, unchanged in shape from the original harness: a
 * single hook read raced against a single sleep, resumed once after a jittered
 * delay. Kept at low attempt counts purely so each run reports a rate for the
 * one scenario with a known historical baseline (~0.1%).
 */
async function runHookSleepAttempt(attempt: number): Promise<ReproRunResult> {
  const scenario: Scenario = 'hook-sleep';
  const startedAt = Date.now();
  const token = makeToken(scenario, attempt);

  try {
    const workflow = await getWorkflowMetadata(
      deploymentUrl,
      CONTROL_WORKFLOW_FILE,
      'hookSleepReproWorkflow'
    );
    const run = await start(
      scenario,
      CONTROL_WORKFLOW_FILE,
      'hookSleepReproWorkflow',
      workflow,
      [
        {
          iterations: config.iterations,
          returnOnWake: config.returnOnWake,
          sleepBranchWaitCount: config.sleepBranchWaitCount,
          sleepBranchWaitMs: config.sleepBranchWaitMs,
          sleepBranchWaitSpacingMs: config.sleepBranchWaitSpacingMs,
          sleepMs: config.sleepMs,
          token,
        },
      ]
    );

    const { runResult, state } = await drive(
      run,
      startedAt,
      scenario,
      async (driverState) => {
        const hook = await waitForHook(token, run.runId, driverState);
        const jitter =
          config.resumeJitterMs > 0
            ? Math.floor(Math.random() * config.resumeJitterMs)
            : 0;
        await sleep(config.resumeDelayMs + jitter);
        if (driverState.done) return;
        await tryResume(driverState, hook, { attempt, sentAt: Date.now() });
      }
    );

    const pressure = {
      resumesFailed: state.resumesFailed,
      resumesSent: state.resumesSent,
    };

    if (runResult.outcome === 'completed') {
      const returnValue = await withTimeout(
        run.returnValue,
        30_000,
        `Timed out reading return value for run ${run.runId}`
      );
      if (!hasWakeBranch(returnValue)) {
        return {
          ...runResult,
          attempt,
          errorCode: 'NO_WAKE_BRANCH',
          errorMessage: 'Run completed without taking the hook wake branch.',
          // The run completed cleanly but the sleep branch won the race before
          // the resume landed, so the wake branch was never taken. This means
          // the attempt lost its intended coverage, not that the log is wrong.
          outcome: 'infra',
          pressure,
          scenario,
          token,
        };
      }
    }

    return { ...runResult, attempt, pressure, scenario, token };
  } catch (err) {
    return harnessFailure(scenario, attempt, token, startedAt, err);
  }
}

function makeToken(scenario: Scenario, attempt: number) {
  return `event-log-race-${scenario}-${Date.now()}-${attempt}-${Math.random()
    .toString(36)
    .slice(2)}`;
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

function summarize(results: ReproRunResult[]) {
  return results.reduce<Record<Outcome, number>>((acc, result) => {
    acc[result.outcome] += 1;
    return acc;
  }, emptyOutcomeCounts());
}

function summarizeByScenario(results: ReproRunResult[]) {
  return results.reduce<Record<Scenario, Record<Outcome, number>>>(
    (acc, result) => {
      acc[result.scenario][result.outcome] += 1;
      return acc;
    },
    {
      'step-storm': emptyOutcomeCounts(),
      'hook-storm': emptyOutcomeCounts(),
      'hook-sleep': emptyOutcomeCounts(),
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
        config: { ...config, attempts: results.length },
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

const totalAttempts =
  config.stepStormAttempts +
  config.hookStormAttempts +
  config.hookSleepAttempts;
const testTimeoutMs =
  config.runTimeoutMs * Math.ceil(totalAttempts / config.concurrency) + 60_000;

describe('event log race repro', () => {
  beforeAll(() => {
    setupWorld(deploymentUrl);

    // The storms only produce the step-count divergence they exist for when
    // branches land on both sides of the watchdog deadline. If the step delay
    // spread sits entirely under (or over) the watchdog, every branch takes the
    // same path, the reconcile width is constant, and a missing event no longer
    // shifts the correlation-ID sequence.
    const spreadMs =
      config.jitterBuckets > 1
        ? Math.floor(config.jitterBuckets / 2) * config.stepDelayJitterMs
        : 0;
    if (
      config.stepDelayMs + spreadMs <= config.watchdogMs ||
      config.stepDelayMs - spreadMs >= config.watchdogMs
    ) {
      console.warn(
        `[event-log-race-repro] step delay spread (${config.stepDelayMs} ± ${spreadMs}ms) ` +
          `does not straddle watchdogMs (${config.watchdogMs}). Every step-storm ` +
          `branch will take the same path, so the reconcile fan-out width will be ` +
          `constant and the step-count amplifier is disabled.`
      );
    }

    // Same requirement for hook-storm, where the driver's stagger — not a step
    // delay — decides which branches settle before their watchdog.
    const burstSpanMs = (config.width - 1) * config.hookResumeStaggerMs;
    if (config.hookResumeOffsetMs + burstSpanMs <= config.watchdogMs) {
      console.warn(
        `[event-log-race-repro] hook resume burst (offset ${config.hookResumeOffsetMs}ms + ` +
          `span ${burstSpanMs}ms over ${config.width} branches) finishes before ` +
          `watchdogMs (${config.watchdogMs}). Every hook-storm branch will settle, ` +
          `so no branch takes the extra-step recovery path.`
      );
    }

    const sleepBudgetMs = config.iterations * config.sleepMs;
    const resumeCeilingMs = config.resumeDelayMs + config.resumeJitterMs;
    if (resumeCeilingMs >= sleepBudgetMs) {
      console.warn(
        `[event-log-race-repro] hook-sleep resume ceiling (${resumeCeilingMs}ms) is not ` +
          `below its sleep budget (${sleepBudgetMs}ms). Most control attempts will ` +
          `lose the wake branch and be recorded as infra.`
      );
    }
  });

  test(
    'event log races do not corrupt, stall, or take stale branches',
    { timeout: testTimeoutMs },
    async () => {
      const results = [
        ...(await runScenario(
          config.stepStormAttempts,
          config.concurrency,
          runStepStormAttempt
        )),
        ...(await runScenario(
          config.hookStormAttempts,
          config.concurrency,
          runHookStormAttempt
        )),
        ...(await runScenario(
          config.hookSleepAttempts,
          config.concurrency,
          runHookSleepAttempt
        )),
      ];
      writeResults(results);

      // Only event-log regressions fail the job. `infra` outcomes are
      // harness-side timing races (hook resume vs. watchdog budget) and
      // transport errors — they are recorded and surfaced in the summary, but do
      // not gate, matching `--check` in the renderer script.
      const regressions = results.filter(
        (result) => result.outcome !== 'completed' && result.outcome !== 'infra'
      );
      expect(regressions).toEqual([]);
    }
  );
});
