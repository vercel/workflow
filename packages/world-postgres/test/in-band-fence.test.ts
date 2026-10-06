import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { EntityConflictError, InBandSupersededError } from '@workflow/errors';
import {
  type AnyEventRequest,
  eventIdToSlot,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  slotToEventId,
} from '@workflow/world';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inBandFenceConformance } from '../../world/src/test-support/in-band-fence-conformance.js';
import { createClient } from '../src/drizzle/index.js';
import {
  createEventsStorage,
  IN_BAND_SEQ_AT_RUN_CREATION,
} from '../src/storage.js';

/**
 * The in-band writer fence for single-orchestrator runs: an in-band write is
 * accepted only at the run's current in-band count, a refusal allocates
 * nothing, out-of-band writes leave the count alone, and of concurrent
 * in-band writers holding the same count exactly one wins. `list` reports
 * the count, read before listing, as `snapshot`.
 */
describe('in-band fence (world-postgres)', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
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
    // Enough connections for the concurrent writers to really overlap.
    pool = new Pool({ connectionString: dbUrl, max: 16 });
    events = createEventsStorage(createClient(pool));
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function createRun(): Promise<string> {
    const runId = `wrun_${ulid()}`;
    await events.create(runId, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'dpl_fence',
        workflowName: 'fence',
        input: new Uint8Array([1]),
      },
    } as AnyEventRequest);
    return runId;
  }

  // The fence behavior every fenced World shares.
  inBandFenceConformance({
    name: 'world-postgres',
    events: () => events,
    newRunId: () => `wrun_${ulid()}`,
    atRunCreation: IN_BAND_SEQ_AT_RUN_CREATION,
    concurrentWriters: 12,
  });

  const runStarted = { eventType: 'run_started', specVersion: SPEC } as const;

  const waitCreated = (correlationId: string) =>
    ({
      eventType: 'wait_created',
      correlationId,
      specVersion: SPEC,
      eventData: { resumeAt: new Date(Date.now() + 60_000) },
    }) as AnyEventRequest;

  const attrSet = (value: string) =>
    ({
      eventType: 'attr_set',
      specVersion: SPEC,
      eventData: {
        changes: [{ key: 'k', value }],
        writer: { type: 'workflow' },
      },
    }) as AnyEventRequest;

  async function load(runId: string) {
    const page = await events.list({ runId });
    return {
      snapshot: page.snapshot,
      slots: page.data.map((event) => eventIdToSlot(event.eventId)),
    };
  }

  test('a stale writer touches no entity row: its refused wait_created leaves the wait free', async () => {
    const runId = await createRun();
    await events.create(runId, runStarted as AnyEventRequest, {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    await expect(
      events.create(runId, waitCreated('wait_x'), {
        inBand: true,
        expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
      })
    ).rejects.toSatisfy((err: unknown) => InBandSupersededError.is(err));
    // The current writer can still create that wait.
    await expect(
      events.create(runId, waitCreated('wait_x'), {
        inBand: true,
        expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION + 1,
      })
    ).resolves.toBeDefined();
  });

  test('a stale run_completed leaves the run running', async () => {
    const runId = await createRun();
    await events.create(runId, runStarted as AnyEventRequest, {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    await expect(
      events.create(
        runId,
        {
          eventType: 'run_completed',
          specVersion: SPEC,
          eventData: { output: new Uint8Array([1]) },
        } as AnyEventRequest,
        { inBand: true, expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION }
      )
    ).rejects.toSatisfy((err: unknown) => InBandSupersededError.is(err));
    const { rows } = await pool.query(
      'select status from workflow.workflow_runs where id = $1',
      [runId]
    );
    expect(rows[0]?.status).toBe('running');
  });

  test('an in-band writer racing out-of-band writers for slots keeps its count exact', async () => {
    // Out-of-band inserts compete for the same next slot; a fenced insert
    // that loses a slot race must put back the count it advanced, so the
    // writer's next in-band write at count + 1 is still accepted.
    for (let round = 0; round < 5; round++) {
      const runId = await createRun();
      const { snapshot } = await load(runId);
      const outOfBand = Array.from({ length: 10 }, (_, i) =>
        events.create(runId, attrSet(`v${i}`), { inBand: false })
      );
      const inBand = events.create(runId, waitCreated('wait_1'), {
        inBand: true,
        expectedSeqInBand: snapshot?.seqInBand,
      });
      await Promise.all([...outOfBand, inBand]);
      const after = await load(runId);
      expect(after.snapshot?.seqInBand).toBe((snapshot?.seqInBand ?? 0) + 1);
      // Dense: every slot from 1 to seq is an event.
      expect(after.slots).toEqual(
        Array.from({ length: after.snapshot?.seq ?? 0 }, (_, i) => i + 1)
      );
      await expect(
        events.create(runId, waitCreated('wait_2'), {
          inBand: true,
          expectedSeqInBand: (snapshot?.seqInBand ?? 0) + 1,
        })
      ).resolves.toBeDefined();
    }
  });

  test('a fenced insert that loses its slot to another writer puts its count back and retries', async () => {
    const runId = await createRun();
    const { snapshot } = await load(runId);
    const nextSlot = (snapshot?.seq ?? 0) + 1;
    // An out-of-band writer holds the next slot in an open transaction, so
    // the fenced insert computes the same slot, advances the count in its
    // CTE, and then waits on the conflict.
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        `insert into workflow.workflow_events (id, type, correlation_id, run_id, spec_version) values ($1, 'wait_completed', 'wait_other', $2, $3)`,
        [slotToEventId(nextSlot), runId, SPEC]
      );
      const fenced = events.create(runId, waitCreated('wait_1'), {
        inBand: true,
        expectedSeqInBand: snapshot?.seqInBand,
      });
      // Let the fenced insert reach the conflict wait before releasing it.
      for (let i = 0; i < 50; i++) {
        const { rows } = await pool.query(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%in_band_fence%'`
        );
        if (rows[0]?.n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query('commit');
      const created = await fenced;
      expect(eventIdToSlot(created.event?.eventId ?? '')).toBe(nextSlot + 1);
    } finally {
      blocker.release();
    }
    const after = await load(runId);
    expect(after.snapshot?.seqInBand).toBe((snapshot?.seqInBand ?? 0) + 1);
    expect(after.slots).toEqual(
      Array.from({ length: nextSlot + 1 }, (_, i) => i + 1)
    );
  });

  test('a refusal by the run or step checks leaves the count alone', async () => {
    const runId = await createRun();
    const stepCreated = {
      eventType: 'step_created',
      // Step ids are unique across runs in this World's steps table.
      correlationId: `step_${ulid()}`,
      specVersion: SPEC,
      eventData: { stepName: 'add', input: new Uint8Array([1]) },
    } as AnyEventRequest;
    await events.create(runId, stepCreated, {
      inBand: true,
      expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
    });
    const before = await load(runId);
    const error = await events
      .create(runId, stepCreated, {
        inBand: true,
        expectedSeqInBand: before.snapshot?.seqInBand,
      })
      .catch((err: unknown) => err);
    expect(EntityConflictError.is(error)).toBe(true);
    expect(await load(runId)).toEqual(before);
  });
});
