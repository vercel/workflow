import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRunCapabilities } from './capabilities.js';
import {
  frameAbortStreamPayload,
  readAbortStreamPacket,
} from './serialization/abort-stream.js';
import {
  deriveRunPayloadKeys,
  type PayloadKey,
  sealTo,
} from './serialization/encryption.js';
import {
  cancelAbortReaders,
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateStepArguments,
  peekFormatPrefix,
} from './serialization.js';
import { contextStorage, type StepContext } from './step/context-storage.js';

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

function stepContext(key?: PayloadKey): StepContext {
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
      features: { encryption: Boolean(key) },
    },
    encryptionKey: key,
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
    false,
    true,
  ])('propagates a split encrypted packet before stream close (framed=%s)', async (framed) => {
    const key = await deriveRunPayloadKeys(new Uint8Array(32).fill(8));
    const input = await dehydrateWorkflowArguments(
      new AbortController().signal,
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
    const ctx = stepContext(key);
    await contextStorage.run(ctx, async () => {
      const signal = (await hydrateStepArguments(
        input,
        runId,
        key,
        ctx.ops
      )) as AbortSignal;
      await Promise.all(ctx.ops);
      expect(signal.aborted).toBe(true);
      expect(signal.reason.message).toBe(reason.message);
    });
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
