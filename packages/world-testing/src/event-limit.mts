import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

export function eventLimit(world: string) {
  // Cover enforcement end-to-end under both configs (turbo is the production
  // default). Against the local world these don't isolate the turbo run_started
  // threading — a non-turbo continuation backfills the ceiling regardless — but
  // they guard that a runaway run fails under each.
  for (const turbo of ['1', '0'] as const) {
    test(
      `fails a runaway run at the server-supplied event limit (turbo=${turbo})`,
      { timeout: 59_000 },
      async () => {
        // Low ceiling to trip it fast.
        const server = await startServer({
          world,
          env: { WORKFLOW_MAX_EVENTS: '10', WORKFLOW_TURBO: turbo },
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
        expect(run.errorCode).toBe('MAX_EVENTS_EXCEEDED');
      }
    );
  }
}
