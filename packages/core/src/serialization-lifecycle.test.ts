import { stringify } from 'devalue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommonReducers } from './serialization/reducers/common.js';
import {
  encodeWithFormatPrefix,
  encrypt,
  getExternalRevivers,
  getRunReadableStream,
  hydrateRunError,
  type SerializableSpecial,
  SerializationFormat,
} from './serialization.js';

const world = vi.hoisted(() => ({
  streams: { get: vi.fn(), getInfo: vi.fn() },
}));
vi.mock('./runtime/get-world-lazy.js', () => ({
  getWorldLazy: () => world,
}));

const runId = 'wrun_lifecycle_serialization';
const policy = { lazyStreams: true, liveAbortSignals: false };

// Emit real devalue wire descriptors without starting live serializer pumps.
class Fixture {
  constructor(
    readonly type:
      | 'ReadableStream'
      | 'Response'
      | 'AbortController'
      | 'AbortSignal',
    readonly descriptor: unknown
  ) {}
}

function serialize(value: unknown): Uint8Array {
  const reducers = Object.fromEntries(
    ['ReadableStream', 'Response', 'AbortController', 'AbortSignal'].map(
      (type) => [
        type,
        (value: unknown) =>
          value instanceof Fixture && value.type === type && value.descriptor,
      ]
    )
  );
  return encodeWithFormatPrefix(
    SerializationFormat.DEVALUE_V1,
    new TextEncoder().encode(
      stringify(value, { ...reducers, ...getCommonReducers() })
    )
  ) as Uint8Array;
}

function frame(payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + payload.length);
  new DataView(bytes.buffer).setUint32(0, payload.length, false);
  bytes.set(payload, 4);
  return bytes;
}

function transport(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function hydrate(value: unknown, ops: Promise<void>[] = []) {
  return hydrateRunError(
    serialize(value),
    runId,
    undefined,
    ops,
    globalThis,
    getExternalRevivers(globalThis, ops, runId, undefined, policy)
  );
}

beforeEach(() => {
  world.streams.get.mockReset();
  world.streams.getInfo
    .mockReset()
    .mockResolvedValue({ done: true, tailIndex: 0 });
});

describe('terminal error hydration policies', () => {
  it.each([
    undefined,
    'raw',
    'framed-v1',
  ] as const)('defers a Response body GET until consumed (framing: %s)', async (framing) => {
    const descriptor: SerializableSpecial['ReadableStream'] = {
      name: 'response-body',
      type: 'bytes',
      framing,
      startIndex: 3,
    };
    const response = new Fixture('Response', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: [['content-type', 'text/plain']],
      body: new Fixture('ReadableStream', descriptor),
    });
    const ops: Promise<void>[] = [];
    const error = (await hydrate(
      new Error('failed', { cause: response }),
      ops
    )) as Error;
    const body = error.cause as Response;
    expect(body).toBeInstanceOf(Response);
    expect(body.status).toBe(502);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.streams.get).not.toHaveBeenCalled();
    expect(ops).toHaveLength(0);

    const bytes = new TextEncoder().encode('persisted response');
    const wire = framing === 'framed-v1' ? frame(bytes) : bytes;
    world.streams.get.mockResolvedValue(
      transport(wire.slice(0, 2), wire.slice(2))
    );
    expect(await body.text()).toBe('persisted response');
    expect(world.streams.get).toHaveBeenCalledExactlyOnceWith(
      runId,
      descriptor.name,
      3
    );
    await Promise.all(ops);
  });

  it.each([
    undefined,
    'bytes',
  ] as const)('keeps an unconsumed readable inert, including lock and cancellation (type: %s)', async (type) => {
    const ops: Promise<void>[] = [];
    const error = (await hydrate(
      new Error('failed', {
        cause: new Fixture('ReadableStream', {
          name: 'unread',
          type,
          startIndex: 2,
        }),
      }),
      ops
    )) as Error;
    const stream = error.cause as ReadableStream;
    expect(stream).toBeInstanceOf(ReadableStream);
    const reader = stream.getReader();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.streams.get).not.toHaveBeenCalled();
    reader.releaseLock();
    await stream.cancel('not needed');
    expect(world.streams.get).not.toHaveBeenCalled();
    expect(ops).toHaveLength(0);
  });

  it('reads encrypted object frames with startIndex and one lazy key lookup', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const resolveKey = vi.fn(async () => key);
    const ops: Promise<void>[] = [];
    const stream = (await hydrateRunError(
      serialize(
        new Fixture('ReadableStream', { name: 'objects', startIndex: 7 })
      ),
      runId,
      undefined,
      ops,
      globalThis,
      getExternalRevivers(globalThis, ops, runId, resolveKey, policy)
    )) as ReadableStream;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolveKey).not.toHaveBeenCalled();
    expect(world.streams.get).not.toHaveBeenCalled();

    const values = [{ count: 1 }, { count: 2 }];
    const frames = await Promise.all(
      values.map(async (value) =>
        frame((await encrypt(serialize(value), key)) as Uint8Array)
      )
    );
    world.streams.get.mockResolvedValue(
      transport(frames[0].slice(0, 6), frames[0].slice(6), frames[1])
    );
    const reader = stream.getReader();
    for (const value of values)
      expect(await reader.read()).toEqual({ done: false, value });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    await Promise.all(ops);
    expect(world.streams.get).toHaveBeenCalledExactlyOnceWith(
      runId,
      'objects',
      7
    );
    expect(resolveKey).toHaveBeenCalledTimes(1);
  });

  it('retains nested hydration policies without reusing the parent readable state', async () => {
    const onReadableState = vi.fn();
    const ops: Promise<void>[] = [];
    const revivers = getExternalRevivers(globalThis, ops, runId, undefined, {
      ...policy,
      onReadableState,
    });
    const stream = revivers.ReadableStream!({
      name: 'parent',
    }) as ReadableStream;
    world.streams.get.mockResolvedValueOnce(
      transport(
        frame(
          serialize({
            child: new Fixture('ReadableStream', {
              name: 'child',
              type: 'bytes',
              startIndex: 4,
            }),
            signal: new Fixture('AbortSignal', {
              streamName: 'abort',
              hookToken: 'hook',
              aborted: false,
            }),
          })
        )
      )
    );
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    await Promise.all(ops);
    expect(value.signal).toBeInstanceOf(AbortSignal);
    expect(value.signal.aborted).toBe(false);
    expect(world.streams.get).toHaveBeenCalledTimes(1);
    expect(onReadableState).toHaveBeenCalledTimes(1);

    world.streams.get.mockResolvedValueOnce(
      transport(new TextEncoder().encode('child data'))
    );
    expect(await new Response(value.child).text()).toBe('child data');
    await Promise.all(ops);
    expect(world.streams.get).toHaveBeenLastCalledWith(runId, 'child', 4);
    expect(world.streams.get).toHaveBeenCalledTimes(2);
    expect(onReadableState).toHaveBeenCalledTimes(1);
  });

  it.each([
    'AbortController',
    'AbortSignal',
  ] as const)('revives native %s snapshots without readers or propagation patches', async (type) => {
    const ops: Promise<void>[] = [];
    const values = [false, true].map(
      (aborted) =>
        new Fixture(type, {
          streamName: 'abort-stream',
          hookToken: 'abort-hook',
          aborted,
          reason: aborted ? new Error('persisted reason') : undefined,
        })
    );
    const error = (await hydrate(
      new Error('failed', { cause: values }),
      ops
    )) as Error;
    const [active, aborted] = error.cause as (AbortController | AbortSignal)[];
    for (const value of [active, aborted]) {
      expect(value).toBeInstanceOf(
        type === 'AbortController' ? AbortController : AbortSignal
      );
    }
    const signalOf = (value: AbortController | AbortSignal) =>
      value instanceof AbortController ? value.signal : value;
    expect(signalOf(active).aborted).toBe(false);
    expect(signalOf(active).reason).toBeUndefined();
    expect(signalOf(aborted).aborted).toBe(true);
    expect(signalOf(aborted).reason).toBeInstanceOf(Error);
    expect(signalOf(aborted).reason.message).toBe('persisted reason');
    if (active instanceof AbortController) {
      expect(active.abort).toBe(AbortController.prototype.abort);
      active.abort('local only');
      expect(active.signal.reason).toBe('local only');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.streams.get).not.toHaveBeenCalled();
    expect(ops).toHaveLength(0);
  });

  it.each([
    'lifecycle',
    'run',
  ] as const)('polls the public %s reader for lock release', async (mode) => {
    const ops: Promise<void>[] = [];
    const chunk =
      mode === 'run'
        ? frame(serialize('first'))
        : new TextEncoder().encode('first');
    const cancel = vi.fn();
    world.streams.get.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
        },
        cancel,
      })
    );
    const stream =
      mode === 'run'
        ? getRunReadableStream(
            globalThis,
            ops,
            runId,
            'open',
            undefined,
            undefined
          )
        : (getExternalRevivers(globalThis, ops, runId, undefined, policy)
            .ReadableStream!({
            name: 'open',
            type: 'bytes',
          }) as ReadableStream);
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(ops).toHaveLength(1);
    const settled = vi.fn();
    void Promise.all(ops).then(settled);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).not.toHaveBeenCalled();
    reader.releaseLock();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await stream.cancel('finished');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('leaves default error hydration eager', async () => {
    world.streams.get.mockResolvedValue(
      transport(new TextEncoder().encode('default'))
    );
    const ops: Promise<void>[] = [];
    const stream = (await hydrateRunError(
      serialize(
        new Fixture('ReadableStream', {
          name: 'default',
          type: 'bytes',
        })
      ),
      runId,
      undefined,
      ops
    )) as ReadableStream;
    await vi.waitFor(() => expect(world.streams.get).toHaveBeenCalledOnce());
    expect(await new Response(stream).text()).toBe('default');
    await Promise.all(ops);
  });
});
