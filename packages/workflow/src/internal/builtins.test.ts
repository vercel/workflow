import {
  RESPONSE_BODY_CHUNK_MAX_BYTES,
  responseBodyChunkSize,
} from '@workflow/core/serialization-format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __builtin_response_read_chunk,
  __builtin_set_attributes,
} from './builtins.js';

const STEP_CONTEXT_STORAGE = Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE');
const WORLD_CACHE = Symbol.for('@workflow/world//cache');
const UNSUPPORTED_WORLD_WARNED = Symbol.for(
  '@workflow/setAttributes//unsupportedWorldWarned'
);

const globals = globalThis as Record<symbol, unknown>;

function setStepAttempt(attempt: number) {
  globals[STEP_CONTEXT_STORAGE] = {
    getStore: () => ({
      stepMetadata: { attempt },
      workflowMetadata: { workflowRunId: 'run_123' },
    }),
  };
}

describe('__builtin_set_attributes', () => {
  let originalContextStorage: unknown;
  let originalWorld: unknown;
  let originalUnsupportedWorldWarned: unknown;

  beforeEach(() => {
    originalContextStorage = globals[STEP_CONTEXT_STORAGE];
    originalWorld = globals[WORLD_CACHE];
    originalUnsupportedWorldWarned = globals[UNSUPPORTED_WORLD_WARNED];
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalContextStorage === undefined) {
      delete globals[STEP_CONTEXT_STORAGE];
    } else {
      globals[STEP_CONTEXT_STORAGE] = originalContextStorage;
    }

    if (originalWorld === undefined) {
      delete globals[WORLD_CACHE];
    } else {
      globals[WORLD_CACHE] = originalWorld;
    }

    if (originalUnsupportedWorldWarned === undefined) {
      delete globals[UNSUPPORTED_WORLD_WARNED];
    } else {
      globals[UNSUPPORTED_WORLD_WARNED] = originalUnsupportedWorldWarned;
    }
  });

  it('rethrows attribute write failures before the third attempt', async () => {
    const error = new Error('world unavailable');
    const experimentalSetAttributes = vi.fn().mockRejectedValue(error);
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };

    for (const attempt of [1, 2]) {
      setStepAttempt(attempt);

      await expect(
        __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
          allowReservedAttributes: true,
        })
      ).rejects.toBe(error);
    }

    expect(experimentalSetAttributes).toHaveBeenCalledTimes(2);
  });

  it('logs and completes after the third failed attempt', async () => {
    const experimentalSetAttributes = vi
      .fn()
      .mockRejectedValue(new Error('world unavailable'));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    globals[WORLD_CACHE] = {
      runs: { experimentalSetAttributes },
    };
    setStepAttempt(3);

    await expect(
      __builtin_set_attributes([{ key: '$tag.kind', value: 'agent' }], {
        allowReservedAttributes: true,
      })
    ).resolves.toBeUndefined();

    expect(experimentalSetAttributes).toHaveBeenCalledWith(
      'run_123',
      [{ key: '$tag.kind', value: 'agent' }],
      { allowReservedAttributes: true }
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain(
      'failed to post tags after 3 attempts'
    );
    expect(
      (
        __builtin_set_attributes as typeof __builtin_set_attributes & {
          maxRetries: number;
        }
      ).maxRetries
    ).toBe(2);
  });
});

describe('__builtin_response_read_chunk', () => {
  it('bounds an endless response and cancels without draining it', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(4096).fill(42));
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const response = new Response(body);
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const result = await __builtin_response_read_chunk.call(response, 0);
    expect(result.done).toBe(false);
    expect(result.buffer.byteLength).toBe(65536);
    expect(new Uint8Array(result.buffer).every((byte) => byte === 42)).toBe(
      true
    );
    expect(pulls).toBe(16);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uses byte offsets independent of source chunk boundaries', async () => {
    const payload = Uint8Array.from({ length: 150000 }, (_, i) => i % 251);
    function response(chunkSize: number) {
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === payload.length) return controller.close();
            const end = Math.min(offset + chunkSize, payload.length);
            controller.enqueue(payload.slice(offset, end));
            offset = end;
          },
        })
      );
    }
    for (const offset of [0, 65536, 131072, 150000]) {
      const first = await __builtin_response_read_chunk.call(
        response(1000),
        offset
      );
      const replay = await __builtin_response_read_chunk.call(
        response(90000),
        offset
      );
      expect(first).toEqual(replay);
      const size = responseBodyChunkSize(offset);
      expect(new Uint8Array(first.buffer)).toEqual(
        payload.slice(offset, offset + size)
      );
      expect(first.done).toBe(offset + size > payload.length);
    }
  });

  it('grows the chunk size with the offset up to a cap', async () => {
    expect(
      [0, 1, 65536, 100000, 131072, 1 << 20, 1 << 30].map(responseBodyChunkSize)
    ).toEqual([
      65536,
      65536,
      65536,
      100000,
      131072,
      1 << 20,
      RESPONSE_BODY_CHUNK_MAX_BYTES,
    ]);
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1 << 20));
          },
        })
      );
    for (const offset of [131072, 32 << 20]) {
      const result = await __builtin_response_read_chunk.call(
        endless(),
        offset
      );
      expect(result.buffer.byteLength).toBe(responseBodyChunkSize(offset));
      expect(result.done).toBe(false);
    }
  });

  it('needs one more empty read to see the end of a body that fills its last chunk', async () => {
    const payload = new Uint8Array(131072).fill(7);
    const response = () => new Response(payload);
    const full = await __builtin_response_read_chunk.call(response(), 65536);
    expect(full.buffer.byteLength).toBe(65536);
    expect(full.done).toBe(false);
    const end = await __builtin_response_read_chunk.call(response(), 131072);
    expect(end).toEqual({ buffer: new ArrayBuffer(0), done: true });
  });

  it('rejects invalid offsets before reading the body', async () => {
    for (const offset of [-1, 1.5, Number.NaN, 2 ** 53, '0' as any]) {
      const body = new ReadableStream<Uint8Array>();
      await expect(
        __builtin_response_read_chunk.call(new Response(body), offset)
      ).rejects.toThrow(RangeError);
      expect(body.locked).toBe(false);
    }
  });

  it('cancels and releases its reader when a source fails', async () => {
    const error = new Error('source failed');
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(error);
      },
    });
    await expect(
      __builtin_response_read_chunk.call(new Response(body), 0)
    ).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
});
