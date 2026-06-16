import type { World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./version.js', () => ({ version: '0.0.0-test' }));

import { setWorld } from './runtime/world.js';
import {
  createReconnectingFramedStream,
  FRAMED_STREAM_MAX_RECONNECTS,
  FRAMED_STREAM_MAX_TOTAL_RECONNECTS,
} from './serialization.js';

const FRAME_HEADER_SIZE = 4;
const RUN_ID = 'run-1';

function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

function payloadFrame(n: number): Uint8Array {
  return encodeFrame(new Uint8Array([n]));
}

/**
 * Build a stream from a scripted pull sequence. Each entry either
 * enqueues a value or errors — this keeps the stream from transitioning
 * to the errored state before earlier values are actually read (which
 * `start()`-time `controller.error` does immediately).
 */
function scriptedStream(
  steps: Array<
    | { kind: 'value'; value: Uint8Array }
    | { kind: 'error'; err: unknown }
    | { kind: 'close' }
  >,
  onCancel?: (reason?: unknown) => void
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const step = steps[i++];
      if (!step) {
        controller.close();
        return;
      }
      if (step.kind === 'value') controller.enqueue(step.value);
      else if (step.kind === 'error') controller.error(step.err);
      else controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

async function readAll(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value) chunks.push(r.value);
  }
  return chunks;
}

/**
 * Builds a mock world whose `streams.get` returns a prepared sequence per
 * `startIndex`. Each call records the requested startIndex so assertions can
 * check reconnect positioning.
 */
function makeWorldWithScriptedStreams(
  scripts: Record<number, () => ReadableStream<Uint8Array>>
): { world: World; calls: number[] } {
  const calls: number[] = [];
  const world = {
    streams: {
      get: vi.fn(async (_runId: string, _name: string, startIndex?: number) => {
        const idx = startIndex ?? 0;
        calls.push(idx);
        const factory = scripts[idx];
        if (!factory) {
          throw new Error(`unexpected startIndex ${idx}`);
        }
        return factory();
      }),
    },
  } as unknown as World;
  return { world, calls };
}

describe('createReconnectingFramedStream', () => {
  afterEach(() => {
    setWorld(undefined as unknown as World);
  });

  it('passes through complete frames and closes cleanly on EOF', async () => {
    const { world, calls } = makeWorldWithScriptedStreams({
      0: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(1) },
          { kind: 'value', value: payloadFrame(2) },
          { kind: 'value', value: payloadFrame(3) },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const chunks = await readAll(stream);

    expect(chunks).toEqual([payloadFrame(1), payloadFrame(2), payloadFrame(3)]);
    expect(calls).toEqual([0]);
  });

  it('forwards a frame delivered across multiple reads', async () => {
    const full = payloadFrame(42);
    const { world } = makeWorldWithScriptedStreams({
      0: () =>
        scriptedStream([
          // Split frame into 3 byte-level reads to prove boundary-aware
          // buffering works regardless of transport chunking.
          { kind: 'value', value: full.slice(0, 2) },
          { kind: 'value', value: full.slice(2, 4) },
          { kind: 'value', value: full.slice(4) },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const chunks = await readAll(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(full);
  });

  it('reconnects with startIndex = consumed count on upstream error', async () => {
    const { world, calls } = makeWorldWithScriptedStreams({
      0: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(1) },
          { kind: 'value', value: payloadFrame(2) },
          // Simulate server 2-minute abort mid-frame: deliver the first
          // 3 bytes of a frame then error. The wrapper should discard
          // those partial bytes and reopen at the right index.
          { kind: 'value', value: payloadFrame(3).slice(0, 3) },
          { kind: 'error', err: new Error('max-duration abort') },
        ]),
      2: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(3) },
          { kind: 'value', value: payloadFrame(4) },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const chunks = await readAll(stream);

    expect(chunks).toEqual([
      payloadFrame(1),
      payloadFrame(2),
      payloadFrame(3),
      payloadFrame(4),
    ]);
    // First connection: startIndex=0. After 2 frames consumed, reconnect
    // opens a fresh stream at startIndex=2.
    expect(calls).toEqual([0, 2]);
  });

  it('respects an initial non-zero startIndex on reconnect', async () => {
    const { world, calls } = makeWorldWithScriptedStreams({
      10: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(10) },
          { kind: 'error', err: new Error('abort') },
        ]),
      11: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(11) },
          { kind: 'close' },
        ]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 10);
    const chunks = await readAll(stream);

    expect(chunks).toEqual([payloadFrame(10), payloadFrame(11)]);
    expect(calls).toEqual([10, 11]);
  });

  it('does not reconnect when startIndex is negative', async () => {
    const { world, calls } = makeWorldWithScriptedStreams({
      [-5]: () =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(99) },
          { kind: 'error', err: new Error('abort') },
        ]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', -5);
    await expect(readAll(stream)).rejects.toThrow(/abort/);
    expect(calls).toEqual([-5]);
  });

  it('cancel aborts the upstream reader', async () => {
    const cancelSpy = vi.fn();
    const { world } = makeWorldWithScriptedStreams({
      0: () => {
        // Keep the upstream pending after the first value so cancel
        // actually has a live stream to abort; an auto-closed upstream
        // would swallow the cancel per web-streams spec.
        let pulls = 0;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (pulls++ === 0) {
              controller.enqueue(payloadFrame(1));
              return;
            }
            await new Promise(() => {}); // hang forever
          },
          cancel(reason) {
            cancelSpy(reason);
          },
        });
      },
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel('client abort');

    expect(cancelSpy).toHaveBeenCalled();
  });

  it('emits every complete frame packed into a single read', async () => {
    // One transport read carrying three back-to-back frames must surface as
    // three separate downstream chunks — exercises the inner drain loop.
    const packed = new Uint8Array([
      ...payloadFrame(1),
      ...payloadFrame(2),
      ...payloadFrame(3),
    ]);
    const { world } = makeWorldWithScriptedStreams({
      0: () =>
        scriptedStream([{ kind: 'value', value: packed }, { kind: 'close' }]),
    });
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const chunks = await readAll(stream);

    expect(chunks).toEqual([payloadFrame(1), payloadFrame(2), payloadFrame(3)]);
  });

  it('threads runId through to streams.get', async () => {
    const getSpy = vi.fn(
      async (_runId: string, _name: string, _startIndex?: number) =>
        scriptedStream([
          { kind: 'value', value: payloadFrame(7) },
          { kind: 'close' },
        ])
    );
    const world = { streams: { get: getSpy } } as unknown as World;
    setWorld(world);

    const stream = createReconnectingFramedStream('run-abc', 'my-stream', 3);
    await readAll(stream);

    expect(getSpy).toHaveBeenCalledWith('run-abc', 'my-stream', 3);
  });

  it('errors after the maximum consecutive reconnects with no progress', async () => {
    // Every connection errors before delivering a frame, so no forward
    // progress is ever made. The wrapper must give up rather than reconnect
    // forever.
    const calls: number[] = [];
    const world = {
      streams: {
        get: vi.fn(
          async (_runId: string, _name: string, startIndex?: number) => {
            calls.push(startIndex ?? 0);
            return scriptedStream([
              { kind: 'error', err: new Error('always fails') },
            ]);
          }
        ),
      },
    } as unknown as World;
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    await expect(readAll(stream)).rejects.toThrow(
      /exceeded maximum reconnection attempts/
    );
    // Initial connect + one connect per allowed reconnect; the following
    // reconnect throws before opening another stream.
    expect(calls).toHaveLength(FRAMED_STREAM_MAX_RECONNECTS + 1);
    // No progress ⇒ every attempt resumes from the original index.
    expect(calls.every((i) => i === 0)).toBe(true);
  });

  it('resets the reconnect budget after forward progress', async () => {
    // Deliver exactly one frame per connection and then error, far more
    // times than the consecutive-failure cap. Because every reconnect makes
    // progress, the budget resets and the stream must NOT be capped — it
    // completes once a connection finally closes cleanly. Without the reset
    // this would throw at FRAMED_STREAM_MAX_RECONNECTS.
    const lastIndex = FRAMED_STREAM_MAX_RECONNECTS + 5;
    const calls: number[] = [];
    const world = {
      streams: {
        get: vi.fn(
          async (_runId: string, _name: string, startIndex?: number) => {
            const idx = startIndex ?? 0;
            calls.push(idx);
            // Payload encodes the absolute index so ordering can be asserted.
            return scriptedStream([
              { kind: 'value', value: payloadFrame(idx) },
              idx < lastIndex
                ? { kind: 'error', err: new Error('transient') }
                : { kind: 'close' },
            ]);
          }
        ),
      },
    } as unknown as World;
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    const chunks = await readAll(stream);

    // One frame per index 0..lastIndex inclusive, in order.
    expect(chunks.map((c) => c[FRAME_HEADER_SIZE])).toEqual(
      Array.from({ length: lastIndex + 1 }, (_, i) => i)
    );
    // Reconnected once per error — well beyond the cap — without erroring,
    // and each reconnect resumed at the next index.
    expect(calls.length).toBeGreaterThan(FRAMED_STREAM_MAX_RECONNECTS + 1);
    expect(calls).toEqual(Array.from({ length: lastIndex + 1 }, (_, i) => i));
  });

  it('errors at the absolute backstop when a world ignores startIndex and loops forever', async () => {
    // Pathological world: ignores startIndex and always re-delivers a frame
    // then errors. Every reconnect "makes progress", so the consecutive cap
    // never trips — only the absolute total backstop can stop the loop. This
    // guards against a misbehaving backend turning reconnect into a hang.
    let calls = 0;
    const world = {
      streams: {
        get: vi.fn(async () => {
          calls++;
          return scriptedStream([
            { kind: 'value', value: payloadFrame(0) },
            { kind: 'error', err: new Error('always errors after one frame') },
          ]);
        }),
      },
    } as unknown as World;
    setWorld(world);

    const stream = createReconnectingFramedStream(RUN_ID, 's', 0);
    await expect(readAll(stream)).rejects.toThrow(
      /exceeded maximum total reconnection attempts/
    );
    // Initial connect + one connect per allowed total reconnect; the next
    // reconnect throws before opening another stream.
    expect(calls).toBe(FRAMED_STREAM_MAX_TOTAL_RECONNECTS + 1);
  });
});
