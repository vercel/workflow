import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { WorkflowRunAlreadyStartedError } from '@workflow/errors';
import {
  type AnyEventRequest,
  type EventResult,
  type IdempotencyKeyReusePolicy,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import type { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runIdempotencyConformance } from '../../world/src/test-support/run-idempotency-conformance.js';
import { createClient, type Drizzle } from '../src/drizzle/index.js';
import { deleteExpiredRunIdempotencyKeys } from '../src/idempotency-keys.js';
import { createWorld } from '../src/index.js';
import { createEventsStorage, createRunsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * Run idempotency keys on the Postgres World: the shared conformance suite,
 * plus what it cannot see (the claim row, the run's own copy of the key, a
 * refusal rolling the whole transaction back, and expired-claim cleanup).
 */
describe('run idempotency keys (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const SPEC = SPEC_VERSION_CURRENT;
  /** `create` without its overloads, so a test can pass any request. */
  const createEvent = (runId: string, data: AnyEventRequest) =>
    (
      events.create as (
        runId: string,
        data: AnyEventRequest
      ) => Promise<EventResult>
    )(runId, data);
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  let drizzle: Drizzle;
  let events: ReturnType<typeof createEventsStorage>;
  let runs: ReturnType<typeof createRunsStorage>;

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
    // Enough connections for concurrent claimers to really overlap.
    pool = new TestPool({ connectionString: dbUrl, max: 16 });
    drizzle = createClient(pool);
    events = createEventsStorage(drizzle);
    runs = createRunsStorage(drizzle);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  runIdempotencyConformance({
    name: 'world-postgres',
    events: () => events,
    runs: () => runs,
    capabilities: () => createWorld({ pool }).capabilities,
    newRunId: () => `wrun_${ulid()}`,
    deleteRun: async (runId) => {
      await pool.query('DELETE FROM workflow.workflow_runs WHERE id = $1', [
        runId,
      ]);
    },
    concurrentClaimers: 12,
  });

  const workflowName = 'workflow//./src/orders//process';

  function runCreated(
    key: string,
    options: { policy?: IdempotencyKeyReusePolicy; ttlMs?: number } = {}
  ): AnyEventRequest {
    return {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_idem',
        workflowName,
        input: new Uint8Array([1]),
        idempotencyKey: key,
        idempotencyKeyTtlMs: options.ttlMs ?? 3_600_000,
        idempotencyKeyReusePolicy: options.policy ?? 'REJECT_DUPLICATE',
      },
    } as AnyEventRequest;
  }

  const uniqueKey = () => `key-${ulid()}`;

  async function claimRow(key: string) {
    const { rows } = await pool.query(
      `SELECT run_id, ttl_ms FROM workflow.workflow_run_idempotency_keys
       WHERE workflow_name = $1 AND idempotency_key = $2`,
      [workflowName, key]
    );
    return rows[0] as { run_id: string; ttl_ms: string | number } | undefined;
  }

  async function close(runId: string) {
    await createEvent(runId, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as AnyEventRequest);
    await createEvent(runId, {
      eventType: 'run_completed',
      specVersion: SPEC,
      eventData: { output: new Uint8Array([2]) },
    } as AnyEventRequest);
  }

  test('stores the claim with a TTL past the integer range, and the key on the run', async () => {
    const key = uniqueKey();
    const runId = `wrun_${ulid()}`;
    // 30 days in milliseconds does not fit a Postgres integer.
    await createEvent(runId, runCreated(key, { ttlMs: 2_592_000_000 }));

    const row = await claimRow(key);
    expect(row?.run_id).toBe(runId);
    expect(Number(row?.ttl_ms)).toBe(2_592_000_000);
    await close(runId);
    expect((await runs.get(runId)).idempotencyKey).toBe(key);
  });

  test('a refusal rolls back the run and its event', async () => {
    const key = uniqueKey();
    const holder = `wrun_${ulid()}`;
    await createEvent(holder, runCreated(key));

    const refused = `wrun_${ulid()}`;
    const error = await createEvent(
      refused,
      runCreated(key, { policy: 'ALLOW_DUPLICATE' })
    ).catch((err: unknown) => err);
    expect(WorkflowRunAlreadyStartedError.is(error)).toBe(true);
    expect(error).toMatchObject({
      runId: holder,
      runStatus: 'pending',
      workflowName,
      idempotencyKey: key,
    });

    const { rows: runRows } = await pool.query(
      'SELECT 1 FROM workflow.workflow_runs WHERE id = $1',
      [refused]
    );
    const { rows: eventRows } = await pool.query(
      'SELECT 1 FROM workflow.workflow_events WHERE run_id = $1',
      [refused]
    );
    const { rows: slotRows } = await pool.query(
      'SELECT 1 FROM workflow.workflow_event_slots WHERE run_id = $1',
      [refused]
    );
    expect(runRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
    expect(slotRows).toHaveLength(0);
    expect((await claimRow(key))?.run_id).toBe(holder);
  });

  test('a takeover re-points the claim and records the new TTL', async () => {
    const key = uniqueKey();
    const first = `wrun_${ulid()}`;
    await createEvent(first, runCreated(key));
    await close(first);

    const second = `wrun_${ulid()}`;
    await createEvent(
      second,
      runCreated(key, { policy: 'ALLOW_DUPLICATE', ttlMs: 5_000 })
    );

    const row = await claimRow(key);
    expect(row?.run_id).toBe(second);
    expect(Number(row?.ttl_ms)).toBe(5_000);
    // The old holder keeps its own record of the key it started with.
    expect((await runs.get(first)).idempotencyKey).toBe(key);
  });

  test('cleanup deletes only claims nothing can hold any more', async () => {
    const live = uniqueKey();
    const liveRun = `wrun_${ulid()}`;
    await createEvent(liveRun, runCreated(live));

    const insideWindow = uniqueKey();
    const insideRun = `wrun_${ulid()}`;
    await createEvent(insideRun, runCreated(insideWindow));
    await close(insideRun);

    const expired = uniqueKey();
    const expiredRun = `wrun_${ulid()}`;
    await createEvent(expiredRun, runCreated(expired, { ttlMs: 1_000 }));
    await close(expiredRun);

    const orphaned = uniqueKey();
    const orphanedRun = `wrun_${ulid()}`;
    await createEvent(orphanedRun, runCreated(orphaned));
    await pool.query('DELETE FROM workflow.workflow_runs WHERE id = $1', [
      orphanedRun,
    ]);

    // As if the clock had moved past the short TTL.
    const deleted = await deleteExpiredRunIdempotencyKeys(
      drizzle,
      new Date(Date.now() + 10_000)
    );
    expect(deleted).toBeGreaterThanOrEqual(2);

    expect((await claimRow(live))?.run_id).toBe(liveRun);
    expect((await claimRow(insideWindow))?.run_id).toBe(insideRun);
    expect(await claimRow(expired)).toBeUndefined();
    expect(await claimRow(orphaned)).toBeUndefined();
  });

  test('ignores idempotency fields on a resilient-start run_started', async () => {
    const key = uniqueKey();
    const resilient = `wrun_${ulid()}`;
    await createEvent(resilient, {
      eventType: 'run_started',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_idem',
        workflowName,
        input: new Uint8Array([1]),
        idempotencyKey: key,
      },
    } as AnyEventRequest);
    expect((await runs.get(resilient)).idempotencyKey).toBeUndefined();
    expect(await claimRow(key)).toBeUndefined();
    await expect(
      createEvent(`wrun_${ulid()}`, runCreated(key))
    ).resolves.toBeDefined();
  });
});
