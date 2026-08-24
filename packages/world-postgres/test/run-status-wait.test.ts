import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { WorkflowRunNotFoundError } from '@workflow/errors';
import type { WorkflowRun } from '@workflow/world';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import {
  createRunStatusListener,
  type RunStatusListener,
} from '../src/run-status.js';
import { createEventsStorage, createRunsStorage } from '../src/storage.js';

/**
 * `runs.waitForTerminalStatus` on world-postgres.
 *
 * The point of these tests is to pin down that the wait is driven by the
 * run-terminal `NOTIFY` and not by its backstop re-read: the backstop is
 * dialed up to 10s here, so a wait that resolves in milliseconds can only have
 * been woken by the notification.
 */
describe('runs.waitForTerminalStatus (Postgres integration)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const pollIntervalEnv = 'WORKFLOW_POSTGRES_RUN_STATUS_POLL_INTERVAL_MS';
  const originalPollInterval = process.env[pollIntervalEnv];

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let drizzle: ReturnType<typeof createClient>;
  let listener: RunStatusListener;
  let runs: ReturnType<typeof createRunsStorage>;
  let events: ReturnType<typeof createEventsStorage>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });

    // >1 connection: the wait holds a read while the completing writer needs
    // its own, and the LISTEN client is separate from the pool entirely.
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    drizzle = createClient(pool);
    listener = createRunStatusListener(pool);
    runs = createRunsStorage(drizzle, listener);
    events = createEventsStorage(drizzle);
  }, 120_000);

  beforeEach(async () => {
    // Only the NOTIFY can wake a wait this quickly.
    process.env[pollIntervalEnv] = '10000';
    await pool.query(
      'TRUNCATE TABLE workflow.workflow_events, workflow.workflow_event_slots, workflow.workflow_steps, workflow.workflow_hooks, workflow.workflow_runs RESTART IDENTITY CASCADE'
    );
  });

  afterEach(() => {
    if (originalPollInterval === undefined) {
      delete process.env[pollIntervalEnv];
    } else {
      process.env[pollIntervalEnv] = originalPollInterval;
    }
  });

  afterAll(async () => {
    await listener?.close();
    await pool?.end();
    await container?.stop();
  });

  async function startRun(): Promise<WorkflowRun> {
    const created = await events.create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'test-workflow',
        input: new Uint8Array([1]),
      },
    } as never);
    if (!created.run) throw new Error('Expected run to be created');
    await events.create(created.run.runId, {
      eventType: 'run_started',
    } as never);
    return created.run;
  }

  const finish = (
    runId: string,
    eventType: 'run_completed' | 'run_failed' | 'run_cancelled',
    eventData?: Record<string, unknown>
  ) => events.create(runId, { eventType, eventData } as never);

  const waitForTerminalStatus = () => {
    const wait = runs.waitForTerminalStatus;
    if (!wait) throw new Error('world-postgres should implement the long poll');
    return wait;
  };

  it('returns an already-terminal run immediately', async () => {
    const run = await startRun();
    await finish(run.runId, 'run_completed', { output: new Uint8Array([2]) });

    const startedAt = Date.now();
    const waited = await waitForTerminalStatus()(run.runId, {
      timeoutMs: 30_000,
    });

    expect(waited.status).toBe('completed');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('is woken by the run-terminal NOTIFY, not by its backstop', async () => {
    const run = await startRun();

    const pending = waitForTerminalStatus()(run.runId, { timeoutMs: 30_000 });
    // Give the waiter time to park on the LISTEN, then finish the run.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedAt = Date.now();
    await finish(run.runId, 'run_completed', { output: new Uint8Array([2]) });

    const waited = await pending;

    expect(waited.status).toBe('completed');
    // The backstop re-read is 10s away, so anything close to instant proves
    // the notification did the waking.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('wakes on a failed run too', async () => {
    const run = await startRun();

    const pending = waitForTerminalStatus()(run.runId, { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await finish(run.runId, 'run_failed', {
      error: new Uint8Array([3]),
      errorCode: 'USER_ERROR',
    });

    const waited = await pending;
    expect(waited.status).toBe('failed');
  });

  it('wakes on a cancelled run', async () => {
    const run = await startRun();

    const pending = waitForTerminalStatus()(run.runId, { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await finish(run.runId, 'run_cancelled');

    const waited = await pending;
    expect(waited.status).toBe('cancelled');
  });

  it('returns the latest non-terminal snapshot when the budget expires', async () => {
    const run = await startRun();

    const startedAt = Date.now();
    const waited = await waitForTerminalStatus()(run.runId, { timeoutMs: 200 });

    expect(waited.status).toBe('running');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
  });

  it('falls back to the backstop re-read without a listener', async () => {
    // A runs storage built without the shared LISTEN subscription (a direct
    // caller, or a pool that cannot host one) must still resolve — just on its
    // re-read interval instead of on the notification.
    process.env[pollIntervalEnv] = '50';
    const pollingRuns = createRunsStorage(drizzle);
    const run = await startRun();

    const wait = pollingRuns.waitForTerminalStatus;
    if (!wait) throw new Error('expected a long-poll implementation');
    const pending = wait(run.runId, { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await finish(run.runId, 'run_completed', { output: new Uint8Array([2]) });

    expect((await pending).status).toBe('completed');
  });

  it('stops early when the caller aborts', async () => {
    const run = await startRun();
    const controller = new AbortController();

    const pending = waitForTerminalStatus()(run.runId, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    expect((await pending).status).toBe('running');
  });

  it('fails like get for an unknown run', async () => {
    await expect(
      waitForTerminalStatus()('wrun_01JB0000000000000000000000', {
        timeoutMs: 30_000,
      })
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
  });
});
