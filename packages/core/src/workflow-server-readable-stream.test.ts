import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorld } from './runtime/world.js';
import { WorkflowServerReadableStream } from './serialization.js';

/** Let pending promise callbacks and pull() continuations run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A World stream that records whether, and why, it was cancelled. */
function trackedStream() {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel,
  });
  return { stream, cancel };
}

describe('WorkflowServerReadableStream cancellation', () => {
  afterEach(() => {
    setWorld(undefined);
  });

  it('cancels a connection that arrives after the consumer cancelled', async () => {
    let connect!: (stream: ReadableStream<Uint8Array>) => void;
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        get: vi.fn(
          () =>
            new Promise<ReadableStream<Uint8Array>>((resolve) => {
              connect = resolve;
            })
        ),
      },
    } as any);

    const reader = new WorkflowServerReadableStream(
      'wrun_1',
      'strm_1'
    ).getReader();
    reader.read().catch(() => {});
    await settle();
    // pull() is now waiting on streams.get().
    await reader.cancel('consumer is done');

    const late = trackedStream();
    connect(late.stream);
    await settle();

    expect(late.cancel).toHaveBeenCalledWith('consumer is done');
  });

  it('cancels the connection when the consumer cancels after it connected', async () => {
    const connected = trackedStream();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: { get: vi.fn(async () => connected.stream) },
    } as any);

    const reader = new WorkflowServerReadableStream(
      'wrun_1',
      'strm_1'
    ).getReader();
    await reader.read();
    await reader.cancel('consumer is done');

    expect(connected.cancel).toHaveBeenCalledWith('consumer is done');
  });
});
