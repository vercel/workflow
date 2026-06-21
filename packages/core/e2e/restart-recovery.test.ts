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
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { getWorld } from '../src/runtime';
import { getWorkbenchAppPath, isLocalDeployment, setupWorld } from './utils';

const enabled =
  process.env.RESTART_RECOVERY_TEST === '1' && isLocalDeployment();

const deploymentUrl = process.env.DEPLOYMENT_URL ?? 'http://localhost:3000';
const port = Number(new URL(deploymentUrl).port || '3000');

// How long the workflow sleeps. Long enough that the run is reliably still
// sleeping when we detect it and kill the server, short enough that by the time
// the restarted server recovers it, the sleep deadline has typically already
// passed (so it completes promptly on replay).
const SLEEP_MS = 8_000;

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

function spawnServer(): ChildProcess {
  const child = spawn('pnpm', ['start'], {
    cwd: getWorkbenchAppPath(),
    // detached so we can SIGKILL the whole process group (`next start` may
    // spawn child processes) and simulate a hard crash.
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      WORKFLOW_PUBLIC_MANIFEST: '1',
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
      const runId = await startWorkflowOnServer(
        'sleepingWorkflow',
        [SLEEP_MS],
        /sleepingWorkflow/
      );
      log(`started run ${runId}`);

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

      // 5. The run should resume and complete purely from boot-time recovery.
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
      // server WHILE A STEP IS EXECUTING — so the step's queue job is held/locked
      // by the worker at crash time. For postgres this exercises whether boot
      // recovery can re-drive a run whose step job is still locked (graphile's
      // stale-lock), since the re-dispatched step reuses the same correlationId
      // job key. See https://github.com/vercel/workflow/issues/679.
      server = spawnServer();
      await waitForServerReady(server);
      log('server #1 ready');
      const runId = await startWorkflowOnServer(
        'longStepWorkflow',
        [LONG_STEP_MS],
        /longStepWorkflow/
      );
      log(`started run ${runId}`);

      await waitForStepStarted(runId);
      // Give the worker a beat to actually lock the step job and enter the step.
      await sleep(1_000);
      log('run is mid-step (step job locked)');

      await killServer(server);
      server = undefined;
      log('server #1 killed (port free)');

      server = spawnServer();
      await waitForServerReady(server);
      log('server #2 ready');

      await waitForCompleted(runId);
      log('run completed');
    }
  );
});
