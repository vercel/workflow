import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

type Fetcher = ReturnType<typeof createFetcher>;

const awaitCompleted = (server: Fetcher, runId: string) =>
  vi.waitFor(
    async () => {
      const run = await server.getRun(runId);
      expect(run.status).toBe('completed');
      return run;
    },
    { interval: 200, timeout: 10_000 }
  );

// The runId a run spawned, read from its return value.
const spawnedRunId = (run: { output?: unknown; runId: string }) =>
  hydrateWorkflowReturnValue(
    run.output!,
    run.runId,
    undefined
  ) as Promise<string>;

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

      const parent = await awaitCompleted(server, parentRunId);
      const child = await awaitCompleted(server, await spawnedRunId(parent));

      // The child started from the parent's body inherits the lineage; the
      // parent is top-level, so it anchors the root to itself.
      expect(child.attributes?.$parentRunId).toBe(parentRunId);
      expect(child.attributes?.$rootRunId).toBe(parentRunId);
      expect(parent.attributes?.$parentRunId).toBeUndefined();
    }
  );

  test(
    'a three-level chain groups every run under the same root',
    { timeout: 30_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);

      // Each run returns the id of the one it spawned.
      const { runId: rootRunId } = await server.invoke(
        'workflows/lineage.ts',
        'chainRoot',
        []
      );

      const root = await awaitCompleted(server, rootRunId);
      const middleRunId = await spawnedRunId(root);
      const middle = await awaitCompleted(server, middleRunId);
      const leaf = await awaitCompleted(server, await spawnedRunId(middle));

      // Root is top-level.
      expect(root.attributes?.$parentRunId).toBeUndefined();
      expect(root.attributes?.$rootRunId).toBeUndefined();

      // Middle: root and parent coincide at depth two.
      expect(middle.attributes?.$parentRunId).toBe(rootRunId);
      expect(middle.attributes?.$rootRunId).toBe(rootRunId);

      // Leaf: parent is the middle, but root is still the chain root.
      expect(leaf.attributes?.$parentRunId).toBe(middleRunId);
      expect(leaf.attributes?.$rootRunId).toBe(rootRunId);
    }
  );
}
