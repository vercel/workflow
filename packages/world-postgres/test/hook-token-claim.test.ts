import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type AnyEventRequest,
  IN_BAND_SEQ_AT_RUN_CREATION,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { Client } from 'pg';
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
  let dbUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    dbUrl = container.getConnectionUri();
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

  /**
   * A fenced run's writes go in-band: each carries the count of in-band
   * events it has seen, and runs in one transaction with the fence check, so
   * the hook write below runs in a savepoint of that transaction.
   */
  type Mode = { fenced?: boolean };
  const specOf = ({ fenced }: Mode) =>
    fenced ? SPEC_VERSION_SINGLE_ORCHESTRATOR : SPEC_VERSION_CURRENT;
  const inBandAt = ({ fenced }: Mode, seen: number) =>
    fenced ? { inBand: true, expectedSeqInBand: seen } : undefined;

  async function runningRun(mode: Mode = {}): Promise<string> {
    const runId = `wrun_${ulid()}`;
    const specVersion = specOf(mode);
    await events.create(
      runId,
      event('run_created', {
        specVersion,
        eventData: {
          deploymentId: 'dpl_1',
          workflowName: 'wf',
          input: new Uint8Array([1]),
        },
      })
    );
    await events.create(
      runId,
      event('run_started', { specVersion }),
      inBandAt(mode, IN_BAND_SEQ_AT_RUN_CREATION)
    );
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
    force: (i: number) => boolean = () => false,
    mode: Mode = {}
  ) {
    return Promise.all(
      runIds.map((runId, i) =>
        claimantEvents[i].create(
          runId,
          event('hook_created', {
            specVersion: specOf(mode),
            correlationId: `hook_${ulid()}`,
            eventData: { token, ...(force(i) ? { force: true } : {}) },
          }),
          inBandAt(mode, IN_BAND_SEQ_AT_RUN_CREATION + 1)
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

  // A forced `createHook()` (wire field `eventData.force`) takes the token
  // over instead of conflicting. However the claims interleave, every forced
  // claimer gets `hook_created`, never a plain `hook_conflict` (the runtime
  // reads that as a World that cannot force-claim and fails the run), and the
  // claims form one chain: each forced claimer but the last is disposed by
  // the next one, which records whom it took the token from.
  type ClaimResult = Awaited<ReturnType<typeof claimAtOnce>>[number];
  const forceClaimedFrom = (r: ClaimResult) =>
    (r.event?.eventData as { forceClaimedFrom?: { runId: string } })
      ?.forceClaimedFrom?.runId;

  /** Who took each run's Hook, from its `hook_disposed{forceClaimedBy}`. */
  async function takenBy(runIds: string[]): Promise<Map<string, string>> {
    const takers = new Map<string, string>();
    for (const runId of runIds) {
      const log = (await events.list({ runId, pagination: { limit: 1000 } }))
        .data;
      const takeovers = log.flatMap((e) => {
        const by = (e.eventData as { forceClaimedBy?: { runId: string } })
          ?.forceClaimedBy?.runId;
        return e.eventType === 'hook_disposed' && by ? [by] : [];
      });
      expect(takeovers.length).toBeLessThanOrEqual(1);
      if (takeovers[0]) takers.set(runId, takeovers[0]);
    }
    return takers;
  }

  async function forcedChain(
    token: string,
    runIds: string[],
    results: ClaimResult[],
    victim?: string
  ) {
    for (const r of results) {
      expect(r.event?.eventData).not.toHaveProperty('forceRefusedReason');
    }
    const rows = await hookRows(token);
    expect(rows).toHaveLength(1);
    const owner = rows[0].run_id;

    const registered = runIds.filter(
      (_, i) => results[i].event?.eventType === 'hook_created'
    );
    const takers = await takenBy(victim ? [victim, ...runIds] : runIds);
    // Every registered claimer's Hook but the owner's was taken over, and
    // each takeover's `hook_created` names the run it took the token from.
    for (const runId of registered) {
      expect(takers.has(runId)).toBe(runId !== owner);
    }
    for (const [from, to] of takers) {
      expect(forceClaimedFrom(results[runIds.indexOf(to)])).toBe(from);
    }

    // The chain starts at the victim, or at the one claim that found the
    // token free (no `forceClaimedFrom`), and runs through every registered
    // claimer to the owner.
    const fresh = registered.filter(
      (runId) => !forceClaimedFrom(results[runIds.indexOf(runId)])
    );
    expect(fresh).toHaveLength(victim ? 0 : 1);
    const chain = [victim ?? fresh[0]];
    for (let next = takers.get(chain[0]); next; next = takers.get(next)) {
      chain.push(next);
    }
    expect(chain.at(-1)).toBe(owner);
    expect(new Set(chain)).toEqual(
      new Set(victim ? [victim, ...registered] : registered)
    );
    return owner;
  }

  async function holdToken(token: string, mode: Mode = {}): Promise<string> {
    const runId = await runningRun(mode);
    await events.create(
      runId,
      event('hook_created', {
        specVersion: specOf(mode),
        correlationId: `hook_${ulid()}`,
        eventData: { token },
      }),
      inBandAt(mode, IN_BAND_SEQ_AT_RUN_CREATION + 1)
    );
    return runId;
  }

  test('forced and unforced claims racing on a live token leave one owner, a forced claimer', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `force-${ulid()}`;
      const victim = await holdToken(token);
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );
      const forced = (i: number) => i % 2 === 0;

      const results = await claimAtOnce(token, runIds, forced);

      results.forEach((r, i) => {
        // An unforced claim always finds an owner.
        expect(r.event?.eventType).toBe(
          forced(i) ? 'hook_created' : 'hook_conflict'
        );
      });
      const owner = await forcedChain(token, runIds, results, victim);
      expect(forced(runIds.indexOf(owner))).toBe(true);
    }
  });

  // More forced claimers at once than a takeover used to be allowed restarts.
  test('forced claims from many runs on a live token all register and form one chain', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `force-all-${ulid()}`;
      const victim = await holdToken(token);
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );

      const results = await claimAtOnce(token, runIds, () => true);

      for (const r of results) expect(r.event?.eventType).toBe('hook_created');
      await forcedChain(token, runIds, results, victim);
    }
  });

  test('forced claims from many runs on a fresh token all register and form one chain', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `force-fresh-${ulid()}`;
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );

      const results = await claimAtOnce(token, runIds, () => true);

      for (const r of results) expect(r.event?.eventType).toBe('hook_created');
      await forcedChain(token, runIds, results);
    }
  });

  test('forced claims from many runs on a token released by a finished run all register and form one chain', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const token = `force-released-${ulid()}`;
      const previous = await holdToken(token);
      await events.create(
        previous,
        event('run_completed', { eventData: { output: new Uint8Array([2]) } })
      );
      const runIds = await Promise.all(
        Array.from({ length: CLAIMANTS }, runningRun)
      );

      const results = await claimAtOnce(token, runIds, () => true);

      for (const r of results) expect(r.event?.eventType).toBe('hook_created');
      await forcedChain(token, runIds, results);
    }
  });
  // A fenced (in-band) write runs the takeover in a savepoint of the fence's
  // transaction. A restart must roll that savepoint back, releasing the row
  // locks it took: kept, they deadlock the retry against a concurrent
  // takeover (40P01).
  for (const live of [true, false]) {
    test(`fenced forced claims from many runs on a ${live ? 'live' : 'fresh'} token all register and form one chain`, async () => {
      const mode = { fenced: true };
      for (let round = 0; round < ROUNDS; round++) {
        const token = `force-fenced-${ulid()}`;
        const victim = live ? await holdToken(token, mode) : undefined;
        const runIds = await Promise.all(
          Array.from({ length: CLAIMANTS }, () => runningRun(mode))
        );

        const results = await claimAtOnce(token, runIds, () => true, mode);

        for (const r of results)
          expect(r.event?.eventType).toBe('hook_created');
        await forcedChain(token, runIds, results, victim);
      }
    });
  }
  // The interleaving, made deterministic: C reads owner A, B then takes the
  // token from A, so C's locked read finds B and C restarts. Before C's retry,
  // T starts taking the token from B and locks B's run. Had C kept its lock on
  // B's hook across the restart, T would wait for C on the hook and C for T on
  // the run: a deadlock Postgres breaks by failing one claim with 40P01.
  test('a fenced forced claim that restarts keeps no lock from the attempt it abandoned', async () => {
    const mode = { fenced: true };
    const token = `force-restart-${ulid()}`;
    await holdToken(token, mode);
    const [b, c, t] = await Promise.all([
      runningRun(),
      runningRun(mode),
      runningRun(),
    ]);
    const forcedClaim = (
      storage: ReturnType<typeof createEventsStorage>,
      runId: string,
      claimMode: Mode = {}
    ) =>
      storage.create(
        runId,
        event('hook_created', {
          specVersion: specOf(claimMode),
          correlationId: `hook_${ulid()}`,
          eventData: { token, force: true },
        }),
        inBandAt(claimMode, IN_BAND_SEQ_AT_RUN_CREATION + 1)
      );

    let tClaim: ReturnType<typeof forcedClaim> | undefined;
    let tSettled = false;
    const lockWaiters = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
        )
      ).rows[0].n as number;
    let runLocks = 0;
    let candidateReads = 0;
    // Start T, and return once T waits on a lock (or, with nothing to wait
    // on, has finished).
    const startT = async () => {
      tClaim = forcedClaim(events, t);
      void tClaim.finally(() => {
        tSettled = true;
      });
      for (let i = 0; i < 200 && !tSettled; i++) {
        if ((await lockWaiters()) > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const isRunLock = (text: string) =>
      /"workflow_runs".*for update/is.test(text);
    const isCandidateRead = (text: string) =>
      /select "run_id", "hook_id" from "workflow"\."workflow_hooks"/i.test(
        text
      );
    // Runs before each of C's statements; only the takeover's are gated.
    const gate = async (text: string) => {
      // C has read owner A; let B take the token from A first.
      if (isRunLock(text) && ++runLocks === 1) await forcedClaim(events, b);
      // C restarts: let T lock B's run before C retries.
      if (isCandidateRead(text) && ++candidateReads === 2) await startT();
    };
    class GatedClient extends Client {
      override query(...args: any[]): any {
        const q = args[0] as string | { text?: string };
        const text = typeof q === 'string' ? q : q?.text;
        if (typeof text !== 'string' || typeof args.at(-1) === 'function') {
          return super.query(...(args as [string]));
        }
        return gate(text).then(() => super.query(...(args as [string])));
      }
    }
    const gatedPool = new TestPool({
      connectionString: dbUrl,
      max: 2,
      Client: GatedClient,
    });
    try {
      const cResult = await forcedClaim(
        createEventsStorage(createClient(gatedPool)),
        c,
        mode
      );
      expect(candidateReads).toBeGreaterThanOrEqual(2);
      expect(tClaim).toBeDefined();
      const tResult = await tClaim;
      expect(cResult.event?.eventType).toBe('hook_created');
      expect(tResult?.event?.eventType).toBe('hook_created');
      const rows = await hookRows(token);
      expect(rows).toHaveLength(1);
      expect([c, t]).toContain(rows[0].run_id);
    } finally {
      await gatedPool.end();
    }
  });
});
