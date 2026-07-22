import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

export function eventLimit(world: string) {
  test(
    'fails a runaway run at the server-supplied event limit',
    { timeout: 59_000 },
    async () => {
      // Low ceiling to trip it fast.
      const server = await startServer({
        world,
        env: { WORKFLOW_MAX_EVENTS: '10' },
      }).then(createFetcher);

      const result = await server.invoke(
        'workflows/event-limit.ts',
        'runawayWorkflow',
        []
      );
      expect(result.runId).toMatch(/^wrun_.+/);

      const run = await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run.status).toBe('failed');
          return run;
        },
        {
          interval: 200,
          timeout: 50_000,
        }
      );
      expect(run.error?.code).toBe('MAX_EVENTS_EXCEEDED');
    }
  );
}
