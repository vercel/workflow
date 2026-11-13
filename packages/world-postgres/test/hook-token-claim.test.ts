import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { type AnyEventRequest, SPEC_VERSION_CURRENT } from '@workflow/world';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createEventsStorage, createHooksStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * One owner per hook token when many runs claim it at once
 * (https://github.com/vercel/workflow/issues/4173).
 *
 * Each claimant writes through its own pool, so the claims arrive on
 * independent connections the way separate World instances' claims do, and
 * every assertion checks both what each caller was told (`hook_created` or
 * `hook_conflict`) and what was persisted (the token's `workflow_hooks`
 * rows). The read-before-insert in the `hook_created` branch cannot decide
 * these races on its own; the `workflow_hooks_token_claim_unique` index does.
 */
describe('hook token claims across concurrent runs (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const CLAIMANTS = 12;
  const ROUNDS = 5;

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let events: ReturnType<typeof createEventsStorage>;
  let hooks: ReturnType<typeof createHooksStorage>;
  const claimantPools: TestPool[] = [];
  let claimantEvents: ReturnType<typeof createEventsStorage>[] = [];

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
    pool = new TestPool({ connectionString: dbUrl, max: 4 });
    events = createEventsStorage(createClient(pool));
    hooks = createHooksStorage(createClient(pool));
    for (let i = 0; i < CLAIMANTS; i++) {
      claimantPools.push(new TestPool({ connectionString: dbUrl, max: 2 }));
    }
    claimantEvents = claimantPools.map((p) =>
      createEventsStorage(createClient(p))
    );
    // Open every claimant's connection up front, so the race below is not
    // spread out by connection setup.
    await Promise.all(claimantPools.map((p) => p.query('SELECT 1')));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(claimantPools.map((p) => p.end()));
    await pool?.end();
    await container?.stop();
  });

  const event = (
    eventType: string,
    rest: Record<string, unknown> = {}
  ): AnyEventRequest =>
    ({
      eventType,
      specVersion: SPEC_VERSION_CURRENT,
      ...rest,
    }) as AnyEventRequest;

  async function runningRun(): Promise<string> {
    const runId = `wrun_${ulid()}`;
    await events.create(
      runId,
      event('run_created', {
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: new Uint8Array([1]),
        },
      })
    );
    await events.create(runId, event('run_started'));
    return runId;
  }

  async function hookRows(token: string) {
    const { rows } = await pool.query(
      'SELECT run_id, hook_id FROM workflow.workflow_hooks WHERE token = $1',
      [token]
    );
    return rows as { run_id: string; hook_id: string }[];
  }

  /** Every claimant creates its hook for `token` at once, each on its own pool. */
  async function claimAtOnce(
    token: string,
    runIds: string[],
    force: (i: number) => boolean = () => false
  ) {
    return Promise.all(
      runIds.map((runId, i) =>
        claimantEvents[i].create(
          runId,
          event('hook_created', {
            correlationId: `hook_${ulid()}`,
            eventData: { token, ...(force(i) ? { force: true } : {}) },
          })
        )
      )
    );
  }

  test('concurrent createHook calls from many runs on one token leave one owner, and every other run gets hook_conflict naming it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `race-${ulid()}`;
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );

      const results = await claimAtOnce(token, runIds);

      const created = results.filter(
        (r) => r.event?.eventType === 'hook_created'
      );
      const conflicts = results.filter(
        (r) => r.event?.eventType === 'hook_conflict'
      );
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(CLAIMANTS - 1);
      // Only the owner is handed a hook.
      expect(results.filter((r) => r.hook !== undefined)).toHaveLength(1);

      const rows = await hookRows(token);
      expect(rows).toHaveLength(1);
      const [owner] = rows;
      expect(created[0].event?.runId).toBe(owner.run_id);
      expect(created[0].hook?.hookId).toBe(owner.hook_id);
      for (const conflict of conflicts) {
        expect(conflict.event?.eventData).toMatchObject({
          token,
          conflictingRunId: owner.run_id,
        });
      }
      // Deliveries reach the run that was told it owns the token.
      expect((await hooks.getByToken(token)).runId).toBe(owner.run_id);
    }
  });

  test('concurrent createHook calls reclaiming the token of a finished run leave one owner', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `reclaim-${ulid()}`;
      const previous = await runningRun();
      await events.create(
        previous,
        event('hook_created', {
          correlationId: `hook_${ulid()}`,
          eventData: { token },
        })
      );
      await events.create(
        previous,
        event('run_completed', { eventData: { output: new Uint8Array([2]) } })
      );
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );

      const results = await claimAtOnce(token, runIds);

      const created = results.filter(
        (r) => r.event?.eventType === 'hook_created'
      );
      expect(created).toHaveLength(1);
      const rows = await hookRows(token);
      expect(rows).toHaveLength(1);
      expect(rows[0].run_id).toBe(created[0].event?.runId);
      for (const r of results) {
        if (r !== created[0]) {
          expect(r.event?.eventType).toBe('hook_conflict');
          expect(r.event?.eventData).toMatchObject({
            conflictingRunId: rows[0].run_id,
          });
        }
      }
    }
  });

  // A forced `createHook()` (wire field `eventData.force`) takes the
  // token over instead of conflicting. Racing forced and unforced claims
  // still leave one row for the token, owned by a forced claimer.
  test('forced and unforced claims racing on a live token leave one owner, a forced claimer', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `force-${ulid()}`;
      const victim = await runningRun();
      await events.create(
        victim,
        event('hook_created', {
          correlationId: `hook_${ulid()}`,
          eventData: { token },
        })
      );
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );
      const forced = (i: number) => i % 2 === 0;

      const results = await claimAtOnce(token, runIds, forced);

      results.forEach((r, i) => {
        // Every forced claimer ends registered (as the victim or a previous
        // claimer of a chain); an unforced one always finds an owner.
        expect(r.event?.eventType).toBe(
          forced(i) ? 'hook_created' : 'hook_conflict'
        );
      });
      const rows = await hookRows(token);
      expect(rows).toHaveLength(1);
      const ownerIndex = runIds.indexOf(rows[0].run_id);
      expect(forced(ownerIndex)).toBe(true);
    }
  });
});
