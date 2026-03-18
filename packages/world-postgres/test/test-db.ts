import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { createClient } from '../src/drizzle/index.js';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

export interface PostgresTestDb {
  container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  sql: ReturnType<typeof postgres>;
  drizzle: ReturnType<typeof createClient>;
  connectionString: string;
  truncateLimits(): Promise<void>;
  close(): Promise<void>;
}

export async function createPostgresTestDb(): Promise<PostgresTestDb> {
  const container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const connectionString = container.getConnectionUri();
  process.env.DATABASE_URL = connectionString;
  process.env.WORKFLOW_POSTGRES_URL = connectionString;

  execSync('pnpm db:push', {
    stdio: 'inherit',
    cwd: packageDir,
    env: process.env,
  });

  const sql = postgres(connectionString, { max: 1 });
  const drizzle = createClient(sql);

  return {
    container,
    sql,
    drizzle,
    connectionString,
    async truncateLimits() {
      await sql`
        truncate table
          workflow.workflow_limit_waiters,
          workflow.workflow_limit_tokens,
          workflow.workflow_limit_leases,
          workflow.workflow_steps,
          workflow.workflow_events,
          workflow.workflow_runs
        restart identity cascade
      `;
    },
    async close() {
      await sql.end();
      await container.stop();
    },
  };
}
