import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

/**
 * Proves end-to-end that `start()` called from a workflow *body* (the canonical
 * child-workflow spawn, not from inside a step) records cross-run lineage. The
 * spawned child must carry `$parentRunId`/`$rootRunId` pointing at the parent,
 * while the top-level parent itself carries none.
 */
export function lineage(world: string) {
  test(
    'body-level start() records lineage on the child',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);

      const { runId: parentRunId } = await server.invoke(
        'workflows/lineage.ts',
        'bodyStartsChild',
        []
      );

      const parent = await vi.waitFor(
        async () => {
          const run = await server.getRun(parentRunId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      const childRunId = (await hydrateWorkflowReturnValue(
        parent.output!,
        parent.runId,
        undefined
      )) as string;

      const child = await vi.waitFor(
        async () => {
          const run = await server.getRun(childRunId);
          expect(run.status).toBe('completed');
          return run;
        },
        { interval: 200, timeout: 29_000 }
      );

      // The child started from the parent's body inherits the lineage; the
      // parent is top-level, so it anchors the root to itself.
      expect(child.attributes?.$parentRunId).toBe(parentRunId);
      expect(child.attributes?.$rootRunId).toBe(parentRunId);
      expect(parent.attributes?.$parentRunId).toBeUndefined();
    }
  );
}
