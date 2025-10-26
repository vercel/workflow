import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

export function customRunId(world: string) {
  test(
    'custom runId for idempotent workflow creation',
    { timeout: 12_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const customRunId = `wrun_test_${Date.now()}`;

      // First invocation with custom runId
      const result1 = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [5, 10],
        customRunId
      );
      expect(result1.runId).toBe(customRunId);

      // Wait for first workflow to complete
      await vi.waitFor(
        async () => {
          const run = await server.getRun(result1.runId);
          expect(run).toMatchObject<Partial<typeof run>>({
            status: 'completed',
            output: [15],
          });
        },
        {
          interval: 200,
          timeout: 10_000,
        }
      );

      // Second invocation with same runId should return same run (idempotent)
      const result2 = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [99, 99], // Different args
        customRunId
      );
      expect(result2.runId).toBe(customRunId);
      expect(result2.runId).toBe(result1.runId);

      // Verify it's the same run with original arguments (5 + 10 = 15)
      const run2 = await server.getRun(result2.runId);
      expect(run2).toMatchObject<Partial<typeof run2>>({
        status: 'completed',
        output: [15], // Original result, not 198
      });
    }
  );

  test(
    'different runIds create different workflows',
    { timeout: 12_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);
      const runId1 = `wrun_test_1_${Date.now()}`;
      const runId2 = `wrun_test_2_${Date.now()}`;

      // Create two workflows with different runIds
      const result1 = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [1, 2],
        runId1
      );
      const result2 = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [10, 20],
        runId2
      );

      expect(result1.runId).toBe(runId1);
      expect(result2.runId).toBe(runId2);
      expect(result1.runId).not.toBe(result2.runId);

      // Wait for both to complete
      await vi.waitFor(
        async () => {
          const run1 = await server.getRun(result1.runId);
          const run2 = await server.getRun(result2.runId);
          expect(run1).toMatchObject<Partial<typeof run1>>({
            status: 'completed',
            output: [3],
          });
          expect(run2).toMatchObject<Partial<typeof run2>>({
            status: 'completed',
            output: [30],
          });
        },
        {
          interval: 200,
          timeout: 10_000,
        }
      );
    }
  );

  test(
    'auto-generated runId when not provided',
    { timeout: 12_000 },
    async () => {
      const server = await startServer({ world }).then(createFetcher);

      // Invoke without custom runId
      const result = await server.invoke(
        'workflows/addition.ts',
        'addition',
        [3, 4]
      );

      // Should have auto-generated runId with wrun_ prefix
      expect(result.runId).toMatch(/^wrun_/);

      await vi.waitFor(
        async () => {
          const run = await server.getRun(result.runId);
          expect(run).toMatchObject<Partial<typeof run>>({
            status: 'completed',
            output: [7],
          });
        },
        {
          interval: 200,
          timeout: 10_000,
        }
      );
    }
  );
}
