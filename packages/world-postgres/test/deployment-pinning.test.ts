import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
} from '@workflow/world';
import { Pool } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createWorld } from '../src/index.js';
import { MessageData } from '../src/message.js';

/**
 * With a `deploymentId`, a World is pinned the way a Vercel deployment is:
 * its workers claim only the jobs of runs it started, its startup recovery
 * re-enqueues only those runs, and a message for another deployment's run
 * (a hook resumed from a newer deployment) is routed to that deployment's
 * task instead of being run by the wrong code.
 */
describe('deployment pinning', () => {
  if (process.platform === 'win32') {
    test.skip('skipped on Windows since it relies on a docker container', () => {});
    return;
  }

  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  let pool: Pool;
  const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;

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

    pool = new Pool({ connectionString: dbUrl });

    // Point the runner at a loopback port nothing listens on, so it defers
    // its start and every job stays queued where the test can read it.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('no port'));
        });
      });
    });
    process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    if (originalBaseUrl === undefined) {
      delete process.env.WORKFLOW_LOCAL_BASE_URL;
    } else {
      process.env.WORKFLOW_LOCAL_BASE_URL = originalBaseUrl;
    }
    await pool?.end();
    await container?.stop();
  });

  const runCreated = (deploymentId: string) => ({
    eventType: 'run_created' as const,
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId,
      workflowName: 'deployment-pinning-test',
      input: new Uint8Array([1]),
    },
  });

  /** Jobs on a Graphile task: run id and named queue, from the payloads. */
  async function queued(task: string) {
    const { rows } = await pool.query<{
      payload: unknown;
      queue_name: string | null;
    }>(
      `SELECT jobs.payload, queues.queue_name
         FROM graphile_worker._private_jobs AS jobs
         JOIN graphile_worker._private_tasks AS tasks ON tasks.id = jobs.task_id
         LEFT JOIN graphile_worker._private_job_queues AS queues ON queues.id = jobs.job_queue_id
         WHERE tasks.identifier = $1`,
      [task]
    );
    return rows.map(({ payload, queue_name }) => ({
      runId: JSON.parse(MessageData.parse(payload).data.toString())
        .runId as string,
      queueName: queue_name,
    }));
  }

  test('reports its deployment and declares deployment affinity', async () => {
    const pinned = createWorld({
      pool,
      jobPrefix: 'svc_',
      deploymentId: 'svc@v1',
    });
    const unpinned = createWorld({ pool, jobPrefix: 'svc_' });
    try {
      expect(await pinned.getDeploymentId()).toBe('svc@v1');
      expect(pinned.capabilities?.deploymentAffinity).toBe(true);
      expect(await unpinned.getDeploymentId()).toBe('postgres');
      expect(unpinned.capabilities?.deploymentAffinity).toBeUndefined();
    } finally {
      await pinned.close();
      await unpinned.close();
    }
  });

  test('routes a message to the deployment its run is pinned to', async () => {
    const v1 = createWorld({ pool, jobPrefix: 'route_', deploymentId: 'v1' });
    const v2 = createWorld({ pool, jobPrefix: 'route_', deploymentId: 'v2' });
    const oldRun = `wrun_${ulid()}`;
    const newRun = `wrun_${ulid()}`;
    const singleOrchestratorRun = `wrun_${ulid()}`;
    const queueName = '__wkf_workflow_deployment-pinning-test' as const;
    try {
      await v2.queue(
        queueName,
        { runId: oldRun, runSpecVersion: SPEC_VERSION_CURRENT },
        { deploymentId: 'v1' }
      );
      await v2.queue(
        queueName,
        { runId: newRun, runSpecVersion: SPEC_VERSION_CURRENT },
        { deploymentId: 'v2' }
      );
      // A single-orchestrator run's deliveries are serialized in a named
      // queue, which has to be the pinned deployment's too.
      await v2.queue(
        queueName,
        {
          runId: singleOrchestratorRun,
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        },
        { deploymentId: 'v1' }
      );

      expect(await queued('route_v1_flows')).toEqual(
        expect.arrayContaining([
          { runId: oldRun, queueName: null },
          {
            runId: singleOrchestratorRun,
            queueName: `route_v1_flows:${singleOrchestratorRun}:executor`,
          },
        ])
      );
      expect(await queued('route_v2_flows')).toEqual([
        { runId: newRun, queueName: null },
      ]);
    } finally {
      await v1.close();
      await v2.close();
    }
  });

  test('routes an unpinned run’s message to the unpinned task, from a pinned or unpinned World', async () => {
    // A run started before `deploymentId` was set records `postgres`, and its
    // jobs are on the unpinned task, which a process without `deploymentId`
    // still claims.
    const pinned = createWorld({ pool, jobPrefix: 'mix_', deploymentId: 'v1' });
    const unpinned = createWorld({ pool, jobPrefix: 'mix_' });
    const unpinnedRun = `wrun_${ulid()}`;
    const pinnedRun = `wrun_${ulid()}`;
    const queueName = '__wkf_workflow_deployment-pinning-test' as const;
    try {
      await pinned.queue(
        queueName,
        {
          runId: unpinnedRun,
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        },
        { deploymentId: 'postgres' }
      );
      // And an unpinned process sends a pinned run's message to its
      // deployment, rather than running it itself.
      await unpinned.queue(
        queueName,
        { runId: pinnedRun, runSpecVersion: SPEC_VERSION_CURRENT },
        { deploymentId: 'v1' }
      );
      expect(await queued('mix_flows')).toEqual([
        {
          runId: unpinnedRun,
          queueName: `mix_flows:${unpinnedRun}:executor`,
        },
      ]);
      expect(await queued('mix_v1_flows')).toEqual([
        { runId: pinnedRun, queueName: null },
      ]);
      expect(await queued('mix_postgres_flows')).toEqual([]);
    } finally {
      await pinned.close();
      await unpinned.close();
    }
  });

  test('enqueues a spec 9 run with the longest deploymentId its jobPrefix allows', async () => {
    // Graphile Worker limits queue names to 128 characters; the run's queue
    // `${prefix}flows:${runId}:executor` is the longest name.
    const deploymentId = 'x'.repeat(72);
    const world = createWorld({ pool, deploymentId });
    const runId = `wrun_${ulid()}`;
    try {
      await world.queue(
        '__wkf_workflow_deployment-pinning-test',
        { runId, runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR },
        { deploymentId }
      );
      const [job] = await queued(`workflow_${deploymentId}_flows`);
      expect(job?.queueName).toHaveLength(128);
    } finally {
      await world.close();
    }
  });

  test('recovers only the runs of its own deployment', async () => {
    const v1 = createWorld({ pool, jobPrefix: 'rec_', deploymentId: 'v1' });
    const v2 = createWorld({ pool, jobPrefix: 'rec_', deploymentId: 'v2' });
    const runV1 = `wrun_${ulid()}`;
    const runV2 = `wrun_${ulid()}`;
    await v1.events.create(runV1, runCreated('v1'));
    await v2.events.create(runV2, runCreated('v2'));
    try {
      await v2.start();
      expect((await queued('rec_v2_flows')).map((j) => j.runId)).toEqual([
        runV2,
      ]);
      expect(await queued('rec_v1_flows')).toEqual([]);

      await v1.start();
      expect((await queued('rec_v1_flows')).map((j) => j.runId)).toEqual([
        runV1,
      ]);
    } finally {
      await v1.close();
      await v2.close();
    }
  });

  test.each([
    '',
    'has space',
    'a/b',
    // Reserved: the deployment id of unpinned runs.
    'postgres',
    // Past what fits Graphile's 128 character names with `bad_` (77).
    'x'.repeat(78),
  ])('rejects deploymentId %j', (deploymentId) => {
    expect(() =>
      createWorld({ pool, jobPrefix: 'bad_', deploymentId })
    ).toThrow(/Invalid Postgres World deploymentId/);
  });

  test('bounds deploymentId by what fits its jobPrefix', async () => {
    const longest = createWorld({
      pool,
      jobPrefix: 'bad_',
      deploymentId: 'x'.repeat(77),
    });
    await longest.close();
    expect(() => createWorld({ pool, deploymentId: 'x'.repeat(73) })).toThrow(
      /at most 72 characters/
    );
  });
});
