import { describe, expect, it, vi } from 'vitest';
import { __builtin_response_read_chunk } from '../../workflow/src/internal/builtins.js';
import { isClientDisconnectError } from './runtime/step-streams.js';
import { setWorld } from './runtime/world.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from './serialization.js';
import { STREAM_NAME_SYMBOL, STREAM_TYPE_SYMBOL } from './symbols.js';

describe('stored response chunk hydration', () => {
  it('settles step background operations after cancelling a bounded read', async () => {
    const cancel = vi.fn();
    setWorld({
      specVersion: 9,
      streams: {
        get: async () =>
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(4096));
            },
            cancel,
          }),
      },
    } as any);
    try {
      const body = new ReadableStream();
      Object.assign(body, {
        [STREAM_NAME_SYMBOL]: 'strm_chunk',
        [STREAM_TYPE_SYMBOL]: 'bytes',
      });
      const serialized = await dehydrateStepReturnValue(
        new Response(body),
        'wrun_chunk',
        undefined,
        []
      );
      const ops: Promise<void>[] = [];
      const response = (await hydrateStepArguments(
        serialized,
        'wrun_chunk',
        undefined,
        ops,
        globalThis,
        {},
        'dpl_test'
      )) as Response;
      // Match the policy used by both spec8 and spec9 step executors.
      const settled = Promise.all(
        ops.map((op) =>
          op.catch((error) => {
            if (!isClientDisconnectError(error)) throw error;
          })
        )
      );
      settled.catch(() => {});
      const result = await __builtin_response_read_chunk.call(response, 0);
      expect(result.buffer.byteLength).toBe(65536);
      await expect(settled).resolves.toEqual(ops.map(() => undefined));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally {
      setWorld(undefined);
    }
  });
});
