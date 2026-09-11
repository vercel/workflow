import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrames, encodeFrame } from './frames.js';

const {
  FakeWebSocket,
  getVercelOidcToken,
  injectTraceContextIntoHeaders,
  sockets,
  writeSpans,
} = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = '';
    sent: Uint8Array[] = [];
    closed: Array<[number, string]> = [];
    throwOnSend: Error | undefined;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

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
    getVercelOidcToken: vi.fn().mockResolvedValue(undefined),
    injectTraceContextIntoHeaders: vi.fn(),
    sockets,
    writeSpans: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('@vercel/oidc', () => ({ getVercelOidcToken }));
vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));
vi.mock('./telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry.js')>();
  return { ...actual, injectTraceContextIntoHeaders };
});
vi.mock('./http-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http-core.js')>();
  return {
    ...actual,
    withHttpClientSpan: vi.fn(async (options, callback) => {
      if (options.spanName !== 'workflow.stream.write') {
        return callback(undefined);
      }
      const attributes = { ...options.attributes };
      writeSpans.push(attributes);
      return callback({
        setAttributes(next: Record<string, unknown>) {
          Object.assign(attributes, next);
        },
      });
    }),
  };
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
const activeSessions: Array<{ dispose?(): void }> = [];

beforeEach(() => {
  sockets.length = 0;
  getVercelOidcToken.mockReset().mockResolvedValue(undefined);
  injectTraceContextIntoHeaders.mockClear();
  writeSpans.length = 0;
  delete process.env.WORKFLOW_STREAMS_TRANSPORT;
});

afterEach(() => {
  for (const session of activeSessions.splice(0)) session.dispose?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSession(
  config: { token?: string } | undefined = { token: 'token' }
) {
  const writeHttp = vi.fn().mockResolvedValue(undefined);
  const closeHttp = vi.fn().mockResolvedValue(undefined);
  const session = createStreamWriteSession(
    'wrun_1',
    'stream/1',
    writerId,
    config,
    writeHttp,
    closeHttp
  );
  activeSessions.push(session);
  return { session, writeHttp, closeHttp };
}

describe('v1 stream WebSocket writer lifecycle', () => {
  it('keeps HTTP as the default without constructing a socket', async () => {
    const { session, writeHttp, closeHttp } = makeSession();
    await session.write(0, ['one']);
    await session.close();

    expect(sockets).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
    expect(closeHttp).toHaveBeenCalledTimes(1);
  });

  it('sends immediately over HTTP while the initial socket connects, then switches to WS', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let releaseHttp: (() => void) | undefined;
    const httpPending = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const { session, writeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);

    const first = session.write(0, ['one']);
    await vi.waitFor(() =>
      expect(writeHttp).toHaveBeenCalledWith(
        ['one'],
        expect.objectContaining({
          'workflow.stream.ws.session_first_write': true,
          'workflow.stream.ws.connecting_at_write': true,
          'workflow.stream.ws.connection_attempt': 1,
        })
      )
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const second = session.write(1, ['two']);

    // Transport switching happens only after the HTTP group's outcome is
    // known, so the later WS sequence can never overtake it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets[0].sent).toHaveLength(0);
    releaseHttp?.();
    await first;
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    expect((await decodeOne(sockets[0].sent[0])).meta).toMatchObject({
      type: 'write',
      chunkSeq: 1,
    });
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await second;

    expect(writeSpans).toHaveLength(1);
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': false,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 1,
    });
    for (const attribute of [
      'workflow.stream.ws.session_to_write_ms',
      'workflow.stream.ws.write_wait_for_open_ms',
      'workflow.stream.ws.write_to_send_ms',
      'workflow.stream.ws.open_to_send_ms',
      'workflow.stream.ws.connect_ms',
      'workflow.stream.ws.config_token_ms',
      'workflow.stream.ws.send_to_reply_ms',
      'workflow.stream.ws.reply_processing_ms',
      'workflow.stream.ws.write_total_ms',
    ]) {
      expect(writeSpans[0][attribute]).toEqual(expect.any(Number));
      expect(writeSpans[0][attribute]).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses WS for the first write when the socket is already open', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    sockets[0].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );

    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.connection_first_write': true,
    });
  });

  it('tombstones to HTTP when the background connect budget expires', async () => {
    vi.useFakeTimers();
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    const first = session.write(0, ['one']);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeHttp).toHaveBeenCalledWith(
      ['one'],
      expect.objectContaining({
        'workflow.stream.ws.session_first_write': true,
        'workflow.stream.ws.connecting_at_write': true,
      })
    );
    await first;

    await vi.advanceTimersByTimeAsync(250);
    const second = session.write(1, ['two']);
    await second;
    expect(writeHttp).toHaveBeenCalledTimes(2);
    expect(writeHttp.mock.calls[0]?.[0]).toEqual(['one']);
    expect(writeHttp.mock.calls[1]).toEqual([['two']]);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([1000, 'connect budget expired']);
    sockets[0].open();
    expect(sockets[0].closed).toContainEqual([1000, 'HTTP fallback selected']);
  });

  it.each([
    'open',
    'decline',
  ] as const)('orders close behind an HTTP-first write when the socket ends in %s', async (outcome) => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let releaseHttp: (() => void) | undefined;
    const httpPending = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const { session, writeHttp, closeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(writeHttp).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const closing = session.close();
    if (outcome === 'open') {
      sockets[0].open();
    } else {
      sockets[0].emit('unexpected-response', {}, {});
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets[0].sent).toHaveLength(0);
    expect(closeHttp).not.toHaveBeenCalled();

    releaseHttp?.();
    await writing;
    if (outcome === 'open') {
      await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
      expect((await decodeOne(sockets[0].sent[0])).meta).toMatchObject({
        type: 'close',
      });
      sockets[0].reply(
        encodeFrame({ type: 'close_ack', reqId: 1 }, new Uint8Array())
      );
    }
    await closing;
    expect(closeHttp).toHaveBeenCalledTimes(outcome === 'decline' ? 1 : 0);
  });

  it('never sends later work over WS after an HTTP-first write fails', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    let rejectHttp: ((error: Error) => void) | undefined;
    const httpPending = new Promise<void>((_resolve, reject) => {
      rejectHttp = reject;
    });
    const { session, writeHttp } = makeSession();
    writeHttp.mockImplementationOnce(async () => httpPending);
    const first = session.write(0, ['one']);
    await vi.waitFor(() => expect(writeHttp).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    const second = session.write(1, ['two']);
    const error = new Error('HTTP outcome unknown');
    rejectHttp?.(error);

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(sockets[0].sent).toHaveLength(0);
    expect(writeHttp).toHaveBeenCalledTimes(1);
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

  it('falls back to HTTP when frame construction fails before send', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    await session.write(0, [oversized]);
    await session.write(1, ['later']);

    expect(writeHttp).toHaveBeenCalledTimes(2);
    expect(writeHttp.mock.calls[0]?.[0]?.[0]).toBe(oversized);
    expect(writeHttp.mock.calls[1]).toEqual([['later']]);
    expect(sockets[0].sent).toHaveLength(0);
    expect(sockets[0].closed).toContainEqual([
      1000,
      'HTTP fallback before send',
    ]);
  });

  it('falls back to HTTP when the socket is not open before send', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    socket.readyState = 3;

    await session.write(0, ['one']);
    await session.write(1, ['two']);

    expect(writeHttp.mock.calls).toEqual([[['one']], [['two']]]);
    expect(socket.sent).toHaveLength(0);
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

  it('surfaces an uncorrelated server error before poisoning', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp, closeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    socket.reply(
      encodeFrame(
        { type: 'error', status: 401, message: 'token expiring' },
        new Uint8Array()
      )
    );
    await vi.waitFor(() =>
      expect(socket.closed).toContainEqual([
        1011,
        'unknown stream write outcome',
      ])
    );

    await expect(session.write(0, ['later'])).rejects.toThrow(
      'stream WebSocket connection failed (401): token expiring'
    );
    await expect(session.close()).rejects.toThrow('token expiring');
    expect(writeHttp).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
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
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.send_to_reply_ms': expect.any(Number),
      'workflow.stream.ws.reply_processing_ms': expect.any(Number),
      'workflow.stream.ws.write_total_ms': expect.any(Number),
    });
  });

  it('drains admitted work before reconnecting queued writes', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = sockets[0];
    firstSocket.open();

    const first = session.write(0, ['one']);
    const second = session.write(1, ['two']);
    await vi.waitFor(() => expect(firstSocket.sent).toHaveLength(1));
    firstSocket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    firstSocket.reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await first;
    expect(firstSocket.sent).toHaveLength(1);

    firstSocket.emit('close', 1001);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const secondSocket = sockets[1];
    expect(new URL(secondSocket.url).searchParams.get('writerId')).toBe(
      writerId
    );
    secondSocket.open();
    await vi.waitFor(() => expect(secondSocket.sent).toHaveLength(1));
    expect((await decodeOne(secondSocket.sent[0])).meta).toMatchObject({
      type: 'write',
      reqId: 2,
      chunkSeq: 1,
    });
    secondSocket.reply(
      encodeFrame({ type: 'write_ack', reqId: 2 }, new Uint8Array())
    );

    await second;
    expect(writeHttp).not.toHaveBeenCalled();
    expect(writeSpans).toHaveLength(2);
    expect(writeSpans[0]).toMatchObject({
      'workflow.stream.ws.session_first_write': true,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 1,
    });
    expect(writeSpans[1]).toMatchObject({
      'workflow.stream.ws.session_first_write': false,
      'workflow.stream.ws.connection_first_write': true,
      'workflow.stream.ws.connection_attempt': 2,
    });
    expect(writeSpans[1]['workflow.stream.ws.connect_ms']).toEqual(
      expect.any(Number)
    );
  });

  it('requests fresh auth after an auth-expiry drain', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    getVercelOidcToken.mockResolvedValueOnce('old-token');
    getVercelOidcToken.mockResolvedValueOnce('refreshed-token');
    getVercelOidcToken.mockResolvedValueOnce('refreshed-token');
    const { session, writeHttp } = makeSession({});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].reply(
      encodeFrame(
        { type: 'drain', reason: 'auth_expiry', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0].emit('close', 1001);

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(getVercelOidcToken).toHaveBeenCalledWith({
      expirationBufferMs: 24 * 60 * 60 * 1000,
    });
    sockets[1].open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets[1].sent).toHaveLength(1));
    sockets[1].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );
    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('uses HTTP when auth refresh returns the drained bearer', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    getVercelOidcToken.mockResolvedValue('same-token');
    const { session, writeHttp } = makeSession({});
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].reply(
      encodeFrame(
        { type: 'drain', reason: 'auth_expiry', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0].emit('close', 1001);

    await session.write(0, ['one']);
    expect(sockets).toHaveLength(1);
    expect(writeHttp).toHaveBeenCalledWith(['one']);
  });

  it('forces reconnect when an idle drain outlives its grace', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = sockets[0];
    firstSocket.open();
    firstSocket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(firstSocket.closed).toContainEqual([
      1001,
      'stream drain grace expired',
    ]);
    sockets[1].open();
    await vi.waitFor(() => expect(sockets[1].sent).toHaveLength(1));
    sockets[1].reply(
      encodeFrame({ type: 'write_ack', reqId: 1 }, new Uint8Array())
    );

    await writing;
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons when drain grace expires before an admitted reply', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 1 },
        new Uint8Array()
      )
    );

    await expect(writing).rejects.toThrow('drain expired before request reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'drain expired before request reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
  });

  it('poisons when drain closes before an admitted reply', async () => {
    process.env.WORKFLOW_STREAMS_TRANSPORT = 'ws';
    const { session, writeHttp } = makeSession();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    socket.open();
    const writing = session.write(0, ['one']);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply(
      encodeFrame(
        { type: 'drain', reason: 'max_duration', graceMs: 10_000 },
        new Uint8Array()
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit('close', 1001);

    await expect(writing).rejects.toThrow('closed before reply');
    await expect(session.write(0, ['one'])).rejects.toThrow(
      'closed before reply'
    );
    expect(writeHttp).not.toHaveBeenCalled();
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
