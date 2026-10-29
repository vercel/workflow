import { mintedSpecVersion } from '@workflow/world';
import { expect, test, vi } from 'vitest';
import { createTestSuite } from '../src/index.mjs';
import { createFetcher, startServer } from '../src/util.mjs';

createTestSuite('local');

// Spec 8 unless the environment opts in with `WORKFLOW_SPEC_VERSION=9`;
// `embedded-spec9.test.ts` always opts in.
test(
  'stamps the version the Local World mints',
  { timeout: 30_000 },
  async () => {
    const server = await startServer({ world: 'local' }).then(createFetcher);
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
      { interval: 200, timeout: 25_000 }
    );
    expect(run.specVersion).toBe(
      mintedSpecVersion(process.env, { inBandFence: true })
    );
  }
);
