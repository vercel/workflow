import { expect, test, vi } from 'vitest';
import { createFetcher, startServer } from './util.mjs';

export function nullByte(world: string) {
  test('supports null bytes in step results', { timeout: 12_000 }, async () => {
    const server = await startServer({ world }).then(createFetcher);
    const result = await server.invoke(
      'workflows/null-byte.ts',
      'nullByteWorkflow',
      []
    );
    expect(result.runId).toMatch(/^wrun_.+/);
    await vi.waitFor(
      async () => {
        const run = await server.getRun(result.runId);
        expect(run).toMatchObject<Partial<typeof run>>({
          status: 'completed',
          output: ['null byte \0'],
        });
      },
      {
        interval: 200,
        timeout: 10_000,
      }
    );
  });
}
