import { expect, test, vi } from 'vitest';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import { createFetcher, startServer } from './util.mjs';

export function errors(world: string) {
  test('retriable and fatal errors', { timeout: 59_000 }, async () => {
    const server = await startServer({ world }).then(createFetcher);
    const result = await server.invoke(
      'workflows/retriable-and-fatal.ts',
      'retryableAndFatalErrorWorkflow',
      []
    );
    expect(result.runId).toMatch(/^wrun_.+/);
    const run = await vi.waitFor(
      async () => {
        const run = await server.getRun(result.runId);
        expect(run).toMatchObject<Partial<typeof run>>({
          status: 'completed',
        });
        return run;
      },
      {
        interval: 200,
        timeout: 50_000,
      }
    );
    const output = (await hydrateWorkflowReturnValue(
      run.output!,
      run.runId,
      undefined
    )) as any;
    expect(output).toEqual({
      gotFatalError: true,
      retryableResult: {
        attempt: 2,
        duration: expect.any(Number),
        stepStartedAt: expect.any(Date),
      },
    });
    expect(output.retryableResult.duration).toBeGreaterThanOrEqual(2000);
  });
}
