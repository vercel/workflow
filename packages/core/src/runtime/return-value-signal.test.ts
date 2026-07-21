import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReturnValueStreamId } from '../util.js';
import {
  createReturnValueSignalWaiter,
  isReturnValueSignalActive,
  signalRunTerminal,
} from './return-value-signal.js';

const RUN_ID = 'wrun_test123';
const STREAM_NAME = getReturnValueStreamId(RUN_ID);

/**
 * Build a minimal World whose streams surface is fully controllable. Only the
 * members these helpers touch are provided.
 */
function makeWorld(opts: {
  capability?: boolean;
  streams?: Partial<World['streams']>;
}): World {
  return {
    capabilities:
      opts.capability === undefined
        ? undefined
        : { returnValueSignalStream: opts.capability },
    streams: {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      ...opts.streams,
    },
  } as unknown as World;
}

/** A ReadableStream that emits the given chunks (in order) then closes. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A ReadableStream that never emits and never closes. */
function pendingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

const ENABLED = { WORKFLOW_RETURN_VALUE_STREAM: '1' };

beforeEach(() => {
  delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
});

afterEach(() => {
  delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
  vi.useRealTimers();
});

describe('isReturnValueSignalActive', () => {
  it('is false when the flag is off, regardless of capability', () => {
    expect(isReturnValueSignalActive(makeWorld({ capability: true }))).toBe(
      false
    );
  });

  it('is false when the flag is on but the World lacks the capability', () => {
    process.env.WORKFLOW_RETURN_VALUE_STREAM = '1';
    expect(isReturnValueSignalActive(makeWorld({}))).toBe(false);
    expect(isReturnValueSignalActive(makeWorld({ capability: false }))).toBe(
      false
    );
  });

  it('is true only when the flag is on and the capability is declared', () => {
    process.env.WORKFLOW_RETURN_VALUE_STREAM = '1';
    expect(isReturnValueSignalActive(makeWorld({ capability: true }))).toBe(
      true
    );
  });
});

describe('signalRunTerminal', () => {
  it('does nothing when inactive (flag off)', async () => {
    const world = makeWorld({ capability: true });
    await signalRunTerminal(world, RUN_ID);
    expect(world.streams.write).not.toHaveBeenCalled();
    expect(world.streams.close).not.toHaveBeenCalled();
  });

  it('does nothing when the World lacks the capability', async () => {
    Object.assign(process.env, ENABLED);
    const world = makeWorld({ capability: false });
    await signalRunTerminal(world, RUN_ID);
    expect(world.streams.write).not.toHaveBeenCalled();
    expect(world.streams.close).not.toHaveBeenCalled();
  });

  it('writes a marker chunk then closes when active', async () => {
    Object.assign(process.env, ENABLED);
    const world = makeWorld({ capability: true });
    await signalRunTerminal(world, RUN_ID);
    expect(world.streams.write).toHaveBeenCalledTimes(1);
    const [runId, name, chunk] = (
      world.streams.write as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(runId).toBe(RUN_ID);
    expect(name).toBe(STREAM_NAME);
    expect(chunk).toBeInstanceOf(Uint8Array);
    expect((chunk as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(world.streams.close).toHaveBeenCalledWith(RUN_ID, STREAM_NAME);
  });

  it('swallows write errors (best-effort fast path)', async () => {
    Object.assign(process.env, ENABLED);
    const world = makeWorld({
      capability: true,
      streams: { write: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    await expect(signalRunTerminal(world, RUN_ID)).resolves.toBeUndefined();
    // Write failed before close, so close is never reached — and no throw.
    expect(world.streams.close).not.toHaveBeenCalled();
  });
});

describe('createReturnValueSignalWaiter', () => {
  it('resolves fast when the stream yields a non-empty chunk', async () => {
    const get = vi.fn().mockResolvedValue(streamOf(new Uint8Array([1])));
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    // A generous fallback; the chunk must win the race well before it.
    await waiter.waitForSignalOrTimeout(10_000);
    expect(get).toHaveBeenCalledWith(RUN_ID, STREAM_NAME, 0);
    waiter.close();
  });

  it('resolves on a clean close even with no data chunk', async () => {
    const get = vi.fn().mockResolvedValue(streamOf());
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    await waiter.waitForSignalOrTimeout(10_000);
    waiter.close();
  });

  it('skips a leading empty (header) chunk and wakes on the real marker', async () => {
    const get = vi
      .fn()
      .mockResolvedValue(streamOf(new Uint8Array(0), new Uint8Array([1])));
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    await waiter.waitForSignalOrTimeout(10_000);
    waiter.close();
  });

  it('falls back to the timeout when no signal arrives', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue(pendingStream());
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    const p = waiter.waitForSignalOrTimeout(5_000);
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    waiter.close();
  });

  it('degrades to timeout-only waiting after a stream-read failure', async () => {
    const get = vi.fn().mockRejectedValue(new Error('stream down'));
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    // First wait observes the failure and marks itself signalled.
    await waiter.waitForSignalOrTimeout(10);
    // Subsequent waits are pure timeouts and never re-open the stream.
    await waiter.waitForSignalOrTimeout(10);
    expect(get).toHaveBeenCalledTimes(1);
    waiter.close();
  });

  it('close() cancels the underlying reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const reader = stream.getReader();
    // Hand out a stream whose reader we can observe cancellation on.
    const getReaderStream = {
      getReader: () => ({
        read: () => new Promise<never>(() => {}),
        cancel,
        releaseLock: () => reader.releaseLock(),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const get = vi.fn().mockResolvedValue(getReaderStream);
    const world = makeWorld({ capability: true, streams: { get } });
    const waiter = createReturnValueSignalWaiter(world, RUN_ID);
    // Kick off a read so a reader exists, but don't await (it never resolves).
    void waiter.waitForSignalOrTimeout(50);
    // Let the async beginRead reach getReader().
    await Promise.resolve();
    await Promise.resolve();
    waiter.close();
    expect(cancel).toHaveBeenCalled();
  });
});
