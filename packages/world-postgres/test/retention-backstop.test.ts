import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  type AnyEventRequest,
  IN_BAND_SEQ_AT_RUN_CREATION,
  RETENTION_ATTRIBUTE,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { runOnce } from 'graphile-worker';
import { ulid } from 'ulid';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createPurgeBackstopTask, purgeTask } from '../src/retention.js';
import { createEventsStorage } from '../src/storage.js';
import { TestPool } from './pool.js';

/**
 * Set, the purge that follows a terminal write does nothing, as if the
 * process stopped right after the terminal transaction committed.
 */
const interrupted = vi.hoisted(() => ({ value: false }));
vi.mock('../src/retention.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/retention.js')>();
  return {
    ...actual,
    purgeRunUserDataIfZeroRetention: (
      ...args: Parameters<typeof actual.purgeRunUserDataIfZeroRetention>
    ) =>
      interrupted.value
        ? Promise.resolve()
        : actual.purgeRunUserDataIfZeroRetention(...args),
  };
});

const JOB_PREFIX = 'backstop_test_';

/**
 * The purge of a zero-retention run runs after its terminal write commits.
 * Its backstop, a Graphile job the terminal transaction adds, deletes the
 * run's data when that purge never ran.
 *
 * Run against Graphile's default schema and against a database provisioned
 * only in a custom `GRAPHILE_WORKER_SCHEMA`, where the job must land in that
 * schema: a terminal write that reached for the default one would fail, and
 * a zero-retention run could never finish.
 */
describe.each([
  ['the default Graphile schema', undefined],
  ['a custom Graphile schema', 'custom_graphile'],
] as const)('zero-retention purge backstop (world-postgres, %s)', (_label, graphileSchema) => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  /** Graphile's schema, quoted, as the queries below name it. */
  const graphile = `"${graphileSchema ?? 'graphile_worker'}"`;
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: TestPool;
  let drizzle: ReturnType<typeof createClient>;
  let events: ReturnType<typeof createEventsStorage>;
  const previousSchema = process.env.GRAPHILE_WORKER_SCHEMA;

  beforeAll(async () => {
    if (graphileSchema) process.env.GRAPHILE_WORKER_SCHEMA = graphileSchema;
    else delete process.env.GRAPHILE_WORKER_SCHEMA;
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    // Installs Graphile in `GRAPHILE_WORKER_SCHEMA` only.
    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    pool = new TestPool({ connectionString: dbUrl, max: 4 });
    drizzle = createClient(pool);
    events = createEventsStorage(drizzle, { jobPrefix: JOB_PREFIX });
  }, 120_000);

  beforeEach(async () => {
    interrupted.value = false;
    await pool.query(`DELETE FROM ${graphile}._private_jobs`);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (previousSchema === undefined) delete process.env.GRAPHILE_WORKER_SCHEMA;
    else process.env.GRAPHILE_WORKER_SCHEMA = previousSchema;
  });

  const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;

  /** A started spec 9 run, carrying `attributes`. */
  async function startRun(attributes: Record<string, string>) {
    const runId = `wrun_${ulid()}`;
    await events.create(runId, {
      eventType: 'run_created',
      specVersion: SPEC,
      eventData: {
        deploymentId: 'deployment-1',
        workflowName: 'backstop',
        input: new Uint8Array([1, 2, 3]),
        attributes,
        allowReservedAttributes: true,
      },
    } as AnyEventRequest);
    await events.create(
      runId,
      { eventType: 'run_started', specVersion: SPEC } as AnyEventRequest,
      {
        inBand: true,
        expectedSeqInBand: IN_BAND_SEQ_AT_RUN_CREATION,
      }
    );
    return runId;
  }

  async function complete(runId: string, fenced: boolean) {
    const { snapshot } = await events.list({ runId });
    await events.create(
      runId,
      {
        eventType: 'run_completed',
        specVersion: SPEC,
        eventData: { output: new Uint8Array([7, 8]) },
      } as AnyEventRequest,
      fenced
        ? { inBand: true, expectedSeqInBand: snapshot?.seqInBand }
        : undefined
    );
  }

  async function runState(runId: string) {
    const { rows } = await pool.query(
      `SELECT expired_at, input_cbor, output_cbor FROM workflow.workflow_runs WHERE id = $1`,
      [runId]
    );
    return rows[0] as {
      expired_at: Date | null;
      input_cbor: Buffer | null;
      output_cbor: Buffer | null;
    };
  }

  async function backstopJobs(runId: string) {
    const { rows } = await pool.query(
      `SELECT task_identifier, key, run_at FROM ${graphile}.jobs WHERE key = $1`,
      [`purge:${runId}`]
    );
    return rows as { task_identifier: string; key: string; run_at: Date }[];
  }

  /** Runs every due backstop job, as a runner of the World would. */
  async function runDueBackstops() {
    await pool.query(
      `UPDATE ${graphile}._private_jobs SET run_at = now() WHERE key LIKE 'purge:%'`
    );
    await runOnce({
      pgPool: pool,
      ...(graphileSchema ? { schema: graphileSchema } : {}),
      taskList: { [purgeTask(JOB_PREFIX)]: createPurgeBackstopTask(drizzle) },
    });
  }

  test.skipIf(!graphileSchema)(
    'provisions only the custom schema, and finishes and purges a zero-retention run there',
    async () => {
      const { rows } = await pool.query(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('graphile_worker', $1)`,
        [graphileSchema]
      );
      expect(rows.map((row) => row.nspname)).toEqual([graphileSchema]);

      for (const fenced of [true, false]) {
        const runId = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
        await complete(runId, fenced);
        const state = await runState(runId);
        expect(state.expired_at).toBeInstanceOf(Date);
        expect(state.output_cbor).toBeNull();
        expect(await backstopJobs(runId)).toHaveLength(1);
      }
    }
  );

  for (const fenced of [true, false]) {
    test(`purges a run whose purge never ran after its ${fenced ? 'fenced' : 'unfenced'} terminal write`, async () => {
      const runId = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
      interrupted.value = true;
      await complete(runId, fenced);

      // The terminal write committed, and the purge never ran.
      const before = await runState(runId);
      expect(before.expired_at).toBeNull();
      expect(before.output_cbor).not.toBeNull();
      // Its obligation committed with the terminal write.
      const [job] = await backstopJobs(runId);
      expect(job?.task_identifier).toBe(purgeTask(JOB_PREFIX));
      expect(job.run_at.getTime()).toBeGreaterThan(Date.now());

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await runDueBackstops();
      } finally {
        warn.mockRestore();
      }
      const after = await runState(runId);
      expect(after.expired_at).toBeInstanceOf(Date);
      expect(after.input_cbor).toBeNull();
      expect(after.output_cbor).toBeNull();
      expect(await backstopJobs(runId)).toHaveLength(0);
    });
  }

  test('finds nothing to do once the purge after the terminal write ran', async () => {
    const runId = await startRun({ [RETENTION_ATTRIBUTE]: '0' });
    await complete(runId, true);
    const purged = await runState(runId);
    expect(purged.expired_at).toBeInstanceOf(Date);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDueBackstops();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect((await runState(runId)).expired_at).toEqual(purged.expired_at);
    expect(await backstopJobs(runId)).toHaveLength(0);
  });

  test('adds no backstop for a run that keeps its data', async () => {
    const runId = await startRun({});
    await complete(runId, true);
    expect(await backstopJobs(runId)).toHaveLength(0);
  });
});
