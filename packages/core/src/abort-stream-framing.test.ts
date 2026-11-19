import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunCapabilities } from './capabilities.js';
import { publishLocalAbort } from './serialization/abort-local.js';
import {
  frameAbortStreamPayload,
  readAbortStreamPacket,
} from './serialization/abort-stream.js';
import { deriveRunPayloadKeys, sealTo } from './serialization/encryption.js';
import {
  cancelAbortReaders,
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateStepArguments,
  hydrateWorkflowReturnValue,
  peekFormatPrefix,
} from './serialization.js';
import { contextStorage, type StepContext } from './step/context-storage.js';
import { ABORT_STREAM_NAME } from './symbols.js';

const { world, resumeHook } = vi.hoisted(() => ({
  world: {
    streams: {
      get: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
    },
  },
  resumeHook: vi.fn(),
}));
vi.mock('./runtime/get-world-lazy.js', () => ({ getWorldLazy: () => world }));
vi.mock('./runtime/resume-hook.js', () => ({ resumeHook }));
vi.mock('./version.js', () => ({ version: '0.0.0-test' }));

const runId = 'wrun_abort_framing';
const reason = new DOMException('cancel this turn', 'AbortError');

function chunksStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++].slice());
    },
  });
}

function stepContext(): StepContext {
  return {
    stepMetadata: {
      stepId: 'step_abort',
      stepName: 'abort-test',
      stepStartedAt: new Date(),
      attempt: 1,
    },
    workflowMetadata: {
      workflowRunId: runId,
      workflowName: 'abort-test',
      workflowStartedAt: new Date(),
      url: 'http://localhost',
      features: { encryption: false },
    },
    ops: [],
    preCompletionOps: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  world.streams.get.mockImplementation(async () => chunksStream([]));
  world.streams.write.mockResolvedValue(undefined);
  world.streams.close.mockResolvedValue(undefined);
  resumeHook.mockResolvedValue(undefined);
});

describe('abort packet compatibility', () => {
  for (const encryption of ['plaintext', 'symmetric', 'sealed'] as const) {
    for (const framed of [false, true]) {
      it(`hydrates ${framed ? 'framed' : 'legacy'} ${encryption} packets split byte by byte`, async () => {
        const keys = await deriveRunPayloadKeys(new Uint8Array(32).fill(7));
        const writerKey =
          encryption === 'plaintext'
            ? undefined
            : encryption === 'symmetric'
              ? keys
              : sealTo(keys.keyPair.publicKey);
        const readerKey = encryption === 'plaintext' ? undefined : keys;
        const payload = (await dehydrateStepArguments(
          { aborted: true, reason },
          runId,
          writerKey
        )) as Uint8Array;
        const wire = framed ? frameAbortStreamPayload(payload) : payload;
        const chunks = Array.from(wire, (byte) => new Uint8Array([byte]));
        const reassembled = await readAbortStreamPacket(
          chunksStream(chunks).getReader()
        );
        expect(reassembled).toEqual(payload);
        const data = await hydrateStepArguments(reassembled, runId, readerKey);
        expect(data.aborted).toBe(true);
        expect(data.reason).toBeInstanceOf(DOMException);
        expect(data.reason.name).toBe('AbortError');
        expect(data.reason.message).toBe(reason.message);
      });
    }
  }

  it('delivers a complete framed packet without waiting for stream close', async () => {
    const payload = new TextEncoder().encode('devl[1]');
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frameAbortStreamPayload(payload));
        // Deliberately remain open.
      },
    }).getReader();
    expect(await readAbortStreamPacket(reader)).toEqual(payload);
    await reader.cancel();
  });

  it('reads the first packet when duplicate packets are coalesced', async () => {
    const payload = new TextEncoder().encode('devl[1]');
    const frame = frameAbortStreamPayload(payload);
    const combined = new Uint8Array(frame.length * 2);
    combined.set(frame);
    combined.set(frame, frame.length);
    expect(
      await readAbortStreamPacket(chunksStream([combined]).getReader())
    ).toEqual(payload);
  });

  it('handles empty reads and an empty stream', async () => {
    expect(
      await readAbortStreamPacket(chunksStream([new Uint8Array(0)]).getReader())
    ).toBeUndefined();
  });

  it.each([
    1, 3, 5, 7,
  ])('rejects an incomplete frame cut at byte %i', async (cut) => {
    const frame = frameAbortStreamPayload(new TextEncoder().encode('devl[1]'));
    await expect(
      readAbortStreamPacket(chunksStream([frame.slice(0, cut)]).getReader())
    ).rejects.toThrow(/incomplete frame/);
  });

  it.each([
    0, 3, 100_000_001,
  ])('rejects invalid length %i before buffering a body', async (length) => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, length, false);
    await expect(
      readAbortStreamPacket(chunksStream([header]).getReader())
    ).rejects.toThrow(/frame length/);
  });
});

describe('real abort reducers and revivers', () => {
  it.each([
    false,
    true,
  ])('frames external aborts only when the receiver supports them: %s', async (supported) => {
    const source = new AbortController();
    const ops: Promise<void>[] = [];
    await dehydrateWorkflowArguments(
      source.signal,
      runId,
      undefined,
      ops,
      globalThis,
      false,
      false,
      false,
      ops,
      supported
    );
    source.abort(reason);
    await Promise.all(ops);
    const wire = world.streams.write.mock.calls[0][2] as Uint8Array;
    expect(peekFormatPrefix(wire)).toBe(supported ? null : 'devl');
    const payload = await readAbortStreamPacket(
      chunksStream([wire]).getReader()
    );
    expect(
      (await hydrateStepArguments(payload, runId, undefined)).reason.message
    ).toBe(reason.message);
  });

  it.each([
    undefined,
    '5.2.3',
    '5.3.0',
  ])('gates hook payload abort writers for target core %s', async (version) => {
    const source = new AbortController();
    const ops: Promise<void>[] = [];
    await dehydrateStepReturnValue(
      source.signal,
      runId,
      undefined,
      ops,
      globalThis,
      false,
      false,
      false,
      undefined,
      ops,
      getRunCapabilities(version).framedAbortStreams
    );
    source.abort(reason);
    await Promise.all(ops);
    const wire = world.streams.write.mock.calls[0][2] as Uint8Array;
    expect(peekFormatPrefix(wire)).toBe(version === '5.3.0' ? null : 'devl');
  });

  it.each([
    { kind: 'signal', framed: false },
    { kind: 'signal', framed: true },
    { kind: 'controller', framed: false },
    { kind: 'controller', framed: true },
  ] as const)('propagates a split encrypted packet to a $kind before stream close (framed=$framed)', async ({
    kind,
    framed,
  }) => {
    const key = await deriveRunPayloadKeys(new Uint8Array(32).fill(8));
    const source = new AbortController();
    const input = await dehydrateWorkflowArguments(
      kind === 'signal' ? source.signal : source,
      runId,
      key
    );
    const payload = (await dehydrateStepArguments(
      { aborted: true, reason },
      runId,
      key
    )) as Uint8Array;
    const wire = framed ? frameAbortStreamPayload(payload) : payload;
    world.streams.get.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
            // close() is a separate, best-effort writer RPC. Never provide EOF.
          },
        })
    );
    // Like the step executor, hydrate outside any contextStorage frame: the
    // reader can only get the key from the reviver.
    const ops: Promise<void>[] = [];
    const hydrated = await hydrateStepArguments(input, runId, key, ops);
    const signal =
      kind === 'signal'
        ? (hydrated as AbortSignal)
        : (hydrated as AbortController).signal;
    await Promise.all(ops);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(reason.message);
  });

  it('frames step-initiated aborts and keeps the durable hook payload unchanged', async () => {
    const input = await dehydrateWorkflowArguments(
      new AbortController(),
      runId,
      undefined
    );
    const ctx = stepContext();
    await contextStorage.run(ctx, async () => {
      const controller = (await hydrateStepArguments(
        input,
        runId,
        undefined,
        ctx.ops
      )) as AbortController;
      controller.abort(reason);
      await Promise.all([...ctx.ops, ...ctx.preCompletionOps]);
      const wire = world.streams.write.mock.calls[0][2] as Uint8Array;
      const payload = await readAbortStreamPacket(
        chunksStream([wire]).getReader()
      );
      expect(
        (await hydrateStepArguments(payload, runId, undefined)).reason.message
      ).toBe(reason.message);
      expect(resumeHook).toHaveBeenCalledWith(expect.any(String), {
        aborted: true,
        reason,
      });
    });
  });

  it.each([
    false,
    true,
  ])('propagates abort without waiting for transport close or cancellation (framed=%s)', async (framed) => {
    const input = await dehydrateWorkflowArguments(
      new AbortController().signal,
      runId,
      undefined
    );
    const payload = (await dehydrateStepArguments(
      { aborted: true, reason },
      runId,
      undefined
    )) as Uint8Array;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    world.streams.get.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              framed ? frameAbortStreamPayload(payload) : payload
            );
          },
          cancel,
        })
    );
    const ops: Promise<void>[] = [];
    const signal = (await hydrateStepArguments(
      input,
      runId,
      undefined,
      ops
    )) as AbortSignal;
    await Promise.all(ops);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(reason.message);
    expect(cancel).toHaveBeenCalled();
  });

  it('leaves an incomplete packet to the durable hook fallback', async () => {
    const input = await dehydrateWorkflowArguments(
      new AbortController().signal,
      runId,
      undefined
    );
    const payload = (await dehydrateStepArguments(
      { aborted: true, reason },
      runId,
      undefined
    )) as Uint8Array;
    world.streams.get.mockImplementationOnce(async () =>
      chunksStream([frameAbortStreamPayload(payload).slice(0, 5)])
    );
    const ops: Promise<void>[] = [];
    const signal = (await hydrateStepArguments(
      input,
      runId,
      undefined,
      ops
    )) as AbortSignal;
    await vi.waitFor(() => expect(world.streams.get).toHaveBeenCalled());
    // The step returns, and the executor stops its readers.
    cancelAbortReaders(signal);
    await Promise.all(ops);
    expect(signal.aborted).toBe(false);
  });

  it('cancels a partial packet read when the step finishes without aborting the signal', async () => {
    const input = await dehydrateWorkflowArguments(
      new AbortController().signal,
      runId,
      undefined
    );
    const cancel = vi.fn();
    world.streams.get.mockImplementationOnce(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 0]));
          },
          cancel,
        })
    );
    const ops: Promise<void>[] = [];
    const signal = (await hydrateStepArguments(
      input,
      runId,
      undefined,
      ops
    )) as AbortSignal;
    await vi.waitFor(() => expect(world.streams.get).toHaveBeenCalled());
    cancelAbortReaders(signal);
    await Promise.all(ops);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(signal.aborted).toBe(false);
  });
});

describe('in-process abort delivery', () => {
  /** A stream that delivers nothing and ends when `end` is called. */
  function clearedStream() {
    let end: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => {
          try {
            controller.close();
          } catch {
            // Already cancelled by the reader.
          }
        };
      },
    });
    return { stream, end: () => end() };
  }

  async function abortPacket(
    key?: Awaited<ReturnType<typeof deriveRunPayloadKeys>>
  ) {
    return (await dehydrateStepArguments(
      { aborted: true, reason },
      runId,
      key
    )) as Uint8Array;
  }

  it.each([
    'signal',
    'controller',
  ] as const)('aborts a revived %s whose stream ends empty, as a cleared one does', async (kind) => {
    const key = await deriveRunPayloadKeys(new Uint8Array(32).fill(9));
    const source = new AbortController();
    const input = await dehydrateWorkflowArguments(
      kind === 'signal' ? source.signal : source,
      runId,
      key
    );
    const cleared = clearedStream();
    world.streams.get.mockImplementationOnce(async () => cleared.stream);
    const ops: Promise<void>[] = [];
    const hydrated = await hydrateStepArguments(input, runId, key, ops);
    const signal =
      kind === 'signal'
        ? (hydrated as AbortSignal)
        : (hydrated as AbortController).signal;
    const streamName = (signal as unknown as Record<symbol, string>)[
      ABORT_STREAM_NAME
    ];
    expect(streamName).toMatch(/_system_abort$/);

    publishLocalAbort(runId, streamName, await abortPacket(key));
    cleared.end();
    await Promise.all(ops);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(reason.message);
  });

  it.each([
    'ends empty',
    'fails',
  ] as const)("keeps a step's reader listening in-process after its stream %s", async (outcome) => {
    const stepRunId = `${runId}_after_${outcome.replace(' ', '_')}`;
    const input = await dehydrateWorkflowArguments(
      new AbortController().signal,
      stepRunId,
      undefined
    );
    const read = vi.fn();
    world.streams.get.mockImplementationOnce(async () => {
      read();
      return outcome === 'fails'
        ? chunksStream([frameAbortStreamPayload(new Uint8Array(8)).slice(0, 5)])
        : chunksStream([]);
    });
    const ops: Promise<void>[] = [];
    const signal = (await hydrateStepArguments(
      input,
      stepRunId,
      undefined,
      ops
    )) as AbortSignal;
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    // Let the stream outcome settle before the abort is published.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal.aborted).toBe(false);

    publishLocalAbort(
      stepRunId,
      (signal as unknown as Record<symbol, string>)[ABORT_STREAM_NAME],
      (await dehydrateStepArguments(
        { aborted: true, reason },
        stepRunId,
        undefined
      )) as Uint8Array
    );
    await Promise.all(ops);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(reason.message);
  });

  it('stops an external reader with its empty stream', async () => {
    const source = new AbortController();
    const ops: Promise<void>[] = [];
    // A signal a step returns, revived by the caller of `returnValue`: no
    // one cancels its reader, so it must not outlive the stream.
    const serialized = await dehydrateStepReturnValue(
      source.signal,
      runId,
      undefined,
      ops
    );
    world.streams.get.mockImplementationOnce(async () => chunksStream([]));
    const hydrateOps: Promise<void>[] = [];
    const signal = (await hydrateWorkflowReturnValue(
      serialized,
      runId,
      undefined,
      hydrateOps
    )) as AbortSignal;
    await Promise.all(hydrateOps);
    expect(signal.aborted).toBe(false);
  });

  it('aborts a signal revived just after the abort was published', async () => {
    const source = new AbortController();
    const input = await dehydrateWorkflowArguments(
      source.signal,
      `${runId}_late`,
      undefined
    );
    const ops: Promise<void>[] = [];
    // Revive once to learn the stream name, then publish before the second
    // revive, as a step still reviving its arguments would see it.
    const first = (await hydrateStepArguments(
      input,
      `${runId}_late`,
      undefined,
      ops
    )) as AbortSignal;
    const streamName = (first as unknown as Record<symbol, string>)[
      ABORT_STREAM_NAME
    ];
    cancelAbortReaders(first);
    await Promise.all(ops.splice(0));

    publishLocalAbort(
      `${runId}_late`,
      streamName,
      (await dehydrateStepArguments(
        { aborted: true, reason },
        `${runId}_late`,
        undefined
      )) as Uint8Array
    );
    world.streams.get.mockImplementationOnce(async () => chunksStream([]));
    const signal = (await hydrateStepArguments(
      input,
      `${runId}_late`,
      undefined,
      ops
    )) as AbortSignal;
    await Promise.all(ops);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toBe(reason.message);
  });

  it("aborts a sibling step's signal when a step aborts the shared controller", async () => {
    const input = await dehydrateWorkflowArguments(
      new AbortController(),
      `${runId}_sibling`,
      undefined
    );
    const cleared = [clearedStream(), clearedStream()];
    world.streams.get
      .mockImplementationOnce(async () => cleared[0].stream)
      .mockImplementationOnce(async () => cleared[1].stream);
    const ctx = stepContext();
    ctx.workflowMetadata.workflowRunId = `${runId}_sibling`;
    const siblingOps: Promise<void>[] = [];
    const sibling = (await hydrateStepArguments(
      input,
      `${runId}_sibling`,
      undefined,
      siblingOps
    )) as AbortController;
    await contextStorage.run(ctx, async () => {
      const controller = (await hydrateStepArguments(
        input,
        `${runId}_sibling`,
        undefined,
        ctx.ops
      )) as AbortController;
      controller.abort(reason);
      await Promise.all(ctx.preCompletionOps);
      // The step returns, and the executor stops its own readers.
      cancelAbortReaders(controller);
      await Promise.all(ctx.ops);
    });
    for (const stream of cleared) stream.end();
    await Promise.all(siblingOps);
    expect(sibling.signal.aborted).toBe(true);
    expect(sibling.signal.reason.message).toBe(reason.message);
    // Delivered once: the sibling's own abort did not write the stream or
    // resume the hook again.
    expect(world.streams.write).toHaveBeenCalledTimes(1);
    expect(resumeHook).toHaveBeenCalledTimes(1);
  });
});
