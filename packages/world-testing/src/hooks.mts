import { expect, test, vi } from 'vitest';
import { hydrateWorkflowReturnValue } from '@workflow/core/serialization';
import type { Hook } from '../workflows/hooks.ts';
import { jsonlines } from './jsonlines.mjs';
import { createFetcher, startServer } from './util.mjs';

export function hooks(world: string) {
  test('hooks', { timeout: 60_000 }, async () => {
    const server = await startServer({ world }).then(createFetcher);
    const token = Date.now().toString(36);
    const customData = `my-custom-data-${token}`;
    const result = await server.invoke(
      'workflows/hooks.ts',
      'collectWithHook',
      [token, customData]
    );
    expect(result.runId).toMatch(/^wrun_.+/);
    const readable = await server.getReadable(result.runId);
    const events = jsonlines(readable);
    const hookCreated = Promise.withResolvers<void>();
    const hookResumedEvents = [] as unknown[];

    (async () => {
      for await (const obj of events) {
        if (obj?.event === 'hookCreated') {
          hookCreated.resolve();
          continue;
        }

        if (obj?.event === 'hookResumed') {
          hookResumedEvents.push(obj.payload);
          continue;
        }

        console.log('unhandled event', obj);
      }
    })().catch(() => {
      // ignore errors for reading stream
    });

    await hookCreated.promise;

    (async () => {
      await server.resumeHook<typeof Hook>(token, {
        data: 'first payload',
      });
      await server.resumeHook<typeof Hook>(token, {
        data: 'second payload',
      });
      await server.resumeHook<typeof Hook>(token, {
        data: 'third payload',
        done: true,
      });
    })();

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
        timeout: 59_000,
      }
    );

    const output = await hydrateWorkflowReturnValue(run.output!, [], run.runId);
    expect(output).toEqual({
      collected: [
        {
          data: 'first payload',
          metadata: { customData },
        },
        {
          data: 'second payload',
          metadata: { customData },
        },
        {
          data: 'third payload',
          metadata: { customData },
          done: true,
        },
      ],
    });
  });
}
