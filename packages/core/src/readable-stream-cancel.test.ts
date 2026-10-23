import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorld } from './runtime/world.js';
import { WorkflowServerReadableStream } from './serialization.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A World stream that never delivers a chunk: a live tail with no data. */
function idleTail() {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  return { stream, cancel };
}

describe('WorkflowServerReadableStream cancel', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('cancels the World stream when cancelled after it connects', async () => {
    const tail = idleTail();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: { get: vi.fn().mockResolvedValue(tail.stream) },
    } as any);

    const stream = new WorkflowServerReadableStream('run-1', 'strm_a');
    const reader = stream.getReader();
    void reader.read().catch(() => {});
    await vi.waitFor(() => expect(tail.stream.locked).toBe(true));

    await reader.cancel();
    expect(tail.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the World stream when cancelled while it is still connecting', async () => {
    const tail = idleTail();
    const connect = deferred<ReadableStream<Uint8Array>>();
    const get = vi.fn().mockReturnValue(connect.promise);
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: { get },
    } as any);

    const stream = new WorkflowServerReadableStream('run-1', 'strm_a');
    const reader = stream.getReader();
    const read = reader.read();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    // The consumer goes away before the connection opens (a step that
    // returns faster than the read connects).
    await reader.cancel();
    connect.resolve(tail.stream);

    await vi.waitFor(() => expect(tail.cancel).toHaveBeenCalledTimes(1));
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  it('does not open a World stream when cancelled before the first pull connects', async () => {
    const get = vi.fn();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: { get },
    } as any);

    const stream = new WorkflowServerReadableStream('run-1', 'strm_a');
    await stream.cancel();
    // Give any stray pull a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(get).not.toHaveBeenCalled();
  });
});
