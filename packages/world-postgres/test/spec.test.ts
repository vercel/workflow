import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '@workflow/world-testing';
import { beforeAll, test } from 'vitest';

beforeAll(async () => {
  const container = await new PostgreSqlContainer('postgres:15-alpine').start();
  const dbUrl = container.getConnectionUri();
  process.env.WORKFLOW_POSTGRES_URL = dbUrl;
  process.env.DATABASE_URL = dbUrl;

  execSync('pnpm db:push', {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  return () => container.stop();
}, 120_000);

test('smoke', () => {});
createTestSuite('./dist/index.js');
