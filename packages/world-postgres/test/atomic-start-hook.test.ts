import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type AnyEventRequest,
  SPEC_VERSION_CURRENT,
  startHookId,
} from '@workflow/world';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { atomicStartHookConformance } from '../../world/src/test-support/atomic-start-hook-conformance.js';
import { createClient, Schema } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
} from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * `start({ hook })` admission: the decision, the run's start Hook (an
 * ordinary `workflow_hooks` row with id `startHookId(runId)`) and the run it
 * admits commit in one transaction. From then on the start Hook is an
 * ordinary Hook, and nothing on a plain `createHook()` changes.
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
  let drizzle: ReturnType<typeof createClient>;

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
    drizzle = createClient(pool);
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
    // No `stageUnacknowledgedClaim`: the start Hook and the run commit in one
    // transaction, so the orphan state cannot exist (asserted below).
  });

  test('a failure mid-admission leaves no start Hook: decision, Hook and run commit together', async () => {
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
    const { rows: hookRows } = await pool.query(
      'SELECT hook_id FROM workflow.workflow_hooks WHERE token = $1',
      [token]
    );
    expect(hookRows).toEqual([]);
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
    metadata?: Uint8Array;
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
  const runStarted = () =>
    ({
      eventType: 'run_started',
      specVersion: SPEC_VERSION_CURRENT,
    }) as AnyEventRequest;
  const hookCreated = (
    token: string,
    options: { correlationId?: string; force?: boolean } = {}
  ) =>
    ({
      eventType: 'hook_created',
      correlationId: options.correlationId ?? `hook_${ulid()}`,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { token, ...(options.force ? { force: true } : {}) },
    }) as AnyEventRequest;
  const hookReceived = (hookId: string, token: string) =>
    ({
      eventType: 'hook_received',
      correlationId: hookId,
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { token, payload: new Uint8Array([7]) },
    }) as AnyEventRequest;
  const hookDisposed = (hookId: string) =>
    ({
      eventType: 'hook_disposed',
      correlationId: hookId,
      specVersion: SPEC_VERSION_CURRENT,
    }) as AnyEventRequest;
  const runCompleted = () =>
    ({
      eventType: 'run_completed',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { output: new Uint8Array([2]) },
    }) as AnyEventRequest;
  async function runningRun(): Promise<string> {
    const runId = `wrun_${ulid()}`;
    await events.create(runId, runCreated());
    await events.create(runId, runStarted());
    return runId;
  }
  async function admittedOwner(
    startHook: Parameters<typeof runCreated>[0] & {},
    { started = false } = {}
  ): Promise<string> {
    const runId = `wrun_${ulid()}`;
    await events.create(runId, runCreated(startHook));
    if (started) await events.create(runId, runStarted());
    return runId;
  }
  async function hookRows(token: string) {
    const { rows } = await pool.query(
      `SELECT hook_id, run_id, claims_token, token_retention_until
         FROM workflow.workflow_hooks WHERE token = $1 ORDER BY hook_id`,
      [token]
    );
    return rows as {
      hook_id: string;
      run_id: string;
      claims_token: boolean;
      token_retention_until: Date | null;
    }[];
  }
  async function eventsOf(runId: string) {
    return (await events.list({ runId, pagination: { limit: 1000 } })).data;
  }
  async function admits(token: string): Promise<boolean> {
    const contender = `wrun_${ulid()}`;
    const result = await events
      .create(contender, runCreated({ token }))
      .catch((e: unknown) => e);
    return (result as { run?: { runId: string } }).run?.runId === contender;
  }

  test("admission creates the run's start Hook: an ordinary Hook row, resolvable at once", async () => {
    const token = `real-${ulid()}`;
    const metadata = new Uint8Array([3, 4]);
    const tokenRetentionUntil = new Date(Date.now() + 3_600_000);
    const owner = `wrun_${ulid()}`;
    const admitted = await events.create(
      owner,
      runCreated({ token, metadata, tokenRetentionUntil })
    );
    const hookId = startHookId(owner);

    expect(await hookRows(token)).toEqual([
      {
        hook_id: hookId,
        run_id: owner,
        claims_token: true,
        token_retention_until: tokenRetentionUntil,
      },
    ]);
    // Before run_started, by token and by id.
    const byToken = await hooks.getByToken(token);
    expect(byToken).toMatchObject({
      hookId,
      runId: owner,
      token,
      isWebhook: false,
    });
    expect(byToken.metadata).toEqual(metadata);
    expect(await hooks.get(hookId)).toMatchObject({ hookId, runId: owner });
    expect(
      (await hooks.list({ runId: owner, pagination: {} })).data.map(
        (h) => h.hookId
      )
    ).toEqual([hookId]);

    // The run row and the stored run_created both name the start Hook; the
    // run row keeps it without metadata.
    const [row] = await drizzle
      .select({ startHook: Schema.runs.startHook })
      .from(Schema.runs)
      .where(eq(Schema.runs.runId, owner));
    expect(row.startHook).toEqual({ token, hookId, tokenRetentionUntil });
    const [created] = await drizzle
      .select({ eventData: Schema.events.eventData })
      .from(Schema.events)
      .where(eq(Schema.events.runId, owner));
    expect(
      (created.eventData as { startHook?: unknown } | undefined)?.startHook
    ).toEqual({ token, hookId, tokenRetentionUntil, metadata });
    expect(admitted.run?.startHook?.token).toBe(token);

    // No hook_created is ever written for it.
    expect(
      (await eventsOf(owner)).filter((e) => e.eventType === 'hook_created')
    ).toEqual([]);
  });

  test('a pending run accepts deliveries to its start Hook', async () => {
    const token = `pending-${ulid()}`;
    const owner = await admittedOwner({ token });
    const hookId = startHookId(owner);

    const plain = await events.create(owner, hookReceived(hookId, token));
    expect(plain.event?.eventType).toBe('hook_received');
    const keyed = await events.create(owner, hookReceived(hookId, token), {
      resumeId: `resume-${ulid()}`,
    });
    expect(keyed.event?.eventType).toBe('hook_received');
    const [run] = await drizzle
      .select({ status: Schema.runs.status })
      .from(Schema.runs)
      .where(eq(Schema.runs.runId, owner));
    expect(run.status).toBe('pending');

    await events.create(owner, runStarted());
    await events.create(owner, hookReceived(hookId, token));
    expect(
      (await eventsOf(owner))
        .filter((e) => e.eventType === 'hook_received')
        .map((e) => e.correlationId)
    ).toEqual([hookId, hookId, hookId]);
  });

  test("a hook_created for the run's start Hook id is refused with 400", async () => {
    const token = `own-id-${ulid()}`;
    const owner = await admittedOwner({ token }, { started: true });
    const error = await events
      .create(owner, hookCreated(token, { correlationId: startHookId(owner) }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400 });
    // Also for a run without a start Hook: the id is reserved by derivation.
    const plain = await runningRun();
    expect(
      await events
        .create(
          plain,
          hookCreated(`other-${ulid()}`, { correlationId: startHookId(plain) })
        )
        .catch((e: unknown) => e)
    ).toMatchObject({ status: 400 });
    expect(
      (await eventsOf(owner)).filter((e) => e.eventType === 'hook_created')
    ).toEqual([]);
    expect(await hookRows(token)).toHaveLength(1);
  });

  test('disposing the start Hook frees its token at once, even with a retention', async () => {
    const token = `dispose-${ulid()}`;
    const owner = await admittedOwner(
      { token, tokenRetentionUntil: new Date(Date.now() + 3_600_000) },
      { started: true }
    );
    const hookId = startHookId(owner);
    await events.create(owner, hookDisposed(hookId));

    expect(await hookRows(token)).toEqual([]);
    await expect(hooks.getByToken(token)).rejects.toMatchObject({
      name: 'HookNotFoundError',
    });
    await expect(
      events.create(owner, hookReceived(hookId, token))
    ).rejects.toMatchObject({ name: 'HookNotFoundError' });
    expect(await admits(token)).toBe(true);
  });

  test('the run ending without a retention frees the token', async () => {
    const token = `end-${ulid()}`;
    const owner = await admittedOwner({ token }, { started: true });
    await events.create(owner, runCompleted());
    expect(await hookRows(token)).toEqual([]);
    await expect(hooks.getByToken(token)).rejects.toMatchObject({
      name: 'HookNotFoundError',
    });
    expect(await admits(token)).toBe(true);
  });

  test('a run that never started frees the token when cancelled', async () => {
    const token = `cancel-free-${ulid()}`;
    const owner = await admittedOwner({ token });
    await events.create(owner, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    } as AnyEventRequest);
    expect(await hookRows(token)).toEqual([]);
    expect(await admits(token)).toBe(true);
  });

  test('with a retention, the ended run keeps a readable Hook that refuses deliveries and holds the token', async () => {
    const token = `retained-${ulid()}`;
    const owner = await admittedOwner(
      { token, tokenRetentionUntil: new Date(Date.now() + 3_600_000) },
      { started: true }
    );
    const hookId = startHookId(owner);
    await events.create(owner, runCompleted());

    expect((await hookRows(token)).map((r) => r.hook_id)).toEqual([hookId]);
    expect((await hooks.getByToken(token)).runId).toBe(owner);
    await expect(
      events.create(owner, hookReceived(hookId, token))
    ).rejects.toMatchObject({ name: 'RunExpiredError' });
    const refused = await events
      .create(`wrun_${ulid()}`, runCreated({ token }))
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      name: 'HookConflictError',
      conflictingRunId: owner,
    });
    const other = await runningRun();
    const conflict = await events.create(other, hookCreated(token));
    expect(conflict.event).toMatchObject({
      eventType: 'hook_conflict',
      eventData: { conflictingRunId: owner },
    });
  });

  test('a cancelled owner keeps its start Hook for its retention', async () => {
    const token = `cancel-${ulid()}`;
    const owner = await admittedOwner({
      token,
      tokenRetentionUntil: new Date(Date.now() + 3_600_000),
    });
    await events.create(owner, {
      eventType: 'run_cancelled',
      specVersion: SPEC_VERSION_CURRENT,
    } as AnyEventRequest);

    const refused = await events
      .create(`wrun_${ulid()}`, runCreated({ token }))
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ conflictingRunId: owner });
  });

  test("the owner's second createHook of the start token conflicts with its own run while the start Hook is live, and claims the token afresh after disposal", async () => {
    const token = `again-${ulid()}`;
    const owner = await admittedOwner({ token }, { started: true });
    const live = await events.create(owner, hookCreated(token));
    expect(live.event).toMatchObject({
      eventType: 'hook_conflict',
      eventData: { token, conflictingRunId: owner },
    });

    await events.create(owner, hookDisposed(startHookId(owner)));
    const freshId = `hook_${ulid()}`;
    const fresh = await events.create(
      owner,
      hookCreated(token, { correlationId: freshId })
    );
    expect(fresh.event?.eventType).toBe('hook_created');
    expect(await hookRows(token)).toMatchObject([
      { hook_id: freshId, run_id: owner, claims_token: true },
    ]);
    expect((await hooks.getByToken(token)).hookId).toBe(freshId);
  });

  test("another run's createHook conflicts, naming the owner", async () => {
    const token = `taken-${ulid()}`;
    const owner = await admittedOwner({ token });
    const other = await runningRun();
    const result = await events.create(other, hookCreated(token));
    expect(result.event).toMatchObject({
      eventType: 'hook_conflict',
      eventData: { token, conflictingRunId: owner },
    });
    expect(result.event?.eventData).not.toHaveProperty('forceRefusedReason');
  });

  test('a forced createHook takes a start Hook the workflow has not opened, like any Hook', async () => {
    const token = `force-${ulid()}`;
    const owner = await admittedOwner({ token }, { started: true });
    const hookId = startHookId(owner);
    const claimer = await runningRun();
    const claimerHookId = `hook_${ulid()}`;
    const result = await events.create(
      claimer,
      hookCreated(token, { correlationId: claimerHookId, force: true })
    );
    expect(result.event?.eventType).toBe('hook_created');
    expect(await hookRows(token)).toMatchObject([
      { hook_id: claimerHookId, run_id: claimer },
    ]);
    const disposed = (await eventsOf(owner)).filter(
      (e) => e.eventType === 'hook_disposed'
    );
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toMatchObject({
      correlationId: hookId,
      eventData: { forceClaimedBy: { runId: claimer, hookId: claimerHookId } },
    });
    // A delivery the owner resolved earlier is redirected to the claimer.
    await expect(
      events.create(owner, hookReceived(hookId, token))
    ).rejects.toMatchObject({ name: 'HookForceClaimedError' });
  });

  test('a createHook in an app without start Hooks never touches the admission machinery', async () => {
    const runId = await runningRun();
    const token = `plain-${ulid()}`;
    const query = vi.spyOn(Client.prototype, 'query');
    try {
      const result = await events.create(runId, hookCreated(token));
      expect(result.event?.eventType).toBe('hook_created');
      const statements = query.mock.calls
        .map(([q]) =>
          typeof q === 'string' ? q : (q as { text?: string }).text
        )
        .filter((q): q is string => typeof q === 'string');
      const all = statements.join('\n');
      expect(all).toMatch(/insert into "workflow"\."workflow_hooks"/i);
      expect(all).not.toMatch(/start_hook_admissions|pg_advisory/);
      // The same read and one insert as before start Hooks, with no ordering
      // by a start Hook column. The insert skips only a duplicate of its own
      // id: the token's claim index arbitrates every other creation.
      const hookInsert = statements.find((q) =>
        /insert into "workflow"\."workflow_hooks"/i.test(q)
      );
      expect(hookInsert).toMatch(/on conflict \("hook_id"\) do nothing/i);
      expect(all).not.toMatch(/order by "workflow_hooks"/i);
    } finally {
      query.mockRestore();
    }
    expect(await hookRows(token)).toMatchObject([{ claims_token: true }]);
  });

  // Looped: the claim index refuses the losing copy before the event's own
  // unique index can, and that copy must answer a duplicate, never a
  // conflict naming its own hook.
  test('two concurrent replays of one hook_created leave one hook_created and no hook_conflict', async () => {
    const second = createEventsStorage(createClient(pool));
    for (let round = 0; round < 200; round++) {
      const runId = await runningRun();
      const token = `replay-${ulid()}`;
      const request = hookCreated(token);
      const results = await Promise.allSettled([
        events.create(runId, request),
        second.create(runId, request),
      ]);
      const created = results.filter(
        (r) =>
          r.status === 'fulfilled' &&
          r.value.event?.eventType === 'hook_created'
      );
      expect(created).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject({ name: 'EntityConflictError' });
        } else {
          expect(r.value.event?.eventType).toBe('hook_created');
        }
      }
      const log = await eventsOf(runId);
      expect(log.filter((e) => e.eventType === 'hook_conflict')).toEqual([]);
      expect(log.filter((e) => e.eventType === 'hook_created')).toHaveLength(1);
    }
  });

  test('two concurrent Hooks of one run on one token leave one Hook and a conflict naming the run', async () => {
    const second = createEventsStorage(createClient(pool));
    for (let round = 0; round < 50; round++) {
      const runId = await runningRun();
      const token = `same-run-${ulid()}`;
      const results = await Promise.allSettled([
        events.create(runId, hookCreated(token)),
        second.create(runId, hookCreated(token)),
      ]);
      for (const r of results) {
        // Never a duplicate: they are different Hooks.
        expect(r.status, String((r as { reason?: unknown }).reason)).toBe(
          'fulfilled'
        );
      }
      const types = results
        .map((r) => (r.status === 'fulfilled' ? r.value.event?.eventType : ''))
        .sort();
      expect(types).toEqual(['hook_conflict', 'hook_created']);
      const conflict = results.find(
        (r) =>
          r.status === 'fulfilled' &&
          r.value.event?.eventType === 'hook_conflict'
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof events.create>>>;
      expect(conflict.value.event?.eventData).toMatchObject({
        conflictingRunId: runId,
      });
    }
  });

  test('two concurrent admissions of one token leave one owner', async () => {
    for (let round = 0; round < 4; round++) {
      const token = `admit-race-${ulid()}`;
      const candidates = Array.from({ length: 6 }, () => `wrun_${ulid()}`);
      const results = await Promise.allSettled(
        candidates.map((c) => events.create(c, runCreated({ token })))
      );
      const accepted = results.filter((r) => r.status === 'fulfilled');
      expect(accepted).toHaveLength(1);
      const rows = await hookRows(token);
      expect(rows).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toMatchObject({
            name: 'HookConflictError',
            conflictingRunId: rows[0].run_id,
          });
        }
      }
    }
  });

  test("a refused candidate's concurrent copies both answer the owner", async () => {
    const token = `refused-${ulid()}`;
    const owner = `wrun_${ulid()}`;
    await events.create(owner, runCreated({ token }));
    const second = createEventsStorage(createClient(pool));
    for (let round = 0; round < 4; round++) {
      const candidate = `wrun_${ulid()}`;
      const results = await Promise.allSettled([
        events.create(candidate, runCreated({ token })),
        second.create(candidate, {
          ...runCreated({ token }),
          eventType: 'run_started',
        } as AnyEventRequest),
      ]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            name: 'HookConflictError',
            conflictingRunId: owner,
          });
        }
      }
    }
  });

  test("an accepted candidate's concurrent copies create one run and one start Hook", async () => {
    const second = createEventsStorage(createClient(pool));
    for (let round = 0; round < 4; round++) {
      const token = `copies-${ulid()}`;
      const candidate = `wrun_${ulid()}`;
      const results = await Promise.allSettled([
        events.create(candidate, runCreated({ token })),
        second.create(candidate, {
          ...runCreated({ token }),
          eventType: 'run_started',
        } as AnyEventRequest),
      ]);
      for (const result of results) {
        // A copy may lose a race it can only answer retryably; never a
        // refusal.
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({
            name: 'HookConflictError',
          });
        }
      }
      expect(await hookRows(token)).toMatchObject([
        { hook_id: startHookId(candidate), run_id: candidate },
      ]);
      expect((await runs.get(candidate)).runId).toBe(candidate);
    }
  });

  test("a copy that would accept after the other copy's refusal commits no start Hook", async () => {
    const token = `straddle-${ulid()}`;
    const candidate = `wrun_${ulid()}`;
    const previousOwner = `wrun_${ulid()}`;
    // The other copy decided while the previous owner still held the token,
    // and has not committed yet.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO workflow.workflow_start_hook_admissions
           (run_id, token, decision, conflicting_run_id)
         VALUES ($1, $2, 'rejected', $3)`,
        [candidate, token, previousOwner]
      );
      // The token is free by now, so this copy writes its start Hook and then
      // waits on the other copy's decision row.
      const pending = events
        .create(candidate, runCreated({ token }))
        .catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query('COMMIT');
      expect(await pending).toMatchObject({ status: 503 });
    } finally {
      other.release();
    }

    expect(await hookRows(token)).toEqual([]);
    expect(
      await events
        .create(candidate, runCreated({ token }))
        .catch((e: unknown) => e)
    ).toMatchObject({
      name: 'HookConflictError',
      conflictingRunId: previousOwner,
    });
    const next = `wrun_${ulid()}`;
    expect((await events.create(next, runCreated({ token }))).run?.runId).toBe(
      next
    );
  });

  test('logs decisions under DEBUG, naming runs but never the token', async () => {
    vi.stubEnv('DEBUG', 'workflow:*');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const token = `secret-${ulid()}`;
      const owner = `wrun_${ulid()}`;
      const refused = `wrun_${ulid()}`;
      const next = `wrun_${ulid()}`;
      await events.create(
        owner,
        runCreated({
          token,
          tokenRetentionUntil: new Date(Date.now() + 1_000),
        })
      );
      await events
        .create(refused, runCreated({ token }))
        .catch(() => undefined);
      await events.create(owner, {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      } as AnyEventRequest);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await events.create(next, runCreated({ token }));

      const said = (message: string, detail: Record<string, string>) =>
        expect(debug).toHaveBeenCalledWith(
          `[world-postgres] start Hook: ${message}`,
          detail
        );
      said('accepted a candidate', { runId: owner });
      said('refused a candidate', { runId: refused, conflictingRunId: owner });
      said("released an ended owner's token", {
        runId: next,
        previousRunId: owner,
      });
      said('accepted a candidate', { runId: next });
      const lines = debug.mock.calls.map((call) => JSON.stringify(call));
      expect(lines.some((line) => line.includes(token))).toBe(false);
    } finally {
      debug.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  test('a candidate too old to be created is refused with reason expired', async () => {
    const dayAgo = ulid(Date.now() - 25 * 60 * 60 * 1000);
    const error = await events
      .create(`wrun_${dayAgo}`, {
        ...runCreated({ token: `old-${ulid()}` }),
        eventType: 'run_started',
      } as AnyEventRequest)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'START_HOOK_ADMISSION_REJECTED',
      reason: 'expired',
    });
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

  test('answers with the run, without a start Hook, for a candidate whose run was created without one', async () => {
    // What a worker that predates start Hooks leaves: it created the run from
    // the queued copy and dropped `startHook`.
    const runId = `wrun_${ulid()}`;
    await events.create(runId, runCreated());
    const token = `ordinary-${ulid()}`;

    const result = await events.create(runId, runCreated({ token }));
    expect(result.run?.runId).toBe(runId);
    expect(result.run?.startHook).toBeUndefined();
    // No Hook was created.
    expect(await hookRows(token)).toEqual([]);
    expect(await admits(token)).toBe(true);
  });
});
