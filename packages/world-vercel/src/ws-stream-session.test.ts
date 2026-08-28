import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrames, encodeFrame } from './frames.js';

const { FakeWebSocket, injectTraceContextIntoHeaders, sockets } = vi.hoisted(
  () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static readonly OPEN = 1;
      readyState = 0;
      binaryType = '';
      sent: Uint8Array[] = [];
      closed: Array<[number, string]> = [];
      throwOnSend: Error | undefined;
      private listeners = new Map<
        string,
        Array<(...args: unknown[]) => void>
      >();

      constructor(
        readonly url: string,
        readonly options: unknown
      ) {
        sockets.push(this);
      }
      on(event: string, callback: (...args: unknown[]) => void): this {
        const callbacks = this.listeners.get(event) ?? [];
        callbacks.push(callback);
        this.listeners.set(event, callbacks);
        return this;
      }
      once(event: string, callback: (...args: unknown[]) => void): this {
        const wrapper = (...args: unknown[]) => {
          this.off(event, wrapper);
          callback(...args);
        };
        return this.on(event, wrapper);
      }
      off(event: string, callback: (...args: unknown[]) => void): this {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((item) => item !== callback)
        );
        return this;
      }
      emit(event: string, ...args: unknown[]): void {
        for (const callback of [...(this.listeners.get(event) ?? [])]) {
          callback(...args);
        }
      }
      send(frame: Uint8Array, callback?: (error?: Error) => void): void {
        if (this.throwOnSend) throw this.throwOnSend;
        this.sent.push(frame);
        callback?.();
      }
      close(code = 1000, reason = ''): void {
        this.closed.push([code, reason]);
        this.readyState = 3;
      }
      open(): void {
        this.readyState = FakeSocket.OPEN;
        this.emit('open');
      }
      reply(frame: Uint8Array): void {
        this.emit('message', Buffer.from(frame));
      }
    }
    return {
      FakeWebSocket: FakeSocket,
      injectTraceContextIntoHeaders: vi.fn(),
      sockets,
    };
  }
);

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));
vi.mock('./telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry.js')>();
  return { ...actual, injectTraceContextIntoHeaders };
});

const { createStreamWriteSession } = await import('./ws-stream-session.js');

async function decodeOne(raw: Uint8Array) {
  for await (const frame of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    return frame;
  }
  throw new Error('no frame');
}

const writerId = 'wrtr_01ARZ3NDEKTSV4RRFFQ69G5FAV';

beforeEach(() => {
  sockets.length = 0;
  injectTraceContextIntoHeaders.mockClear();
  delete process.env.WORKFLOW_STREAMS_TRANSPORT;
  delete process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH;
});

afterEach(() => {
  delete process.env.WORKFLOW_REQUEST_TIMEOUT_MS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSession() {
  const writeHttp = vi.fn().mockResolvedValue(undefined);
  const closeHttp = vi.fn().mockResolvedValue(undefined);
  const session = createStreamWriteSession(
    'wrun_1',
    'stream/1',
    writerId,
    { token: 'token' },
    writeHttp,
    closeHttp
  );
  return { session, writeHttp, closeHttp };
}

describe('v1 stream WebSocket writer lifecycle', () => {
  it.each([
    [undefined, 1],
    ['1', 1],
    ['2', 2],
    ['4', 4],
  ])('advertises effective pipeline depth %j', (value, expected) => {
    if (value === undefined) {
      delete process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH;
    } else {
      process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = value;
    }
    expect(makeSession().session.maxInFlightWrites).toBe(expected);
  });

  it('keeps HTTP as the default without constructing a socket', async () => {
    const { session, writeHttp, closeHttp } = makeSession();
    await session.write(0, ['one']);
    await session.close();

    expect(sockets).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
    expect(closeHttp).toHaveBeenCalledTimes(1);
  });

  it('carries the first write when the socket opens inside the budget', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );

    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('atomically tombstones to HTTP when the connect budget expires', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    const first = session.write(0, ['one']);
    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await Promise.all([first, second]);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'connect budget expired']);
    sockets[0].open();
    expect(sockets[0].closed).toContainEqual([1000, 'HTTP fallback selected']);
  });

  it('keeps pre-open HTTP fallback writes serial at pipelined depth', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '4';
    let releaseFirst: (() => void) | undefined;
    const firstHttp = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { session, writeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => firstHttp);
    const first = session.write(0, ['one']);
    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('unexpected-response', {}, {});
    await vi.waitFor(() => expect(writeHttp).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
  });

  it('stops pre-open HTTP fallback after its first failed write', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '4';
    const failure = new Error('first HTTP write failed');
    const { session, writeHttp } = makeSession();
    writeHttp.mockRejectedValueOnce(failure);
    const writes = [
      session.write(0, ['one']),
      session.write(1, ['two']),
      session.write(2, ['three']),
    ];
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit('unexpected-response', {}, {});

    for (const write of writes) {
      await expect(write).rejects.toBe(failure);
    }
    expect(writeHttp).toHaveBeenCalledTimes(1);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
  });

  it('uses the same bounded decision when close is the first operation', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession();
    const closing = session.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect((await decodeOne(sockets[0].sent[0])).meta).toEqual({
      type: 'close',
      reqId: 1,
    });
    sockets[0].reply(
      encodeFrame({ type: 'close_ack', reqId: 1 }, new Uint8Array())
    );

    await closing;
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('sends serialized write and close frames after OPEN', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    expect(injectTraceContextIntoHeaders).toHaveBeenCalledTimes(1);
    socket.open();

    const writing = session.write(4, ['hi']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const write = await decodeOne(socket.sent[0]);
    expect(write.meta).toEqual({
      type: 'write',
      reqId: 1,
      chunkSeq: 4,
      numChunks: 1,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;

    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await decodeOne(socket.sent[1])).meta).toEqual({
      type: 'close',
      reqId: 2,
    });
    socket.reply(
      encodeFrame({ type: 'close_ack', reqId: 2 }, new Uint8Array())
    );
    await vi.waitFor(() =>
      expect(socket.closed).toContainEqual([1000, 'stream closed'])
    );
    socket.emit('close', 1000);
    await closing;

    expect(socket.closed).toContainEqual([1000, 'stream closed']);
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('splits groups above the v1 request-work limit without resetting sequence', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const chunks = Array.from({ length: 1001 }, () => new Uint8Array([1]));
    const writing = session.write(9, chunks);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect((await decodeOne(socket.sent[0])).meta).toMatchObject({
      chunkSeq: 9,
      numChunks: 1000,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await decodeOne(socket.sent[1])).meta).toMatchObject({
      chunkSeq: 1009,
      numChunks: 1,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );
    await writing;
  });

  it('caps split-group frames at the global pipeline depth', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '2';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(
      0,
      Array.from({ length: 2001 }, () => new Uint8Array([1]))
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await decodeOne(socket.sent[0])).meta).toMatchObject({
      reqId: 1,
      chunkSeq: 0,
      numChunks: 1000,
    });
    expect((await decodeOne(socket.sent[1])).meta).toMatchObject({
      reqId: 2,
      chunkSeq: 1000,
      numChunks: 1000,
    });
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect((await decodeOne(socket.sent[2])).meta).toMatchObject({
      reqId: 3,
      chunkSeq: 2000,
      numChunks: 1,
    });
    for (const reqId of [2, 3]) {
      socket.reply(encodeFrame({ type: 'write_ack', reqId }, new Uint8Array()));
    }
    await writing;
  });

  it('poisons a synchronous frame-build failure without stale pending work', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    await expect(
      session.write(0, [new Uint8Array(10 * 1024 * 1024 + 1)])
    ).rejects.toThrow('maximum is 10485760');
    await expect(session.write(0, ['later'])).rejects.toThrow(
      'maximum is 10485760'
    );
    expect(sockets[0].sent).toHaveLength(0);
  });

  it('poisons a synchronous socket send failure without stale pending work', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].throwOnSend = new Error('sync send failed');

    await expect(session.write(0, ['one'])).rejects.toThrow('sync send failed');
    await expect(session.write(0, ['later'])).rejects.toThrow(
      'sync send failed'
    );
  });

  it('bounds and correlates pipelined writes by reqId', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '4';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const writes = Array.from({ length: 5 }, (_, index) =>
      session.write(index, [new Uint8Array([index])])
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    const metas = await Promise.all(
      socket.sent.map((frame) => decodeOne(frame))
    );
    expect(metas.map(({ meta }) => meta)).toMatchObject([
      { reqId: 1, chunkSeq: 0 },
      { reqId: 2, chunkSeq: 1 },
      { reqId: 3, chunkSeq: 2 },
      { reqId: 4, chunkSeq: 3 },
    ]);

    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 3 }, new Uint8Array())
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(5));
    expect((await decodeOne(socket.sent[4])).meta).toMatchObject({
      reqId: 5,
      chunkSeq: 4,
    });
    for (const reqId of [1, 2, 4, 5]) {
      socket.reply(encodeFrame({ type: 'write_ack', reqId }, new Uint8Array()));
    }
    await Promise.all(writes);
  });

  it('ignores a duplicate acknowledgement for a completed request', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '2';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const first = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const ack = encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array());
    socket.reply(ack);
    await first;
    socket.reply(ack);

    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );
    await expect(second).resolves.toBeUndefined();
  });

  it('does not send close until every pipelined write is acknowledged', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '2';
    const { session } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const first = session.write(0, ['one']);
    const second = session.write(1, ['two']);
    const closing = session.close();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );
    await second;
    expect(socket.sent).toHaveLength(2);
    socket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await first;
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect((await decodeOne(socket.sent[2])).meta).toEqual({
      type: 'close',
      reqId: 3,
    });
    socket.reply(
      encodeFrame({ type: 'close_ack', reqId: 3 }, new Uint8Array())
    );
    await closing;
  });

  it('poisons every pipelined write when one request times out', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '2';
    process.env.WORKFLOW_REQUEST_TIMEOUT_MS = '10000';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    vi.useFakeTimers();
    try {
      const writes = [session.write(0, ['one']), session.write(1, ['two'])];
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      for (const write of writes) {
        await expect(write).rejects.toThrow('timed out with no reply');
      }
      // A late success cannot make an already-unknown outcome reusable.
      socket.reply(
        encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
      );
      await expect(session.write(2, ['later'])).rejects.toThrow(
        'timed out with no reply'
      );
      expect(writeHttp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      delete process.env.WORKFLOW_REQUEST_TIMEOUT_MS;
    }
  });

  it('rejects every pipelined write on an unknown socket outcome', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '2';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writes = [
      session.write(0, ['one']),
      session.write(1, ['two']),
      session.write(2, ['three']),
    ];
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    socket.emit('close');
    for (const write of writes) {
      await expect(write).rejects.toThrow('closed before reply');
    }
    expect(socket.sent).toHaveLength(2);
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons all pipelined writes after an earlier server error', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    process.env.WORKFLOW_STREAM_WRITE_PIPELINE_DEPTH = '4';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writes = Array.from({ length: 5 }, (_, index) =>
      session.write(index, [new Uint8Array([index])])
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    socket.reply(
      encodeFrame(
        { type: 'error', reqId: 1, status: 429, message: 'fail stop' },
        new Uint8Array()
      )
    );
    for (const write of writes)
      await expect(write).rejects.toThrow('fail stop');
    expect(socket.sent).toHaveLength(4);
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons a correlated server error and prevents queued work', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const writing = session.write(0, ['one']);
    const queued = session.write(1, ['two']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        { type: 'error', reqId: 1, status: 429, message: 'try later' },
        new Uint8Array()
      )
    );

    await expect(writing).rejects.toThrow('try later');
    await expect(queued).rejects.toThrow('try later');
    expect(socket.sent).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('bounds idle clean-close reconnects with the same writer id', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    makeSession();
    for (let attempt = 0; attempt < 4; attempt++) {
      await vi.waitFor(() => expect(sockets).toHaveLength(attempt + 1));
      const socket = sockets[attempt];
      expect(new URL(socket.url).searchParams.get('writerId')).toBe(writerId);
      socket.open();
      socket.emit('close', 1001);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(4);
  });

  it('poisons an unknown write outcome and never replays over HTTP', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();

    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit('close');

    await expect(writing).rejects.toThrow('closed before reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'closed before reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('tombstones and cleans up a pre-OPEN decline', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const response = { resume: vi.fn(), destroy: vi.fn() };
    sockets[0].emit('unexpected-response', {}, response);

    await session.write(0, ['one']);
    await session.write(1, ['two']);
    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(response.resume).toHaveBeenCalledTimes(1);
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(sockets[0].closed).toContainEqual([1000, 'upgrade declined']);
    expect(sockets).toHaveLength(1);
  });

  it('disposes the streamer wrapper before its dynamic session materializes', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { createStreamer } = await import('./streamer.js');
    const session = createStreamer({
      token: 'token',
    }).streams.createWriteSession?.('wrun_1', 'stream/1', { writerId });
    await session?.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(0);
  });

  it('forwards streamer-wrapper disposal after session materialization', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { createStreamer } = await import('./streamer.js');
    const session = createStreamer({
      token: 'token',
    }).streams.createWriteSession?.('wrun_1', 'stream/1', { writerId });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await session?.dispose?.();
    expect(sockets[0].closed).toContainEqual([1000, 'stream writer disposed']);
  });

  it('disposes transport without sending protocol close', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    await session.dispose?.();
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'stream writer disposed']);
    expect(closeHttp).not.toHaveBeenCalled();
  });
});
