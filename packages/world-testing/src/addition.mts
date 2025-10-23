import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

export function addition(world: string) {
  test('runs an addition', { timeout: 12_000 }, async () => {
    const server = await startServer({ world }).then(createFetcher);
    const result = await server.invoke(
      'workflows/addition.ts',
      'addition',
      [1, 2]
    );
    expect(result.runId).toMatch(/^wrun_.+/);
    await vi.waitFor(
      async () => {
        const run = await server.getRun(result.runId);
        expect(run).toMatchObject<Partial<typeof run>>({
          status: 'completed',
          output: [3],
        });
      },
      {
        interval: 200,
        timeout: 10_000,
      }
    );
  });
}
