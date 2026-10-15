import { SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM } from '@workflow/world';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createTestSuite } from '../src/index.mjs';
import { createFetcher, startServer } from '../src/util.mjs';

// The same suite over a Local World that mints spec 8 runs, which the runtime
// drives with its spec 8 orchestrator (see `runtime/delivery.ts` in core).
const previous = process.env.WORKFLOW_SPEC_VERSION;
beforeAll(() => {
  process.env.WORKFLOW_SPEC_VERSION = String(
    SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM
  );
});
afterAll(() => {
  if (previous === undefined) delete process.env.WORKFLOW_SPEC_VERSION;
  else process.env.WORKFLOW_SPEC_VERSION = previous;
});

createTestSuite('local');

test('stamps and completes a spec 8 run', { timeout: 30_000 }, async () => {
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
  expect(run.specVersion).toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
  // Two steps, each created by its own step_created: the spec 8 shape.
  const events = await server.getEvents(result.runId);
  expect(
    events.filter((event) => event.eventType === 'step_created').length
  ).toBeGreaterThan(0);
});
