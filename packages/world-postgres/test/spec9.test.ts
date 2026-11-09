import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { createTestSuite } from '@workflow/world-testing';
import {
  createFetcher,
  startServer,
} from '@workflow/world-testing/dist/src/util.mjs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

// The shared suite over world-postgres pinned to spec 9, the default, which
// the runtime drives with its single orchestrator: the per-run named queue,
// coalesced re-runs and the LISTEN/NOTIFY live feed. `spec.test.ts` runs it
// at spec 8 for backwards compatibility.
if (process.platform === 'win32') {
  test.skip('skipped on Windows since it relies on a docker container', () => {});
} else {
  let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
  const previousSpecVersion = process.env.WORKFLOW_SPEC_VERSION;

  beforeAll(async () => {
    process.env.WORKFLOW_SPEC_VERSION = String(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    container = await new PostgreSqlContainer('postgres:15-alpine').start();
    const dbUrl = container.getConnectionUri();
    process.env.WORKFLOW_POSTGRES_URL = dbUrl;
    process.env.DATABASE_URL = dbUrl;

    execSync('pnpm db:push', {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
  }, 120_000);

  afterAll(async () => {
    if (previousSpecVersion === undefined)
      delete process.env.WORKFLOW_SPEC_VERSION;
    else process.env.WORKFLOW_SPEC_VERSION = previousSpecVersion;
    if (container) {
      await container.stop();
    }
  });

  test('stamps and completes a spec 9 run', { timeout: 60_000 }, async () => {
    const server = await startServer({ world: './dist/index.js' }).then(
      createFetcher
    );
    const result = await server.invoke(
      'workflows/addition.ts',
      'addition',
      [1, 2]
    );
    const run = await vi.waitFor(
      async () => {
        const run = await server.getRun(result.runId);
        expect(run.status).toBe('completed');
        return run;
      },
      { interval: 200, timeout: 50_000 }
    );
    expect(run.specVersion).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
  });

  createTestSuite('./dist/index.js');
}
