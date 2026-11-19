import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RETENTION_ATTRIBUTE, SPEC_VERSION_CURRENT } from '@workflow/world';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils, runOnce, type WorkerUtils } from 'graphile-worker';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../src/drizzle/index.js';
import { createWorld } from '../src/index.js';
import {
  countUnpinnedRuns,
  createBacklogEndpoints,
  getDeploymentBacklog,
  listActiveDeployments,
} from '../src/kubernetes/index.js';
import { createPurgeBackstopTask, worldPurgeTask } from '../src/retention.js';
import { TestPool } from './pool.js';

/**
 * The backlog of pinned deployments, which the Helm chart's KEDA triggers
 * and prune job read, against a real database: runs as world-postgres stamps
 * them, and jobs on the tasks it names.
 */
describe.skipIf(process.platform === 'win32')(
  'Kubernetes backlog (real database)',
  () => {
    let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
    let pool: TestPool;
    let utils: WorkerUtils;
    const config = { jobPrefix: 'kb_' };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:15-alpine').start();
      pool = new TestPool({
        connectionString: container.getConnectionUri(),
        max: 10,
      });
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../src/drizzle/migrations', import.meta.url)
        ),
        migrationsTable: 'workflow_migrations',
        migrationsSchema: 'workflow_drizzle',
      });
      utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();

      // Runs as each World stamps them.
      const create = async (
        worldConfig: { jobPrefix: string; deploymentId?: string },
        count: number
      ) => {
        const world = createWorld({ pool, ...worldConfig });
        const runIds: string[] = [];
        for (let n = 0; n < count; n++) {
          const runId = `wrun_${ulid()}`;
          await world.events.create(runId, {
            eventType: 'run_created',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              deploymentId: worldConfig.deploymentId ?? 'postgres',
              workflowName: 'backlog-test',
              input: new Uint8Array([1]),
            },
          });
          runIds.push(runId);
        }
        await world.close?.();
        return runIds;
      };
      await create({ jobPrefix: 'kb_', deploymentId: 'v1' }, 2);
      const [finished] = await create(
        { jobPrefix: 'kb_', deploymentId: 'v2' },
        1
      );
      await pool.query(
        "UPDATE workflow.workflow_runs SET status = 'completed' WHERE id = $1",
        [finished]
      );
      await create({ jobPrefix: 'kb_', deploymentId: 'svc@abc' }, 3);
      // Not this World's: unpinned, and another application's.
      await create({ jobPrefix: 'kb_' }, 1);
      await create({ jobPrefix: 'other_', deploymentId: 'v1' }, 1);

      // Due jobs on v1's tasks, one not due yet, and a due job for drained v2.
      await utils.addJob('kb_v1_flows', {});
      await utils.addJob('kb_v1_flows_executor', {});
      await utils.addJob(
        'kb_v1_flows',
        {},
        {
          runAt: new Date(Date.now() + 3_600_000),
        }
      );
      await utils.addJob('kb_v2_flows', {});
    }, 120_000);

    afterAll(async () => {
      await utils?.release();
      await pool?.end();
      await container?.stop();
    });

    it('reports unfinished runs and due jobs, and wants workers only while runs are unfinished', async () => {
      await expect(getDeploymentBacklog(pool, config, 'v1')).resolves.toEqual({
        deploymentId: 'v1',
        activeRuns: 2,
        dueDeliveries: 2,
        pendingPurges: 0,
        wanted: 2,
      });
      // A due backstop of a finished run does not wake a drained deployment.
      await expect(getDeploymentBacklog(pool, config, 'v2')).resolves.toEqual({
        deploymentId: 'v2',
        activeRuns: 0,
        dueDeliveries: 1,
        pendingPurges: 0,
        wanted: 0,
      });
      await expect(
        getDeploymentBacklog(pool, config, 'never-deployed')
      ).resolves.toMatchObject({ activeRuns: 0, wanted: 0 });
    });

    it('counts the unfinished runs started without a deployment ID', async () => {
      await expect(countUnpinnedRuns(pool, config)).resolves.toBe(1);
      await expect(
        countUnpinnedRuns(pool, { jobPrefix: 'other_' })
      ).resolves.toBe(0);
    });

    it('lists the pinned deployments with unfinished runs, and no other application’s', async () => {
      await expect(listActiveDeployments(pool, config)).resolves.toEqual(
        new Map([
          ['v1', 2],
          ['svc@abc', 3],
        ])
      );
    });

    it('serves backlogs and versions, mapping versions to deployment IDs', async () => {
      const endpoints = createBacklogEndpoints({ pool, config });
      await expect(
        endpoints.respond('GET', '/internal/workflow/backlog/v1')
      ).resolves.toEqual({
        status: 200,
        body: { version: 'v1', activeRuns: 2, dueDeliveries: 2, wanted: 2 },
      });
      const versions = await endpoints.fetch(
        new Request('http://svc/internal/workflow/versions')
      );
      expect(versions?.status).toBe(200);
      await expect(versions?.json()).resolves.toEqual({
        versions: { v1: 2, 'svc@abc': 3 },
        unpinnedRuns: 1,
      });
      await expect(
        endpoints.respond('POST', '/internal/workflow/versions')
      ).resolves.toMatchObject({ status: 405 });
      // `postgres` is reserved for unpinned runs, and `/` names no version.
      // A malformed escape is refused, not thrown.
      for (const path of ['postgres', 'a%2Fb', '%E0']) {
        await expect(
          endpoints.respond('GET', `/internal/workflow/backlog/${path}`)
        ).resolves.toMatchObject({ status: 400 });
      }
      await expect(endpoints.respond('GET', '/other')).resolves.toBeUndefined();
      expect(
        await endpoints.fetch(new Request('http://svc/healthz'))
      ).toBeUndefined();

      // Deployment IDs of the form `<service>@<tag>`, with workers labeled
      // by the tag.
      const mapped = createBacklogEndpoints({
        pool,
        config,
        basePath: '/wf/',
        deploymentIdOf: (version) => `svc@${version}`,
        versionOf: (id) =>
          id.startsWith('svc@') ? id.slice('svc@'.length) : undefined,
      });
      await expect(
        mapped.respond('GET', '/wf/backlog/abc')
      ).resolves.toMatchObject({
        status: 200,
        body: { version: 'abc', activeRuns: 3 },
      });
      await expect(mapped.respond('GET', '/wf/versions')).resolves.toEqual({
        status: 200,
        body: { versions: { abc: 3 }, unpinnedRuns: 1 },
      });
    });

    // Last: it adds a deployment, and drains it again before it ends.
    it("keeps a drained deployment until its finished run's purge backstop has run", async () => {
      const world = createWorld({ pool, jobPrefix: 'kb_', deploymentId: 'v3' });
      const runId = `wrun_${ulid()}`;
      try {
        await world.events.create(runId, {
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: {
            deploymentId: 'v3',
            workflowName: 'backlog-test',
            input: new Uint8Array([1]),
            attributes: { [RETENTION_ATTRIBUTE]: '0' },
            allowReservedAttributes: true,
          },
        });
        await world.events.create(runId, {
          eventType: 'run_started',
          specVersion: SPEC_VERSION_CURRENT,
        });
        await world.events.create(runId, {
          eventType: 'run_completed',
          specVersion: SPEC_VERSION_CURRENT,
          eventData: { output: new Uint8Array([2]) },
        });
      } finally {
        await world.close?.();
      }

      // The backstop is on the task every deployment's runner claims.
      const { rows } = await pool.query(
        `SELECT task_identifier FROM graphile_worker.jobs WHERE key = $1`,
        [`purge:${runId}`]
      );
      expect(rows).toEqual([{ task_identifier: worldPurgeTask(config) }]);
      expect(worldPurgeTask(config)).toBe('kb_purge');

      // The run finished, but v3 keeps its workers until the backstop ran.
      await expect(getDeploymentBacklog(pool, config, 'v3')).resolves.toEqual({
        deploymentId: 'v3',
        activeRuns: 1,
        dueDeliveries: 0,
        pendingPurges: 1,
        wanted: 0,
      });
      await expect(listActiveDeployments(pool, config)).resolves.toEqual(
        new Map([
          ['v1', 2],
          ['svc@abc', 3],
          ['v3', 1],
        ])
      );

      // Once due, it wakes v3's workers.
      await pool.query(
        `UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1`,
        [`purge:${runId}`]
      );
      await expect(
        getDeploymentBacklog(pool, config, 'v3')
      ).resolves.toMatchObject({ activeRuns: 1, dueDeliveries: 1, wanted: 1 });

      // A runner without v3's tasks runs it: the task is the World's.
      await runOnce({
        pgPool: pool,
        taskList: {
          [worldPurgeTask(config)]: createPurgeBackstopTask(createClient(pool)),
        },
      });
      await expect(getDeploymentBacklog(pool, config, 'v3')).resolves.toEqual({
        deploymentId: 'v3',
        activeRuns: 0,
        dueDeliveries: 0,
        pendingPurges: 0,
        wanted: 0,
      });
      await expect(listActiveDeployments(pool, config)).resolves.toEqual(
        new Map([
          ['v1', 2],
          ['svc@abc', 3],
        ])
      );
    });
  }
);
