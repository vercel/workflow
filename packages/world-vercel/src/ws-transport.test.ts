/**
 * Unit coverage for the WS events transport's failure and lifecycle paths.
 *
 * These are the parts that are effectively unreachable from the e2e suite:
 * they need a socket to break at a specific moment (a send that fails
 * mid-flight, an error after open, a superseded socket closing late), which
 * a live deployment won't reproduce on demand. The happy path is already
 * covered end-to-end by the `e2e-vercel-ws-transport` jobs, so the emphasis
 * here is "nothing hangs and nothing is silent".
 *
 * `ws` is replaced with a fake we can drive directly — the real one needs a
 * live server to reach `'open'`. Fake timers throughout so the reconnect
 * backoff is deterministic and a microtask flush is a single `tick()`.
 */

import { decode } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFrame } from './frames.js';
import { REQUEST_TIMEOUT_MS } from './http-core.js';
import {
  getWsEventsTransport,
  isWsEventsTransportEnabled,
  resetWsEventsTransportsForTest,
  resolveWsTransport,
  toEventsWsUrl,
  warmWsEventsTransport,
} from './ws-transport.js';

type Listener = (...args: unknown[]) => void;

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = 0;
    binaryType = '';
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly sent: Uint8Array[] = [];
    /** Queued failures for upcoming `send` calls. */
    readonly sendErrors: Error[] = [];
    private readonly listeners = new Map<string, Listener[]>();

    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers ?? {};
      sockets.push(this);
    }

    on(event: string, cb: Listener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
    }

    send(data: Uint8Array, cb?: (err?: Error) => void): void {
      const err = this.sendErrors.shift();
      if (err) {
        cb?.(err);
        return;
      }
      this.sent.push(data);
      cb?.();
    }

    close(code = 1000): void {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', code);
    }

    // ---- test drivers ----

    /** Complete the handshake. */
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }

    /** Fail the handshake the way `ws` does: 'error', then 'close'. */
    failHandshake(err = new Error('ECONNREFUSED')): void {
      this.emit('error', err);
      this.close(1006);
    }

    /** An error on an already-open socket (broken pipe, protocol fault). */
    errorAfterOpen(err = new Error('EPIPE')): void {
      this.emit('error', err);
    }

    /**
     * Half-dead: no longer usable for new work (so the transport will open
     * a replacement) but hasn't emitted `'close'` yet — the window in which
     * a superseded socket can still fire a late close.
     */
    stall(): void {
      this.readyState = FakeSocket.CLOSING;
    }

    deliver(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }

  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const WS_URL = 'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_test';
const EMPTY = new Uint8Array(0);

/** Flush pending microtasks (and any timers due right now). */
const tick = () => vi.advanceTimersByTimeAsync(0);

/** Build a request frame the way `postEventFrameOverWs` does. */
const eventFrame = (reqId: number) =>
  encodeFrame(
    { reqId, type: 'event', event: { eventType: 'run_created' } },
    EMPTY
  );

/** An `event_ack` reply for `reqId`. */
const ackFrame = (reqId: number, status = 201, body = EMPTY) =>
  encodeFrame({ reqId, type: 'event_ack', status }, body);

/** Read the `reqId`s off the frames this transport put on the wire. */
const sentReqIds = (socket: { sent: Uint8Array[] }): unknown[] =>
  socket.sent.map((raw) => {
    const metaLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(0, false);
    const meta = decode(raw.subarray(4, 4 + metaLen)) as { reqId?: unknown };
    return meta.reqId;
  });

const latest = () => sockets[sockets.length - 1];

/**
 * Start a request and let its socket finish the handshake. The returned
 * promise already has a no-op rejection handler attached so tests that
 * don't assert on it can't trip an unhandled-rejection warning.
 */
async function connectAndSend(
  transport: ReturnType<typeof getWsEventsTransport>
) {
  const promise = transport.request(eventFrame);
  void promise.catch(() => {});
  await tick();
  const socket = latest();
  socket.open();
  await tick();
  return { promise, socket };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.WORKFLOW_REQUEST_TIMEOUT_MS;
});

const headers = async () => ({ authorization: 'Bearer token-1' });

const loggedErrors = () =>
  errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');

describe('toEventsWsUrl', () => {
  it('upgrades the scheme and scopes the path to one run', () => {
    expect(toEventsWsUrl('https://vercel-workflow.com/api', 'wrun_abc')).toBe(
      'wss://vercel-workflow.com/api/websockets/v1/runs/wrun_abc'
    );
  });

  it('uses ws: for a plaintext base URL and encodes the runId', () => {
    expect(toEventsWsUrl('http://localhost:3000/api/', 'a/b')).toBe(
      'ws://localhost:3000/api/websockets/v1/runs/a%2Fb'
    );
  });
});

describe('request/reply', () => {
  it('resolves a request with the reply frame matched by reqId', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    expect(socket.sent).toHaveLength(1);

    socket.deliver(ackFrame(1, 201, new Uint8Array([1, 2])));
    await tick();

    await expect(promise).resolves.toMatchObject({
      meta: { reqId: 1, type: 'event_ack', status: 201 },
      body: new Uint8Array([1, 2]),
    });
  });

  it('multiplexes concurrent requests and matches each reply to its caller', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise: first, socket } = await connectAndSend(transport);
    const second = transport.request(eventFrame);
    await tick();

    expect(sentReqIds(socket)).toEqual([1, 2]);

    // Replies arrive out of order — correlation is by reqId, not arrival.
    socket.deliver(ackFrame(2, 200));
    socket.deliver(ackFrame(1, 201));
    await tick();

    await expect(second).resolves.toMatchObject({ meta: { reqId: 2 } });
    await expect(first).resolves.toMatchObject({ meta: { reqId: 1 } });
  });
});

describe('per-connection reqId and pending map', () => {
  it('restarts reqId at 1 on a new connection', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.deliver(ackFrame(1));
    await tick();
    await promise;

    socket.close(1001);
    await tick();

    const { socket: second } = await connectAndSend(transport);
    // The protocol defines reqId as a per-connection counter; a
    // transport-wide counter would have put 2 on the wire here.
    expect(sentReqIds(second)).toEqual([1]);
  });

  it("a superseded socket's late close cannot reject the live socket's request", async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket: first } = await connectAndSend(transport);
    // Take the first socket out of rotation without emitting 'close' yet.
    first.stall();

    const { promise: live, socket: second } = await connectAndSend(transport);
    expect(second).not.toBe(first);

    // The stale socket finally closes. Its reqId 1 is the same id the live
    // socket is waiting on — one shared pending map would reject it here.
    first.close(1006);
    await tick();

    second.deliver(ackFrame(1, 201));
    await tick();
    await expect(live).resolves.toMatchObject({ meta: { reqId: 1 } });
  });

  it('fails the requests riding a socket when it closes', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.close(1001);
    await tick();

    await expect(promise).rejects.toThrow(/connection closed \(code 1001\)/);
  });
});

describe('failures are never silent', () => {
  it('rejects the request when send fails instead of hanging', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const promise = transport.request(eventFrame);
    void promise.catch(() => {});
    await tick();
    // `ws.send()` reports a non-OPEN socket through its callback rather
    // than throwing; without that callback wired up, this request would
    // never settle.
    latest().sendErrors.push(new Error('WebSocket is not open'));
    latest().open();
    await tick();

    await expect(promise).rejects.toThrow(/WebSocket is not open/);
  });

  it('logs a post-open socket error and tears the connection down', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.errorAfterOpen(new Error('EPIPE'));
    await tick();

    expect(loggedErrors()).toContain('socket error');
    expect(loggedErrors()).toContain('EPIPE');
    // The error handler closes explicitly, so in-flight work fails fast
    // instead of waiting on a dead socket.
    await expect(promise).rejects.toThrow(/connection closed/);
  });

  /**
   * The three ways a reply can arrive that no caller can be matched to. Each
   * one used to log and return — which left the request that provoked it in
   * `pending` with nothing in existence that could ever settle it, so the
   * caller hung until the server's own drain (~680s from connect), typically
   * past the invocation's `maxDuration`. The frame is unanswerable either way;
   * the only choice is whether the waiter finds out.
   */
  describe.each([
    [
      'an undecodable frame',
      () => new Uint8Array([0, 0, 0]),
      'could not decode',
    ],
    [
      'the reserved malformed-frame sentinel',
      () =>
        encodeFrame(
          { reqId: -1, type: 'error', status: 400 },
          new TextEncoder().encode(JSON.stringify({ message: 'bad frame' }))
        ),
      'malformed-frame error',
    ],
    [
      'a reply with a non-numeric reqId',
      () =>
        encodeFrame({ reqId: 'one', type: 'event_ack', status: 201 }, EMPTY),
      'no numeric reqId',
    ],
  ])('%s', (_name, frame, logged) => {
    it('is logged loudly', async () => {
      const transport = getWsEventsTransport(WS_URL, headers);
      const { socket } = await connectAndSend(transport);

      socket.deliver(frame());
      await tick();

      expect(loggedErrors()).toContain(logged);
    });

    it('fails the in-flight request instead of leaving it to hang', async () => {
      const transport = getWsEventsTransport(WS_URL, headers);
      const { promise, socket } = await connectAndSend(transport);

      socket.deliver(frame());
      await tick();

      await expect(promise).rejects.toThrow(/events WS transport/);
    });

    it('drops the connection so the next write gets a fresh socket', async () => {
      const transport = getWsEventsTransport(WS_URL, headers);
      const { socket } = await connectAndSend(transport);
      const before = sockets.length;

      socket.deliver(frame());
      await tick();
      // The `close` handler's eager reconnect fires on the backoff timer.
      await vi.advanceTimersByTimeAsync(1000);

      expect(sockets.length).toBeGreaterThan(before);
      expect(latest()).not.toBe(socket);
    });
  });

  it("surfaces the server's message on a malformed-frame error", async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket } = await connectAndSend(transport);

    socket.deliver(
      encodeFrame(
        { reqId: -1, type: 'error', status: 400 },
        new TextEncoder().encode(JSON.stringify({ message: 'bad frame' }))
      )
    );
    await tick();

    // Not just the sentinel id: why the server rejected our frame is the only
    // thing that makes this actionable, since it is a bug on this side.
    expect(loggedErrors()).toContain('bad frame');
  });

  it('logs but tolerates a reply that matches no in-flight request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    socket.deliver(ackFrame(999));
    await tick();

    expect(loggedErrors()).toContain('unknown reqId 999');
    // The deliberate exception to the three cases above: an id nobody is
    // waiting on means that request already settled (a send error, or its own
    // deadline with the reply arriving late), so nothing is orphaned — while
    // the request still in flight has done nothing wrong. Failing its socket
    // would punish it for a race that resolved correctly.
    expect(settled).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it('fails a request that never gets a reply, rather than waiting for the drain', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    expect(socket.sent).toHaveLength(1);

    // A server that acks nothing and never closes: no error, no drain, no
    // frame. Before the deadline the only thing that ended this wait was the
    // invocation's own SIGTERM.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

    await expect(promise).rejects.toThrow(/timed out after/);
  });

  it('takes the silent connection down with the timed-out request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    void promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(1000);

    // A socket that swallowed a request is not the one to send the retry on.
    expect(latest()).not.toBe(socket);
  });

  it('disarms the deadline once a reply lands', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.deliver(ackFrame(1));
    await tick();
    await expect(promise).resolves.toMatchObject({ meta: { reqId: 1 } });

    // A deadline left armed would later fail a connection the caller is long
    // done with — and on a reused socket, the unrelated writes riding it.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    expect(loggedErrors()).not.toContain('timed out');
  });

  it('logs a drain notice without settling in-flight work', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    socket.deliver(encodeFrame({ type: 'drain', graceMs: 10_000 }, EMPTY));
    await tick();

    expect(logSpy.mock.calls.map((a) => a.join(' ')).join('\n')).toContain(
      'drain notice'
    );
    expect(settled).toBe(false);
  });
});

describe('eager reconnect', () => {
  it('reopens the socket after an unexpected close, with no new request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    socket.close(1001);
    await tick();
    await expect(promise).rejects.toThrow();

    // Nothing is asking for a socket — the reconnect runs off its own timer.
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
  });

  it('resolves headers again on reconnect so the new socket gets a fresh token', async () => {
    let n = 0;
    const rotating = async () => ({ authorization: `Bearer token-${++n}` });
    const transport = getWsEventsTransport(WS_URL, rotating);

    const { promise, socket } = await connectAndSend(transport);
    expect(socket.headers.authorization).toBe('Bearer token-1');

    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(2);
    // The frozen-token problem is per socket: a reconnect must not replay
    // the token the previous socket was opened with.
    expect(sockets[1].headers.authorization).toBe('Bearer token-2');
  });

  it('resolves headers once per socket, not once per request', async () => {
    const getHeaders = vi.fn(async () => ({ authorization: 'Bearer t' }));
    const transport = getWsEventsTransport(WS_URL, getHeaders);

    const { socket } = await connectAndSend(transport);
    void transport.request(eventFrame).catch(() => {});
    void transport.request(eventFrame).catch(() => {});
    await tick();

    expect(socket.sent).toHaveLength(3);
    expect(getHeaders).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap and leaves the retry to the next request', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    // Every reconnect attempt now fails its handshake. Backoff is
    // exponential from 100ms, capped at 5s, so 10s per iteration covers
    // each attempt with room to spare.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      if (latest().readyState === 0) {
        latest().failHandshake();
        await tick();
      }
    }

    // 1 original + at most RECONNECT_MAX_ATTEMPTS reconnect attempts.
    expect(sockets.length).toBeLessThanOrEqual(6);
    expect(loggedErrors()).toContain('giving up eager reconnect');
  });

  it('reconnects lazily on the next request after giving up', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);
    socket.close(1006);
    await tick();
    await expect(promise).rejects.toThrow();

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      if (latest().readyState === 0) {
        latest().failHandshake();
        await tick();
      }
    }
    const afterGivingUp = sockets.length;

    void transport.request(eventFrame).catch(() => {});
    await tick();

    expect(sockets.length).toBe(afterGivingUp + 1);
  });

  it('does not reconnect when a newer socket is already live', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise: first, socket } = await connectAndSend(transport);

    // Stale socket steps aside and a new one takes over...
    socket.stall();
    const { socket: second } = await connectAndSend(transport);
    expect(second).not.toBe(socket);

    // ...and only now does the stale one emit its close.
    socket.close(1006);
    await tick();
    await expect(first).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
  });
});

/**
 * Without an idle release the transport is immortal by construction: eager
 * reconnect renews the socket forever, and the server pins an invocation per
 * connection, so a warm container would hold a live socket and a live server
 * invocation for every run it had ever served. These pin the release and the
 * revive, since getting either wrong is invisible in a passing e2e run.
 */
describe('idle teardown', () => {
  /** Comfortably past IDLE_TIMEOUT_MS (60s). */
  const PAST_IDLE_MS = 61_000;

  /** Run one request all the way to its ack, so the idle timer can arm. */
  async function completeRequest(
    transport: ReturnType<typeof getWsEventsTransport>
  ) {
    const { promise, socket } = await connectAndSend(transport);
    socket.deliver(ackFrame(sentReqIds(socket)[0] as number));
    await promise;
    return socket;
  }

  it('closes the socket after an idle window with no writes', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const socket = await completeRequest(transport);
    expect(socket.readyState).toBe(1);

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    expect(socket.readyState).toBe(3);
  });

  it('does not reconnect the socket it just released', async () => {
    // The teardown closes the socket, which fires the same `close` handler
    // an unexpected drop would — without the `closed` guard the eager
    // reconnect would immediately undo the release.
    const transport = getWsEventsTransport(WS_URL, headers);
    await completeRequest(transport);

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
  });

  it('evicts itself from the process-wide cache', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    await completeRequest(transport);
    expect(getWsEventsTransport(WS_URL, headers)).toBe(transport);

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    expect(getWsEventsTransport(WS_URL, headers)).not.toBe(transport);
  });

  it('stays open while a request is still in flight', async () => {
    // The idle window and the default request deadline are both 60s, so a
    // request cannot outlive the idle window without also outliving its own
    // deadline (which fails it and drops the socket — see 'fails a request
    // that never gets a reply'). Raise the deadline to isolate what this test
    // is actually about: that `inFlight > 0` suppresses the idle teardown.
    process.env.WORKFLOW_REQUEST_TIMEOUT_MS = String(PAST_IDLE_MS * 10);
    const transport = getWsEventsTransport(WS_URL, headers);
    const { promise, socket } = await connectAndSend(transport);

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    expect(socket.readyState).toBe(1);

    socket.deliver(ackFrame(sentReqIds(socket)[0] as number));
    await expect(promise).resolves.toBeDefined();
  });

  it('revives on the next write rather than failing it', async () => {
    // A caller can hold a reference across the idle window; that write must
    // still land, just paying one handshake.
    const transport = getWsEventsTransport(WS_URL, headers);
    await completeRequest(transport);
    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    const second = await completeRequest(transport);

    expect(sockets).toHaveLength(2);
    expect(second.readyState).toBe(1);
    // ...and it re-registers itself, so the cache doesn't hand out a
    // second live transport for the same run.
    expect(getWsEventsTransport(WS_URL, headers)).toBe(transport);
  });
});

describe('eager warm', () => {
  /** Comfortably past IDLE_TIMEOUT_MS (60s). */
  const PAST_IDLE_MS = 61_000;

  it('opens the socket with no write to trigger it', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);

    transport.warm();
    await tick();

    expect(sockets).toHaveLength(1);
    expect(latest().headers.authorization).toBe('Bearer token-1');
  });

  it('leaves the first write with no handshake left to pay for', async () => {
    // The point of the whole exercise: the write reuses the warmed socket
    // rather than opening a second one.
    const transport = getWsEventsTransport(WS_URL, headers);
    transport.warm();
    await tick();
    latest().open();
    await tick();

    const promise = transport.request(eventFrame);
    await tick();

    expect(sockets).toHaveLength(1);
    latest().deliver(ackFrame(sentReqIds(latest())[0] as number));
    await expect(promise).resolves.toBeDefined();
  });

  it('joins an in-flight handshake instead of racing a second one', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);

    transport.warm();
    transport.warm();
    await tick();
    // A write arriving mid-handshake joins the same connect.
    void transport.request(eventFrame).catch(() => {});
    await tick();

    expect(sockets).toHaveLength(1);
  });

  it('is a no-op once the socket is live', async () => {
    const transport = getWsEventsTransport(WS_URL, headers);
    const { socket } = await connectAndSend(transport);

    transport.warm();
    await tick();

    expect(sockets).toHaveLength(1);
    expect(socket.readyState).toBe(1);
  });

  it('releases a warmed socket that never gets a write', async () => {
    // Warming arms the idle timer as if a request had settled. Without that,
    // an invocation that warms but never writes — a health probe carrying the
    // run id it is about to create — would strand a socket, and the socket is
    // not `unref`'d, so it holds this process and a server invocation open.
    const transport = getWsEventsTransport(WS_URL, headers);
    transport.warm();
    await tick();
    const socket = latest();
    socket.open();
    await tick();
    expect(socket.readyState).toBe(1);

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);

    expect(socket.readyState).toBe(3);
  });

  it('does not adopt a socket that opens after the release', async () => {
    // `close()` can only drop the connection it can see, and a handshake still
    // in flight isn't one yet — so the release lands while this socket is
    // still CONNECTING, and it must not install itself on the way in.
    const transport = getWsEventsTransport(WS_URL, headers);
    transport.warm();
    await tick();
    const socket = latest();

    await vi.advanceTimersByTimeAsync(PAST_IDLE_MS);
    socket.open();
    await tick();

    expect(socket.readyState).toBe(3);
    // Nothing adopted it, so the next write opens its own socket.
    void transport.request(eventFrame).catch(() => {});
    await tick();
    expect(sockets).toHaveLength(2);
  });

  it('leaves a failed warm to the next write, with no reconnect loop', async () => {
    // A never-opened first connect is the one case `connect` declines to
    // retry, and warming must not change that: no backoff loop for a run that
    // may never write, and the write itself still gets its own attempt.
    const transport = getWsEventsTransport(WS_URL, headers);
    transport.warm();
    await tick();
    latest().failHandshake();
    await tick();
    // Loud either way — a warm nobody awaits is exactly the case where the
    // log is the only signal the socket failed to come up.
    expect(loggedErrors()).toContain('socket error');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);

    const { socket } = await connectAndSend(transport);
    expect(sockets).toHaveLength(2);
    expect(socket.readyState).toBe(1);
  });
});

/**
 * workflow-server tags a `drain` with why it is closing. `max_duration` means
 * the socket aged out and a plain reconnect is right; `auth_expiry` means the
 * *bearer* ran out, and reconnecting with the same one just earns a 401.
 */
describe('drain reason', () => {
  const drainFrame = (reason?: string) =>
    encodeFrame(
      { type: 'drain', graceMs: 5_000, ...(reason ? { reason } : {}) },
      EMPTY
    );

  /** Headers thunk that records the `forceRefresh` flag it was called with
   *  and hands out a different bearer each time when asked to rotate. */
  const trackingHeaders = (tokens: string[]) => {
    const calls: boolean[] = [];
    let i = 0;
    const fn = async ({ forceRefresh }: { forceRefresh: boolean }) => {
      calls.push(forceRefresh);
      const token = tokens[Math.min(i, tokens.length - 1)];
      i++;
      return { authorization: `Bearer ${token}` };
    };
    return { fn, calls };
  };

  it('asks for a refreshed token after an auth_expiry drain', async () => {
    const { fn, calls } = trackingHeaders(['token-1', 'token-2']);
    const transport = getWsEventsTransport(WS_URL, fn);
    const { socket } = await connectAndSend(transport);

    socket.deliver(drainFrame('auth_expiry'));
    await tick();
    socket.close(1001);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toEqual([false, true]);
    expect(latest().headers.authorization).toBe('Bearer token-2');
  });

  it('does not ask for a refresh on an ordinary max_duration drain', async () => {
    const { fn, calls } = trackingHeaders(['token-1']);
    const transport = getWsEventsTransport(WS_URL, fn);
    const { socket } = await connectAndSend(transport);

    socket.deliver(drainFrame('max_duration'));
    await tick();
    socket.close(1001);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toEqual([false, false]);
  });

  it('treats a drain with no reason as max_duration', async () => {
    // Servers predating the field only ever drained for maxDuration.
    const { fn, calls } = trackingHeaders(['token-1']);
    const transport = getWsEventsTransport(WS_URL, fn);
    const { socket } = await connectAndSend(transport);

    socket.deliver(drainFrame());
    await tick();
    socket.close(1001);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toEqual([false, false]);
  });

  it('stops reconnecting when the refresh yields the same token', async () => {
    // Inside a Vercel function the bearer is the invocation's own and can't
    // be refreshed mid-invocation. Reconnecting would 401 five times and
    // burn the attempt budget; the next write (likely a new invocation with
    // a new token) is the thing worth waiting for.
    const { fn } = trackingHeaders(['token-1']);
    const transport = getWsEventsTransport(WS_URL, fn);
    const { socket } = await connectAndSend(transport);

    socket.deliver(drainFrame('auth_expiry'));
    await tick();
    socket.close(1001);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(1);
    expect(loggedErrors()).toContain('same token');
  });

  it('still reconnects lazily once a new token is available', async () => {
    const tokens = ['token-1', 'token-1', 'token-2'];
    const { fn } = trackingHeaders(tokens);
    const transport = getWsEventsTransport(WS_URL, fn);
    const { socket } = await connectAndSend(transport);

    socket.deliver(drainFrame('auth_expiry'));
    await tick();
    socket.close(1001);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);

    // A later write, by which point the process is serving a new invocation.
    const { socket: revived } = await connectAndSend(transport);
    expect(revived.headers.authorization).toBe('Bearer token-2');
  });
});

/**
 * Which transport a write takes, and which socket it takes it on — the layer
 * `createWorkflowRunEventV4` and the queue handler call into. Covered here
 * rather than in `events-v4-ws.test.ts` because that file mocks
 * `resolveWsTransport` wholesale (it has to: the URL resolution and the header
 * thunk are intra-module calls that an export-level mock cannot intercept), so
 * this is the only place the real selection code runs.
 */
describe('transport selection', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_EVENTS_TRANSPORT;
  });

  /** A World that routes through the api-workflow proxy. */
  const proxyConfig = {
    token: 'test-token',
    projectConfig: { projectId: 'prj_1', teamId: 'team_1' },
  };
  const directConfig = { token: 'test-token' };

  /**
   * The gate is the whole safety story for this feature: everything else is
   * dead code for anyone who hasn't opted in. Nothing on the HTTP side pins
   * the *choice* of path — a future edit that flipped the default (as an
   * earlier revision of this branch did deliberately, for benchmarking) would
   * sail through with every HTTP assertion still green, because the two
   * transports are built to be indistinguishable at the result layer.
   */
  describe('isWsEventsTransportEnabled', () => {
    it.each([
      ['ws', true],
      ['http', false],
      ['', false],
      ['WS', false],
    ])('%o resolves to ws=%o', (value, expected) => {
      process.env.WORKFLOW_EVENTS_TRANSPORT = value;
      expect(isWsEventsTransportEnabled()).toBe(expected);
    });

    it('defaults to HTTP when unset', () => {
      expect(isWsEventsTransportEnabled()).toBe(false);
    });
  });

  describe('resolveWsTransport', () => {
    it('scopes the transport to one run and memoizes it per URL', () => {
      const first = resolveWsTransport('wrun_1', directConfig);
      const second = resolveWsTransport('wrun_1', directConfig);

      expect(first?.wsUrl).toContain('/websockets/v1/runs/wrun_1');
      expect(second?.transport).toBe(first?.transport);
      expect(resolveWsTransport('wrun_2', directConfig)?.transport).not.toBe(
        first?.transport
      );
    });

    it('mints no token and opens no socket until something writes', async () => {
      // The transport is handed a thunk it calls at connect time. Resolving a
      // header record here instead would mean minting a token on every write
      // and discarding all but the first — this runs on the hot path.
      const resolved = resolveWsTransport('wrun_1', directConfig);
      await tick();
      expect(sockets).toHaveLength(0);

      resolved?.transport.warm();
      await tick();

      expect(sockets).toHaveLength(1);
      expect(latest().headers.authorization).toBe('Bearer test-token');
    });

    it('returns null for a World behind the api-workflow proxy', () => {
      // That gateway does not forward a raw upgrade, so the caller has to fall
      // back to HTTP rather than attempt a connection it can't serve.
      expect(resolveWsTransport('wrun_1', proxyConfig)).toBeNull();
      expect(sockets).toHaveLength(0);
    });

    it('logs the proxy fallback and the ws-in-use notice once per process', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      resolveWsTransport('wrun_1', proxyConfig);
      resolveWsTransport('wrun_2', proxyConfig);
      resolveWsTransport('wrun_1', directConfig);
      resolveWsTransport('wrun_2', directConfig);

      // Every event takes this path, so a per-request line would be noise.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(
        logSpy.mock.calls.filter(([m]) => String(m).includes('using ws'))
      ).toHaveLength(1);
    });
  });

  /**
   * The queue handler calls this on every message, for every World — including
   * the HTTP default and the proxy World that can't speak WS at all. So "does
   * nothing, quietly" is as much the contract here as the warm itself: a throw
   * or an await would land on the critical path of every invocation, WS or not.
   */
  describe('warmWsEventsTransport', () => {
    it('opens the run’s socket when the gate is on', async () => {
      process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';

      warmWsEventsTransport('wrun_1', directConfig);
      await tick();

      expect(sockets).toHaveLength(1);
      expect(latest().url).toContain('/websockets/v1/runs/wrun_1');
    });

    it('does nothing when the gate is off', async () => {
      warmWsEventsTransport('wrun_1', directConfig);
      await tick();

      expect(sockets).toHaveLength(0);
    });

    it('does nothing for a World behind the api-workflow proxy', async () => {
      process.env.WORKFLOW_EVENTS_TRANSPORT = 'ws';
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      warmWsEventsTransport('wrun_1', proxyConfig);
      await tick();

      expect(sockets).toHaveLength(0);
    });
  });
});
