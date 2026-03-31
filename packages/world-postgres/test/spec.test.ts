import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '../../world-testing/dist/src/index.mjs';
import { afterAll, beforeAll, test } from 'vitest';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const workspaceDir = path.resolve(packageDir, '..', '..');

// Skip these tests on Windows since it relies on a docker container
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    execSync('pnpm build', {
      stdio: 'inherit',
      cwd: packageDir,
      env: process.env,
    });

    execFileSync(
      'pnpm',
      [
        '--dir',
        workspaceDir,
        'exec',
        'tsx',
        'packages/world-postgres/src/cli.ts',
      ],
      {
        stdio: 'inherit',
        env: process.env,
      }
    );
  }, 120_000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
  });

  test('smoke', () => {});
  createTestSuite('./dist/index.js');
}
