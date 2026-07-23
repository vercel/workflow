/**
 * Kill/restart recovery e2e test.
 *
 * Proves that a workflow run that is in flight (sleeping) when the server is
 * hard-killed resumes to completion after the server is restarted — WITHOUT
 * issuing any workflow operation against the restarted server. The only thing
 * that can revive the run is the server's startup wiring calling
 * `ensureWorldStarted()` (e.g. Next.js `instrumentation.ts`), which runs
 * boot-time recovery (`reenqueueActiveRuns`) for the self-hosted worlds.
 *
 * Why this fails without the startup wiring:
 *   - local world: the in-memory queue (and its pending sleep timer) dies with
 *     the process. Only `reenqueueActiveRuns` re-enqueues the run on boot.
 *   - postgres world: the sleep is a durable graphile-worker job, but the
 *     worker only auto-starts on the next enqueue. With no post-restart
 *     operation, nothing enqueues — so the worker only boots (and drains the
 *     durable job) if `world.start()` is called at startup.
 *
 * The test drives the workflow start through the server's own
 * `/api/workflows/start` route so the SERVER process owns the queue/worker; the
 * test process is a pure observer that only reads run status from shared
 * storage (filesystem for local, the shared DB for postgres). This is essential
 * for postgres: if the test process called `start()` directly it would
 * auto-boot a graphile-worker in the test process that would drain the queue
 * regardless of the server, masking the behavior under test.
 *
 * Only runs when RESTART_RECOVERY_TEST=1 and against a local server
 * (local or postgres world). Targets the nextjs-turbopack workbench.
 */
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { getWorld } from '../src/runtime';
import { getWorkbenchAppPath, isLocalDeployment, setupWorld } from './utils';

const enabled =
  process.env.RESTART_RECOVERY_TEST === '1' && isLocalDeployment();

// Multi-worker duplicate-execution repro: only meaningful on the postgres world
// (a shared DB + a graphile-worker pool). Gated behind its own flag so it stays
// out of the default CI gate until the owner-aware recovery fix lands.
const multiWorkerEnabled =
  process.env.MULTIWORKER_RECOVERY_TEST === '1' &&
  process.env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres';

const deploymentUrl = process.env.DEPLOYMENT_URL ?? 'http://localhost:3000';
const port = Number(new URL(deploymentUrl).port || '3000');

// How long the workflow sleeps. Deliberately long enough that the sleep
// deadline is still comfortably in the FUTURE after the kill/restart cycle
// completes — so the test can assert the recovered run honors its REMAINING
// sleep (does not wake early) rather than completing the moment recovery
// re-enqueues it. The restart cycle (kill + port-reclaim + `next start` ready)
// is typically ~15-35s, so 60s leaves a healthy window to observe.
const SLEEP_MS = 60_000;

// How long the single step in `longStepWorkflow` runs. Long enough that the
// step's queue job is reliably still locked when we detect it and kill the
// server.
const LONG_STEP_MS = 12_000;

const SERVER_READY_TIMEOUT_MS = 90_000;
const WAIT_CREATED_TIMEOUT_MS = 60_000;
const RECOVERY_TIMEOUT_MS = 120_000;

let server: ChildProcess | undefined;

const T0 = Date.now();
function log(msg: string): void {
  console.error(`[restart-recovery +${Date.now() - T0}ms] ${msg}`);
}

function spawnServer(
  command: 'start' | 'dev' = 'start',
  extraEnv?: Record<string, string>
): ChildProcess {
  const child = spawn('pnpm', [command], {
    cwd: getWorkbenchAppPath(),
    // detached so we can SIGKILL the whole process group (`next start` may
    // spawn child processes) and simulate a hard crash.
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      WORKFLOW_PUBLIC_MANIFEST: '1',
      ...extraEnv,
    },
  });
  return child;
}

async function waitForServerReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server process exited early with code ${child.exitCode}`
      );
    }
    try {
      const res = await fetch(deploymentUrl, { method: 'GET' });
      // Any HTTP response means the server is accepting connections.
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(
    `Server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`
  );
}

/** True while anything still answers HTTP on the deployment URL. */
async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(deploymentUrl, { method: 'GET' });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Hard-kill the server AND wait until the port is actually free. `pnpm start`
 * wraps `next start`, so SIGKILLing only the wrapper can leave `next` alive on
 * the port — which would let the "killed" server finish the run itself and
 * defeat the test. We kill the process group, then poll until nothing answers,
 * escalating to a port-based kill (`lsof`) as a backstop.
 */
async function killServer(child: ChildProcess): Promise<void> {
  const exited =
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    // Negative pid kills the whole process group (hard crash, no graceful
    // drain — the in-memory queue is lost).
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.race([exited, sleep(5_000)]);

  // Ensure the port is truly free before the test restarts on it.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await isServerUp())) return;
    // Backstop: kill whatever is still holding the port.
    try {
      execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: 'ignore' });
    } catch {
      // lsof found nothing or isn't available
    }
    await sleep(500);
  }
  throw new Error(
    `Server still responding on port ${port} after kill — cannot guarantee a true restart`
  );
}

/** Run ids of in-flight (pending/running) runs whose name matches `pattern`. */
async function inFlightRunIds(pattern: RegExp): Promise<Set<string>> {
  const world = await getWorld();
  const ids = new Set<string>();
  for (const status of ['pending', 'running'] as const) {
    const { data } = await world.runs.list({ status, resolveData: 'none' });
    for (const r of data) {
      if (pattern.test(r.workflowName)) ids.add(r.runId);
    }
  }
  return ids;
}

/**
 * Start a workflow on the SERVER (server-side `start()` so the SERVER process
 * owns the queue/sleep timer/worker — essential: if the test process started
 * it, the test process would own the timer/worker and killing the server
 * wouldn't matter).
 *
 * The `/api/workflows/start` route streams until the workflow completes and only
 * flushes the `X-Workflow-Run-Id` header with the body, so we must NOT await it
 * (that would block, defeating the "kill mid-flight" goal). Instead we fire the
 * request and discover the new run id by diffing shared storage — a read that
 * never triggers delivery.
 */
async function startWorkflowOnServer(
  workflowName: string,
  args: unknown[],
  pattern: RegExp
): Promise<string> {
  const before = await inFlightRunIds(pattern);

  // Fire-and-forget: the request reaches the server (which starts the run) but
  // we never read the streaming body. Killing the server later rejects it.
  void fetch(new URL('/api/workflows/start', deploymentUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowName, args }),
  }).catch(() => {});

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const id of await inFlightRunIds(pattern)) {
      if (!before.has(id)) return id;
    }
    await sleep(250);
  }
  throw new Error(`Server did not start a new ${workflowName} run within 30s`);
}

/** Wait until a step has begun executing (its queue job is held/locked). */
async function waitForStepStarted(runId: string): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + WAIT_CREATED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { data } = await world.events.list({ runId });
      if (
        data.some(
          (e) =>
            e.eventType === 'step_started' || e.eventType === 'step_created'
        )
      ) {
        return;
      }
    } catch {
      // run/events not visible yet
    }
    await sleep(250);
  }
  throw new Error(
    `Run ${runId} did not start a step within ${WAIT_CREATED_TIMEOUT_MS}ms`
  );
}

async function waitForWaitCreated(runId: string): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + WAIT_CREATED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { data } = await world.events.list({ runId });
      if (data.some((e) => e.eventType === 'wait_created')) return;
    } catch {
      // run/events not visible yet
    }
    await sleep(500);
  }
  throw new Error(
    `Run ${runId} did not reach a sleeping (wait_created) state within ${WAIT_CREATED_TIMEOUT_MS}ms`
  );
}

async function waitForCompleted(runId: string): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    try {
      const run = await world.runs.get(runId);
      if (run.status !== lastStatus) log(`run status -> ${run.status}`);
      lastStatus = run.status;
      if (run.status === 'completed') return;
      if (run.status === 'failed' || run.status === 'cancelled') {
        throw new Error(
          `Run ${runId} ended in unexpected status: ${run.status}`
        );
      }
    } catch (err) {
      if (err instanceof Error && /unexpected status/.test(err.message))
        throw err;
      // run not readable yet
    }
    await sleep(1_000);
  }
  throw new Error(
    `Run ${runId} did not recover to 'completed' within ${RECOVERY_TIMEOUT_MS}ms (last status: ${lastStatus}). ` +
      `This indicates server startup did not start the World (ensureWorldStarted).`
  );
}

/** Wait until the run reaches `target` status; fail on any other terminal status. */
async function waitForStatus(
  runId: string,
  target: 'completed' | 'cancelled'
): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    try {
      const run = await world.runs.get(runId);
      if (run.status !== lastStatus) log(`run status -> ${run.status}`);
      lastStatus = run.status;
      if (run.status === target) return;
      if (terminal.has(run.status)) {
        throw new Error(
          `Run ${runId} reached terminal status '${run.status}', expected '${target}'`
        );
      }
    } catch (err) {
      if (err instanceof Error && /expected/.test(err.message)) throw err;
      // run not readable yet
    }
    await sleep(1_000);
  }
  throw new Error(
    `Run ${runId} did not reach '${target}' within ${RECOVERY_TIMEOUT_MS}ms (last status: ${lastStatus}).`
  );
}

/**
 * Poll until `untilMs`, failing if the run completes before then. Proves a
 * recovered sleeping run honors its REMAINING sleep: recovery re-enqueues the
 * run before its deadline, and replay must re-evaluate the recorded deadline
 * and keep sleeping — not wake early and run to completion. Without this, a
 * recovery that woke runs immediately would still pass the completion check.
 */
async function assertNotCompletedBefore(
  runId: string,
  untilMs: number
): Promise<void> {
  const world = await getWorld();
  while (Date.now() < untilMs) {
    let status = 'unknown';
    try {
      status = (await world.runs.get(runId)).status;
    } catch {
      // not readable yet — treat as still in-flight
    }
    if (status === 'completed') {
      throw new Error(
        `Run ${runId} completed ~${untilMs - Date.now()}ms before its sleep ` +
          'deadline — recovery woke it early instead of honoring the remaining sleep.'
      );
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`Run ${runId} ended in ${status} before its deadline`);
    }
    await sleep(1_000);
  }
}

describe.skipIf(!enabled)('restart recovery', () => {
  beforeAll(() => {
    setupWorld(deploymentUrl);
  });

  afterEach(async () => {
    if (server) {
      await killServer(server);
      server = undefined;
    }
  });

  test(
    'in-flight sleeping run resumes after a hard restart with no workflow op',
    {
      timeout:
        RECOVERY_TIMEOUT_MS +
        WAIT_CREATED_TIMEOUT_MS +
        SERVER_READY_TIMEOUT_MS * 2,
    },
    async () => {
      // 1. Boot the server and start a sleeping workflow on it.
      server = spawnServer();
      await waitForServerReady(server);
      log('server #1 ready');
      const startedAt = Date.now();
      const runId = await startWorkflowOnServer(
        'sleepingWorkflow',
        [SLEEP_MS],
        /sleepingWorkflow/
      );
      log(`started run ${runId}`);
      // The run's sleep deadline is strictly AFTER this lower bound: the server
      // received the start and called sleep() some time after we recorded
      // startedAt, so the true deadline > startedAt + SLEEP_MS.
      const deadlineLowerBound = startedAt + SLEEP_MS;

      // 2. Wait until the run is durably sleeping (server scheduled the wait).
      await waitForWaitCreated(runId);
      log('run is sleeping (wait_created)');

      // 3. Hard-kill the server mid-sleep (loses the in-memory queue timer;
      //    stops the postgres worker).
      await killServer(server);
      server = undefined;
      log('server #1 killed (port free)');

      // 4. Restart the server. Crucially, issue NO workflow operation against
      //    it — startup alone must trigger recovery.
      server = spawnServer();
      await waitForServerReady(server);
      log('server #2 ready');

      // 5. Recovery has now re-enqueued the run, but its sleep deadline is still
      //    in the future. The run must honor the REMAINING sleep (not wake
      //    early) — poll until the deadline and fail if it completes prematurely.
      if (Date.now() < deadlineLowerBound) {
        await assertNotCompletedBefore(runId, deadlineLowerBound);
        log('run stayed asleep until its deadline (no early wake on replay)');
      } else {
        log(
          'WARNING: restart outlasted the sleep deadline; skipping early-wake assertion'
        );
      }

      // 6. After the deadline the run should resume and complete.
      await waitForCompleted(runId);
      log('run completed');
    }
  );

  test(
    'in-flight run killed mid-step resumes after a hard restart with no workflow op',
    {
      timeout:
        RECOVERY_TIMEOUT_MS +
        WAIT_CREATED_TIMEOUT_MS +
        SERVER_READY_TIMEOUT_MS * 2,
    },
    async () => {
      // Unlike the sleeping case (a delayed, unlocked queue job), this kills the
      // server WHILE A STEP IS EXECUTING. The step runs inline in the flow
      // invocation and its latest step_started carries the owning message ID
      // (inline ownership, workflow#2780), so after the restart the boot
      // recovery replay finds a step whose owner it cannot distinguish from a
      // live invocation on another instance. It defers to the ownership lease:
      // it arms a delayed backstop wake and only re-dispatches the step once
      // the lease expires. The default lease (860s) is sized for Vercel's
      // function ceiling and far exceeds this test's budget, so shorten it —
      // the test then exercises the FULL recovery path (boot re-enqueue →
      // lease-gated backstop → step requeue → re-execution) instead of timing
      // out on a delay that is pure configuration.
      // See https://github.com/vercel/workflow/issues/679.
      const leaseEnv = { WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: '30' };
      server = spawnServer('start', leaseEnv);
      await waitForServerReady(server);
      log('server #1 ready');
      const runId = await startWorkflowOnServer(
        'longStepWorkflow',
        [LONG_STEP_MS],
        /longStepWorkflow/
      );
      log(`started run ${runId}`);

      await waitForStepStarted(runId);
      // Give the worker a beat to enter the step body (the step is now
      // inline-owned by the invocation we are about to kill).
      await sleep(1_000);
      log('run is mid-step (inline-owned by server #1)');

      await killServer(server);
      server = undefined;
      log('server #1 killed (port free)');

      server = spawnServer('start', leaseEnv);
      await waitForServerReady(server);
      log('server #2 ready');

      await waitForCompleted(runId);
      log('run completed');
    }
  );

  test(
    'dev restart cancels in-flight runs instead of recovering them',
    {
      timeout:
        RECOVERY_TIMEOUT_MS +
        WAIT_CREATED_TIMEOUT_MS +
        SERVER_READY_TIMEOUT_MS * 2,
    },
    async () => {
      // In DEVELOPMENT, the server's startup wiring (ensureWorldStarted, which
      // detects dev via NODE_ENV / framework flags) must CANCEL runs left in
      // flight by a previous dev session rather than re-enqueue them — their
      // workflow code may have changed since they started, so replaying them is
      // unsafe. `pnpm dev` sets NODE_ENV=development, so the restarted dev server
      // cancels the sleeping run on boot.
      server = spawnServer('dev');
      await waitForServerReady(server);
      log('dev server #1 ready');
      const runId = await startWorkflowOnServer(
        'sleepingWorkflow',
        [SLEEP_MS],
        /sleepingWorkflow/
      );
      log(`started run ${runId}`);

      await waitForWaitCreated(runId);
      log('run is sleeping (wait_created)');

      await killServer(server);
      server = undefined;
      log('dev server #1 killed (port free)');

      // Restart the dev server and issue NO workflow operation — startup alone
      // must cancel the prior in-flight run (not recover it to completion).
      server = spawnServer('dev');
      await waitForServerReady(server);
      log('dev server #2 ready');

      await waitForStatus(runId, 'cancelled');
      log('run cancelled on dev restart (not recovered)');
    }
  );
});

// ===========================================================================
// Multi-worker duplicate-execution repro (postgres only)
// ===========================================================================

// How long the single step in `sideEffectStepWorkflow` runs — long enough that
// it is reliably still executing on the first worker when the second worker
// boots and re-enqueues active runs.
const SIDE_EFFECT_STEP_MS = 20_000;
const secondPort = port + 1;
const secondUrl = `http://localhost:${secondPort}`;

function spawnServerOnPort(
  p: number,
  extraEnv: Record<string, string>
): ChildProcess {
  return spawn('pnpm', ['start'], {
    cwd: getWorkbenchAppPath(),
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(p),
      WORKFLOW_PUBLIC_MANIFEST: '1',
      ...extraEnv,
    },
  });
}

async function waitForReadyAt(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server process exited early with code ${child.exitCode}`
      );
    }
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

async function killChild(child: ChildProcess, p: number): Promise<void> {
  const exited =
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.race([exited, sleep(5_000)]);

  // `pnpm start` wraps `next start`; SIGKILLing the wrapper can leave `next`
  // alive on the port and holding handles. Poll until the port is free,
  // escalating to a port-based kill so the vitest worker can exit cleanly.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${p}`, { method: 'GET' });
      if (!(res.status > 0)) return;
    } catch {
      return; // nothing answering — port is free
    }
    try {
      execSync(`lsof -ti tcp:${p} | xargs kill -9`, { stdio: 'ignore' });
    } catch {
      // lsof found nothing or isn't available
    }
    await sleep(500);
  }
}

/** Count recorded step-body executions in the shared side-effect log. */
function countExecutions(logPath: string): number {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() === 'exec').length;
  } catch {
    return 0;
  }
}

async function waitForExecutions(
  logPath: string,
  min: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = countExecutions(logPath);
    if (n >= min) return n;
    await sleep(250);
  }
  return countExecutions(logPath);
}

describe.skipIf(!multiWorkerEnabled)('multi-worker recovery (postgres)', () => {
  let workerB: ChildProcess | undefined;
  let workerA: ChildProcess | undefined;

  beforeAll(() => {
    setupWorld(deploymentUrl);
  });

  afterEach(async () => {
    if (workerA) {
      await killChild(workerA, secondPort);
      workerA = undefined;
    }
    if (workerB) {
      await killChild(workerB, port);
      workerB = undefined;
    }
  });

  test(
    'a worker booting does not re-run a step already executing on another worker',
    {
      timeout:
        RECOVERY_TIMEOUT_MS +
        WAIT_CREATED_TIMEOUT_MS +
        SERVER_READY_TIMEOUT_MS * 2,
    },
    async () => {
      // Shared side-effect log: the step appends one line per execution of its
      // body (before sleeping), so we can count how many times it actually ran.
      const dir = mkdtempSync(join(tmpdir(), 'wf-multiworker-'));
      const logPath = join(dir, 'side-effects.log');
      writeFileSync(logPath, '');
      const env = { WORKFLOW_SIDE_EFFECT_LOG: logPath };

      // 1. Worker B owns the run.
      workerB = spawnServerOnPort(port, env);
      await waitForReadyAt(deploymentUrl, workerB);
      log('worker B ready');

      const runId = await startWorkflowOnServer(
        'sideEffectStepWorkflow',
        [SIDE_EFFECT_STEP_MS],
        /sideEffectStepWorkflow/
      );
      log(`started run ${runId}`);

      // 2. Wait until B has entered the step body (one execution recorded). The
      //    step's queue job is now locked by B and the step is mid-run.
      const initial = await waitForExecutions(
        logPath,
        1,
        WAIT_CREATED_TIMEOUT_MS
      );
      expect(initial).toBe(1);
      log('B is mid-step (1 execution recorded)');

      // 3. Boot a SECOND worker while the step is still running. Its startup
      //    wiring (ensureWorldStarted -> reenqueueActiveRuns) re-drives ALL
      //    active runs — including this one, which is healthy on B.
      workerA = spawnServerOnPort(secondPort, env);
      await waitForReadyAt(secondUrl, workerA);
      log('worker A booted (reenqueueActiveRuns ran)');

      // 4. Let the run finish (B's original step completes at ~SIDE_EFFECT_STEP_MS).
      await waitForCompleted(runId);
      const executions = countExecutions(logPath);
      log(`step body executed ${executions} time(s)`);

      // Exactly-once guarantee: boot-time recovery must NOT re-run a step that
      // is healthily in-flight on another worker. The step executes inline in
      // B's flow invocation, so A's boot replay sees it inline-owned (its
      // latest step_started carries B's message ID) with a live ownership
      // lease — A defers to a delayed backstop instead of re-dispatching
      // (workflow#2780). By the time any later dispatch could run, the step
      // has completed on B and the terminal-state guard skips re-execution.
      // (Queue-dispatched attempts are additionally deduped under their
      // `correlationId` idempotency key — graphile-worker's job-key.)
      expect(executions).toBe(1);
    }
  );
});
