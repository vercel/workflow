import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { type AnyEventRequest, SPEC_VERSION_CURRENT } from '@workflow/world';
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
 * `start({ hook })` admission: the decision and the run it admits commit in
 * one transaction, serialized per token by an advisory lock shared with
 * `createHook()`.
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
      expect(String((error as Error)?.message ?? error)).toMatch(
        /injected failure/
      );
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
});
