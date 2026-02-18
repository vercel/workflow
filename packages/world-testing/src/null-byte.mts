import { expect, test, vi } from 'vitest';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
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
    const run = await vi.waitFor(
      async () => {
        const run = await server.getRun(result.runId);
        expect(run.status).toBe('completed');
        expect(run.output).toBeInstanceOf(Uint8Array);
        return run;
      },
      {
        interval: 200,
        timeout: 10_000,
      }
    );
    const output = await hydrateWorkflowReturnValue(
      run.output!,
      run.runId,
      undefined
    );
    expect(output).toEqual('null byte \0');
  });
}
