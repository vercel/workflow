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
  // When the hydration pipe has already read the end of the stored stream,
  // cancelling the hydrated body used to reject the background op with a
  // generic TypeError, which step executors treat as a step failure.
  it.each([
    [65536, 65536, 0],
    [65537, 1000, 0],
    [66000, 66000, 0],
    [131072, 65536, 65536],
    [70000, 1000, 0],
  ])('settles background operations for a %i-byte body in %i-byte frames read at %i', async (length, frame, offset) => {
    setWorld({
      specVersion: 9,
      streams: {
        get: async () => {
          let sent = 0;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= length) return controller.close();
              controller.enqueue(
                new Uint8Array(Math.min(frame, length - sent))
              );
              sent += frame;
            },
          });
        },
      },
    } as any);
    try {
      const body = new ReadableStream();
      Object.assign(body, {
        [STREAM_NAME_SYMBOL]: 'strm_boundary',
        [STREAM_TYPE_SYMBOL]: 'bytes',
      });
      const serialized = await dehydrateStepReturnValue(
        new Response(body),
        'wrun_boundary',
        undefined,
        []
      );
      const ops: Promise<void>[] = [];
      const response = (await hydrateStepArguments(
        serialized,
        'wrun_boundary',
        undefined,
        ops,
        globalThis,
        {},
        'dpl_test'
      )) as Response;
      const result = await __builtin_response_read_chunk.call(response, offset);
      expect(result.buffer.byteLength).toBe(Math.min(length - offset, 65536));
      const outcomes = await Promise.allSettled(ops);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(isClientDisconnectError(outcome.reason)).toBe(true);
        }
      }
    } finally {
      setWorld(undefined);
    }
  });
});
