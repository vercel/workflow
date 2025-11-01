import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import { beforeAll, test } from 'vitest';

beforeAll(async () => {
  const pg = await new PostgreSqlContainer('postgres:15-alpine').start();
  const redis = await new RedisContainer('redis:7-alpine').start();
  const dbUrl = pg.getConnectionUri();
  const redisUrl = `redis://${redis.getHost()}:${redis.getFirstMappedPort()}`;
  process.env.WORKFLOW_POSTGRES_URL = dbUrl;
  process.env.DATABASE_URL = dbUrl;
  process.env.WORKFLOW_REDIS_URL = redisUrl;

  execSync('pnpm db:push', {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}, 120_000);

test('smoke', () => {});
createTestSuite('./dist/index.js');
