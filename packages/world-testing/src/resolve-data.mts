import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

/**
 * `resolveData: 'skip-step-inputs'` is safe to ignore, but not to misread.
 *
 * The runtime replays with it, and a World that doesn't implement it must
 * treat it as `'all'`. The failure mode is quiet: a World that tests
 * `resolveData === 'all'` reads it as `'none'` and strips every payload, step
 * results included, so each replay hands the workflow `undefined` where a
 * step result should be. A World that validates `resolveData` against
 * `['none', 'all']` rejects the read and fails the run outright.
 *
 * Either answer is conformant for the step inputs themselves: returned (the
 * World ignored the mode) or left out (it implemented it). Everything else
 * must match what `'all'` returns.
 */
export function resolveData(world: string) {
  test(
    "resolveData 'skip-step-inputs' returns every payload but step inputs",
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const result = await server.invoke(
        'workflows/addition.ts',
        'addTenWorkflow',
        [1]
      );
      // A World that misreads the mode fails here already: the runtime
      // replays with it, so the steps' results come back stripped.
      await vi.waitFor(
        async () => {
          expect((await server.getRun(result.runId)).status).toBe('completed');
        },
        { interval: 200, timeout: 25_000 }
      );

      const all = await server.getEvents(result.runId, 'all');
      const skipped = await server.getEvents(result.runId, 'skip-step-inputs');

      // The same log, event for event.
      expect(
        skipped.map(({ eventId, eventType }) => ({ eventId, eventType }))
      ).toEqual(all.map(({ eventId, eventType }) => ({ eventId, eventType })));
      // The log has step inputs to omit, so the case below is not vacuous.
      expect(
        all.some((e) => e.eventType === 'step_created' && e.payloadDigest)
      ).toBe(true);

      for (const [index, event] of all.entries()) {
        const other = skipped[index];
        const isStepInput =
          event.eventType === 'step_created' ||
          event.eventType === 'step_started';
        if (isStepInput) {
          // Returned unchanged, or left out; never something else.
          expect([event.payloadDigest, null]).toContain(other.payloadDigest);
        } else {
          // Step results, the run input and output: exactly as with 'all'.
          expect(other.payloadDigest).toBe(event.payloadDigest);
        }
      }
    }
  );
}
