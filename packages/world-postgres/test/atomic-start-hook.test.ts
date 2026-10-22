import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { type AnyEventRequest, SPEC_VERSION_CURRENT } from '@workflow/world';
import { Client } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { atomicStartHookConformance } from '../../world/src/test-support/atomic-start-hook-conformance.js';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
} from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * `start({ hook })` admission: the decision, the reservation's placeholder
 * Hook row and the run it admits commit in one transaction. The placeholder
 * claims its token through the same unique index a Hook does, so the two
 * serialize per token without anything extra on a plain `createHook()`.
 */
describe('atomic start Hook (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let events: ReturnType<typeof createEventsStorage>;
  let runs: ReturnType<typeof createRunsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK = '1';
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    // Enough connections for the concurrent candidates to really overlap.
    pool = new TestPool({ connectionString: dbUrl, max: 16 });
    const drizzle = createClient(pool);
    events = createEventsStorage(drizzle);
    runs = createRunsStorage(drizzle);
    hooks = createHooksStorage(drizzle);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  test('declares atomicStartHook only with WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK', () => {
    const previous = process.env.WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK;
    try {
      delete process.env.WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK;
      expect(
        createWorld({ pool }).capabilities?.atomicStartHook
      ).toBeUndefined();
      process.env.WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK = '1';
      expect(createWorld({ pool }).capabilities?.atomicStartHook?.active).toBe(
        true
      );
    } finally {
      process.env.WORKFLOW_POSTGRES_EXPERIMENTAL_START_HOOK = previous;
    }
  });

  atomicStartHookConformance({
    name: 'world-postgres',
    storage: () => ({ events, runs, hooks }),
    secondEvents: () => createEventsStorage(createClient(pool)),
    capabilities: () => createWorld({ pool }).capabilities,
    newRunId: () => `wrun_${ulid()}`,
    concurrentCandidates: 12,
    // Admission reads the candidate's age off the JS clock; retention is
    // compared in SQL and is exercised in real time.
    advanceClock: (ms) => {
      if (ms === 0) {
        vi.useRealTimers();
        return;
      }
      const target = Date.now() + ms;
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(target);
    },
    // No `stageOrphan`: the reservation and the run commit in one
    // transaction, so the orphan state cannot exist (asserted below).
  });

  test('a failure mid-admission leaves no reservation: decision and run commit together', async () => {
    const token = `orphan-${ulid()}`;
    const doomed = `wrun_${ulid()}`;
    // Fail the run insert inside the admission transaction, after the
    // decision row was written in it.
    await pool.query(`
      CREATE OR REPLACE FUNCTION workflow.fail_doomed_run() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${doomed}' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_doomed_run BEFORE INSERT ON workflow.workflow_runs
        FOR EACH ROW EXECUTE FUNCTION workflow.fail_doomed_run();
    `);
    try {
      const error = await events
        .create(doomed, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: 'dpl_1',
            workflowName: 'wf',
            input: new Uint8Array([1]),
            startHook: { token },
          },
        } as AnyEventRequest)
        .catch((e: unknown) => e);
      // drizzle wraps the database error ("Failed query: …") with it as cause.
      const causes: string[] = [];
      for (let e: unknown = error; e instanceof Error; e = e.cause) {
        causes.push(e.message);
      }
      expect(causes.join('\n')).toMatch(/injected failure/);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS fail_doomed_run ON workflow.workflow_runs;
        DROP FUNCTION IF EXISTS workflow.fail_doomed_run();
      `);
    }

    const { rows } = await pool.query(
      'SELECT run_id FROM workflow.workflow_start_hook_admissions WHERE token = $1',
      [token]
    );
    expect(rows).toEqual([]);
    // Nothing holds the token: a contender owns it at once.
    const contender = `wrun_${ulid()}`;
    const admitted = await events.create(contender, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        startHook: { token },
      },
    } as AnyEventRequest);
    expect(admitted.run?.runId).toBe(contender);
  });

  const runCreated = (startHook?: {
    token: string;
    tokenRetentionUntil?: Date;
  }) =>
    ({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: {
        deploymentId: 'dpl_1',
        workflowName: 'wf',
        input: new Uint8Array([1]),
        ...(startHook ? { startHook } : {}),
      },
    }) as AnyEventRequest;
  const hookCreated = (token: string) =>
    ({
      eventType: 'hook_created',
      correlationId: `hook_${ulid()}`,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { token },
    }) as AnyEventRequest;
  async function runningRun(): Promise<string> {
    const runId = `wrun_${ulid()}`;
    await events.create(runId, runCreated());
    await events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    } as AnyEventRequest);
    return runId;
  }

  test('a createHook in an app without start Hooks never touches the admission machinery', async () => {
    const runId = await runningRun();
    const query = vi.spyOn(Client.prototype, 'query');
    try {
      const result = await events.create(runId, hookCreated(`plain-${ulid()}`));
      expect(result.event?.eventType).toBe('hook_created');
      const statements = query.mock.calls
        .map(([q]) =>
          typeof q === 'string' ? q : (q as { text?: string }).text
        )
        .filter((q): q is string => typeof q === 'string');
      expect(statements.join('\n')).toMatch(
        /insert into "workflow"\."workflow_hooks"/i
      );
      expect(statements.join('\n')).not.toMatch(
        /start_hook_admissions|pg_advisory|is_start_reservation" = true/
      );
    } finally {
      query.mockRestore();
    }
  });

  test('two concurrent createHooks of one token leave one owner', async () => {
    const token = `race-${ulid()}`;
    const [a, b] = [await runningRun(), await runningRun()];
    const results = await Promise.all([
      events.create(a, hookCreated(token)),
      events.create(b, hookCreated(token)),
    ]);
    const types = results.map((r) => r.event?.eventType).sort();
    expect(types).toEqual(['hook_conflict', 'hook_created']);
    const winner = results.find((r) => r.event?.eventType === 'hook_created');
    const loser = results.find((r) => r.event?.eventType === 'hook_conflict');
    expect(loser?.event?.eventData).toMatchObject({
      conflictingRunId: winner?.event?.runId,
    });
  });

  test('a cancelled owner keeps its reservation for its retention', async () => {
    const token = `cancel-${ulid()}`;
    const owner = `wrun_${ulid()}`;
    await events.create(
      owner,
      runCreated({
        token,
        tokenRetentionUntil: new Date(Date.now() + 3_600_000),
      })
    );
    await events.create(owner, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    } as AnyEventRequest);

    const refused = await events
      .create(`wrun_${ulid()}`, runCreated({ token }))
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ conflictingRunId: owner });
  });

  test('deletes decisions older than every candidate window as admissions go', async () => {
    const stale = `wrun_${ulid()}`;
    await pool.query(
      `INSERT INTO workflow.workflow_start_hook_admissions (run_id, token, decision, created_at)
       VALUES ($1, 'stale-token', 'rejected', now() - interval '3 days')`,
      [stale]
    );
    await events.create(
      `wrun_${ulid()}`,
      runCreated({ token: `fresh-${ulid()}` })
    );
    const { rows } = await pool.query(
      'SELECT run_id FROM workflow.workflow_start_hook_admissions WHERE run_id = $1',
      [stale]
    );
    expect(rows).toEqual([]);
  });

  test('answers with the run, without its reservation, for a candidate whose run was created without one', async () => {
    // What a worker that predates start Hooks leaves: it created the run from
    // the queued copy and dropped `startHook`.
    const runId = `wrun_${ulid()}`;
    await events.create(runId, runCreated());
    const token = `unreserved-${ulid()}`;

    const result = await events.create(runId, runCreated({ token }));
    expect(result.run?.runId).toBe(runId);
    expect(result.run?.startHook).toBeUndefined();
    // Nothing was reserved.
    const other = `wrun_${ulid()}`;
    expect((await events.create(other, runCreated({ token }))).run?.runId).toBe(
      other
    );
  });
});
