import { EntityConflictError } from '@workflow/errors';
import type { Storage, World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import { Pool } from 'pg';
import type { PostgresWorldConfig } from './config.js';
import { createClient, type Drizzle } from './drizzle/index.js';
import { createQueue } from './queue.js';
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from './storage.js';
import { createStreamer } from './streamer.js';

function createStorage(drizzle: Drizzle): Storage {
  return {
    runs: createRunsStorage(drizzle),
    events: createEventsStorage(drizzle),
    hooks: createHooksStorage(drizzle),
    steps: createStepsStorage(drizzle),
  };
}

function getDefaultMaxPoolSize(): number | undefined {
  const parsed = parseInt(
    process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE || '',
    10
  );

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getDefaultConnectionString(): string {
  return (
    process.env.WORKFLOW_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://world:world@localhost:5432/world'
  );
}

export function createWorld(
  config: PostgresWorldConfig = {
    connectionString: getDefaultConnectionString(),
    jobPrefix: process.env.WORKFLOW_POSTGRES_JOB_PREFIX,
    queueConcurrency:
      parseInt(process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY || '50', 10) ||
      50,
    applicationManagedShutdown:
      process.env.WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN === '1',
  }
): World & { start(): Promise<void> } {
  const maxPoolSize = config.maxPoolSize ?? getDefaultMaxPoolSize();
  const pool =
    config.pool ||
    new Pool({
      connectionString: config.connectionString || getDefaultConnectionString(),
      ...(maxPoolSize !== undefined ? { max: maxPoolSize } : {}),
    });

  const drizzle = createClient(pool);
  const queue = createQueue(config, pool);
  const storage = createStorage(drizzle);
  const streamer = createStreamer(pool, drizzle);

  return {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { runTreePurge: true },
    ...storage,
    ...streamer,
    ...queue,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: transaction owns discovery, fencing, and deletion
    async purgeRunTree(rootRunId, options) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const selector = options?.descendantAttribute;
        if (selector !== undefined) {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1 || chr(31) || $2, 1))',
            [selector.key, selector.value]
          );
        }
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1, 0))',
          [rootRunId]
        );

        const root = await client.query<{ id: string }>(
          'select id from workflow.workflow_runs where id = $1',
          [rootRunId]
        );
        if (root.rowCount === 0) {
          const prior = await client.query<{ run_id: string }>(
            `select run_id
               from workflow.workflow_run_tombstones
              where root_run_id = $1
              order by run_id`,
            [rootRunId]
          );
          if (prior.rowCount !== 0) {
            await deleteRunTreeEntities(prior.rows.map((row) => row.run_id));
            await client.query('commit');
            return {
              purgedRunCount: prior.rows.length,
              status: 'purged' as const,
            };
          }
          await client.query('commit');
          return { purgedRunCount: 0, status: 'absent' as const };
        }

        const selected = selector
          ? await client.query<{ id: string; status: string }>(
              `select id, status
                 from workflow.workflow_runs
                where id = $1 or attributes ->> $2 = $3
                order by id`,
              [rootRunId, selector.key, selector.value]
            )
          : await client.query<{ id: string; status: string }>(
              `select id, status
                 from workflow.workflow_runs
                where id = $1
                order by id`,
              [rootRunId]
            );

        for (const run of selected.rows) {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended($1, 0))',
            [run.id]
          );
        }
        const runIds = selected.rows.map((run) => run.id);
        const locked = await client.query<{ id: string; status: string }>(
          `select id, status
             from workflow.workflow_runs
            where id = any($1::varchar[])
            order by id
            for update`,
          [runIds]
        );
        if (
          locked.rows.some(
            (run) => run.status === 'pending' || run.status === 'running'
          )
        ) {
          await client.query('rollback');
          throw new EntityConflictError(
            `Workflow run tree ${rootRunId} is still active`
          );
        }

        if (selector !== undefined) {
          await client.query(
            `insert into workflow.workflow_tree_fences
               (attribute_key, attribute_value, root_run_id)
             values ($1, $2, $3)
             on conflict (attribute_key, attribute_value) do update
               set root_run_id = excluded.root_run_id`,
            [selector.key, selector.value, rootRunId]
          );
        }
        await client.query(
          `insert into workflow.workflow_run_tombstones
             (run_id, root_run_id)
           select unnest($1::varchar[]), $2
           on conflict (run_id) do nothing`,
          [runIds, rootRunId]
        );
        await deleteRunTreeEntities(runIds);
        await client.query('commit');
        return {
          purgedRunCount: runIds.length,
          status: 'purged' as const,
        };

        async function deleteRunTreeEntities(runIds: string[]) {
          await client.query(
            'delete from workflow.workflow_stream_chunks where run_id = any($1::varchar[])',
            [runIds]
          );
          await client.query(
            'delete from workflow.workflow_waits where run_id = any($1::varchar[])',
            [runIds]
          );
          await client.query(
            'delete from workflow.workflow_hooks where run_id = any($1::varchar[])',
            [runIds]
          );
          await client.query(
            'delete from workflow.workflow_steps where run_id = any($1::varchar[])',
            [runIds]
          );
          await client.query(
            'delete from workflow.workflow_events where run_id = any($1::varchar[])',
            [runIds]
          );
          await client.query(
            'delete from workflow.workflow_runs where id = any($1::varchar[])',
            [runIds]
          );
        }
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    ...(config.streamFlushIntervalMs !== undefined && {
      streamFlushIntervalMs: config.streamFlushIntervalMs,
    }),
    async start() {
      await queue.start();
      await reenqueueActiveRuns(
        storage.runs,
        queue.queue,
        'world-postgres',
        config.namespace
      );
    },
    async close() {
      await queue.close();
      await streamer.close();
      if (pool !== config.pool) {
        await pool.end();
      }
    },
  };
}

// Re-export schema for users who want to extend or inspect the database schema
export type { PostgresWorldConfig } from './config.js';
export * from './drizzle/schema.js';
