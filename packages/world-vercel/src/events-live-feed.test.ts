/**
 * The live feed over the events WebSocket: the subscribe frame, delivery of
 * `run_event` pushes in slot order at most once, and teardown (unsubscribe,
 * connection loss, refusal, transport off). `ws` is replaced with a fake the
 * test drives directly, as in `ws-transport.test.ts`.
 */
import { type Event, eventIdToSlot, slotToEventId } from '@workflow/world';
import { decode } from 'cbor-x';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  cursorAfterSlot,
  LiveFeedError,
  type ReadEventsAfter,
  SUBSCRIBE_FRAME_TYPE,
  subscribeRunEvents,
} from './events-live-feed.js';
import { encodeFrame } from './frames.js';
import { injectTraceContextIntoHeaders } from './telemetry.js';
import {
  getWsEventsTransport,
  RUN_EVENT_FRAME_TYPE,
  resetWsEventsTransportsForTest,
  resolveWsTransport,
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
    readonly sent: Uint8Array[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    constructor(url: string) {
      this.url = url;
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
      this.sent.push(data);
      cb?.();
    }
    close(code = 1000): void {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', code);
    }
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.emit('open');
    }
    deliver(frame: Uint8Array): void {
      this.emit('message', Buffer.from(frame));
    }
  }
  return { FakeWebSocket: FakeSocket, sockets };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const RUN = 'wrun_feed';
const CONFIG = { token: 'test-token' };
const EMPTY = new Uint8Array(0);

const tick = () => vi.advanceTimersByTimeAsync(0);

async function settle(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`never settled: ${label}`);
}

function sentMetas(socket: { sent: Uint8Array[] }) {
  return socket.sent.map((raw) => {
    const metaLen = new DataView(
      raw.buffer,
      raw.byteOffset,
      raw.byteLength
    ).getUint32(0, false);
    return decode(raw.subarray(4, 4 + metaLen)) as Record<string, unknown>;
  });
}

function pushed(slot: number, runId = RUN, reqId = 1) {
  // A whole event frame as the body, like a list frame.
  const eventFrame = encodeFrame(
    {
      eventId: slotToEventId(slot),
      runId,
      eventType: 'hook_received',
      correlationId: 'hook_1',
      createdAt: new Date('2026-10-05T00:00:00.000Z'),
      specVersion: 9,
      eventData: { token: 'tok' },
    },
    new Uint8Array([slot])
  );
  return encodeFrame({ reqId, type: RUN_EVENT_FRAME_TYPE, slot }, eventFrame);
}

/** Subscribe and drive the socket until the subscribe frame is on the wire. */
async function subscribed(afterSlot = 2) {
  const events: { eventId: string; payload: unknown }[] = [];
  const onError = vi.fn();
  const unsubscribe = subscribeRunEvents(
    RUN,
    afterSlot,
    (event) =>
      events.push({
        eventId: event.eventId,
        payload: (event.eventData as { payload?: unknown }).payload,
      }),
    { onError },
    CONFIG
  );
  await settle(() => sockets.length > 0, 'socket constructed');
  const socket = sockets[sockets.length - 1];
  socket.open();
  await settle(() => socket.sent.length > 0, 'subscribe frame sent');
  const [meta] = sentMetas(socket);
  return { events, onError, unsubscribe, socket, meta };
}

beforeAll(async () => {
  await injectTraceContextIntoHeaders(new Headers());
});

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  resetWsEventsTransportsForTest();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  resetWsEventsTransportsForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('subscribeRunEvents', () => {
  it('sends a subscribe frame carrying afterSlot', async () => {
    const { meta, socket } = await subscribed(7);
    expect(meta).toMatchObject({ type: SUBSCRIBE_FRAME_TYPE, afterSlot: 7 });
    expect(typeof meta?.reqId).toBe('number');
    expect(socket.url).toContain(`/websockets/v1/runs/${RUN}`);
  });

  it('delivers pushed events in arrival order, each slot once, nothing at or below afterSlot', async () => {
    const { events, onError, socket, meta } = await subscribed(2);
    socket.deliver(
      encodeFrame(
        { reqId: meta?.reqId, type: 'subscribe_ack', status: 200 },
        EMPTY
      )
    );
    await tick();
    for (const slot of [2, 3, 4, 4, 3, 5]) socket.deliver(pushed(slot));
    expect(events.map((event) => event.eventId)).toEqual([
      slotToEventId(3),
      slotToEventId(4),
      slotToEventId(5),
    ]);
    // The body is the payload, decoded like a list frame.
    expect(events[0]?.payload).toEqual(new Uint8Array([3]));
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops events for another run', async () => {
    const { events, socket } = await subscribed(2);
    socket.deliver(pushed(3, 'wrun_other'));
    expect(events).toHaveLength(0);
  });

  it('stops delivering the moment unsubscribe returns, and releases the channel', async () => {
    const { events, onError, unsubscribe, socket } = await subscribed(2);
    socket.deliver(pushed(3));
    unsubscribe();
    unsubscribe();
    socket.deliver(pushed(4));
    expect(events.map((event) => event.eventId)).toEqual([slotToEventId(3)]);
    // No other holder, so the socket goes and the channel is de-registered.
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(resolveWsTransport(RUN, CONFIG)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps a socket another invocation still holds when it unsubscribes', async () => {
    const { unsubscribe, socket } = await subscribed(2);
    const resolved = resolveWsTransport(RUN, CONFIG);
    resolved?.transport.open();
    unsubscribe();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('reports a connection loss once through onError and delivers nothing after', async () => {
    const { events, onError, socket } = await subscribed(2);
    socket.close(1001);
    socket.deliver(pushed(3));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(LiveFeedError);
    expect(events).toHaveLength(0);
  });

  it('reports a refused subscription through onError', async () => {
    const { onError, socket, meta } = await subscribed(2);
    socket.deliver(
      encodeFrame({ reqId: meta?.reqId, type: 'error', status: 400 }, EMPTY)
    );
    await settle(() => onError.mock.calls.length > 0, 'refusal reported');
    expect(onError).toHaveBeenCalledTimes(1);
    socket.deliver(pushed(3));
  });

  it('does not tear down the connection or its pending writes on a push', async () => {
    const { socket } = await subscribed(2);
    const transport = getWsEventsTransport(socket.url, async () => ({}));
    const write = transport.request((reqId) =>
      encodeFrame({ reqId, type: 'event', event: {} }, EMPTY)
    );
    await tick();
    socket.deliver(pushed(3));
    const writeMeta = sentMetas(socket).at(-1);
    socket.deliver(
      encodeFrame(
        { reqId: writeMeta?.reqId, type: 'event_ack', status: 200 },
        EMPTY
      )
    );
    await expect(write).resolves.toMatchObject({
      meta: { status: 200 },
    });
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('reports, without throwing, when the WS transport is off', async () => {
    vi.stubEnv('WORKFLOW_EVENTS_TRANSPORT', 'http');
    const onError = vi.fn();
    const unsubscribe = subscribeRunEvents(
      RUN,
      0,
      () => {},
      { onError },
      CONFIG
    );
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    unsubscribe();
  });

  it('fails the feed on a malformed push instead of passing it on', async () => {
    const { events, onError, socket } = await subscribed(2);
    socket.deliver(
      encodeFrame({ reqId: 1, type: RUN_EVENT_FRAME_TYPE, slot: 3 }, EMPTY)
    );
    expect(onError).toHaveBeenCalledTimes(1);
    socket.deliver(pushed(3));
    expect(events).toHaveLength(0);
  });

  it('ends the feed once on the backend terminal notice, with its status and message', async () => {
    const { events, onError, socket, meta } = await subscribed(2);
    socket.deliver(
      encodeFrame(
        { reqId: meta?.reqId, type: 'subscribe_ack', status: 200 },
        EMPTY
      )
    );
    await tick();
    socket.deliver(pushed(3));
    const end = encodeFrame(
      {
        reqId: meta?.reqId,
        type: RUN_EVENT_FRAME_TYPE,
        end: true,
        status: 429,
        error: 'run-feed-unavailable',
        message: 'run feed stopped: reads throttled',
      },
      EMPTY
    );
    socket.deliver(end);
    socket.deliver(end);
    socket.deliver(pushed(4));
    expect(events.map((event) => event.eventId)).toEqual([slotToEventId(3)]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(LiveFeedError);
    expect(error).toMatchObject({ status: 429, code: 'run-feed-unavailable' });
    expect((error as Error).message).toContain(
      'run feed stopped: reads throttled'
    );
  });
});

describe('subscribeRunEvents heartbeats', () => {
  const HEARTBEAT_MS = 10_000;

  /** An event at `slot` as `events.list` returns it. */
  function listed(slot: number, runId = RUN): Event {
    return {
      eventId: slotToEventId(slot),
      runId,
      eventType: 'hook_received',
      correlationId: 'hook_1',
      createdAt: new Date('2026-10-05T00:00:00.000Z'),
      specVersion: 9,
      eventData: { token: 'tok', payload: new Uint8Array([slot]) },
    } as unknown as Event;
  }

  async function watchedFeed(
    ackMeta: Record<string, unknown> = {},
    readEventsAfter?: ReadEventsAfter
  ) {
    const events: string[] = [];
    const onError = vi.fn();
    const unsubscribe = subscribeRunEvents(
      RUN,
      2,
      (event) => events.push(event.eventId),
      { onError },
      CONFIG,
      readEventsAfter
    );
    await settle(() => sockets.length > 0, 'socket constructed');
    const socket = sockets[sockets.length - 1];
    socket.open();
    await settle(() => socket.sent.length > 0, 'subscribe frame sent');
    const [meta] = sentMetas(socket);
    const reqId = meta?.reqId as number;
    const ack = () =>
      socket.deliver(
        encodeFrame(
          { reqId, type: 'subscribe_ack', status: 200, ...ackMeta },
          EMPTY
        )
      );
    const heartbeat = (slot: number, from = reqId) =>
      socket.deliver(
        encodeFrame({ reqId: from, type: 'run_heartbeat', slot }, EMPTY)
      );
    return { events, onError, unsubscribe, socket, reqId, ack, heartbeat };
  }

  it('lists run-heartbeat in the upgrade flags', async () => {
    const { WS_CLIENT_FLAGS } = await import('./ws-parts.js');
    expect(WS_CLIENT_FLAGS).toContain('run-heartbeat');
  });

  it('ends a feed whose ack confirms heartbeats after three silent intervals', async () => {
    const feed = await watchedFeed({ heartbeatMs: HEARTBEAT_MS });
    feed.ack();
    await tick();
    // Heartbeats and pushes keep it alive.
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
    feed.heartbeat(2);
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
    feed.socket.deliver(pushed(3, RUN, feed.reqId));
    await vi.advanceTimersByTimeAsync(2 * HEARTBEAT_MS);
    expect(feed.onError).not.toHaveBeenCalled();
    expect(feed.events).toEqual([slotToEventId(3)]);
    // Then silence.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1);
    expect(feed.onError).toHaveBeenCalledTimes(1);
    const error = feed.onError.mock.calls[0]?.[0] as LiveFeedError;
    expect(error).toBeInstanceOf(LiveFeedError);
    expect(error.code).toBe('run-feed-silent');
    // Ended: nothing is delivered after.
    feed.socket.deliver(pushed(4, RUN, feed.reqId));
    expect(feed.events).toEqual([slotToEventId(3)]);
  });

  it('fills a gap a heartbeat reveals by reading the log after its last delivered slot', async () => {
    const reads: number[] = [];
    const log = [3, 4, 5, 6].map((slot) => listed(slot));
    const readEventsAfter: ReadEventsAfter = async (after) => {
      reads.push(after);
      const data = log.filter(
        (event) => (eventIdToSlot(event.eventId) ?? 0) > after
      );
      return { data, hasMore: false };
    };
    const feed = await watchedFeed(
      { heartbeatMs: HEARTBEAT_MS },
      readEventsAfter
    );
    feed.ack();
    await tick();
    feed.heartbeat(2);
    await tick();
    expect(reads).toEqual([]);
    feed.socket.deliver(pushed(3, RUN, feed.reqId));
    // The backend pushed through 5, but 4 and 5 never arrived.
    feed.heartbeat(5);
    await settle(() => feed.events.length >= 3, 'gap filled');
    expect(reads).toEqual([3]);
    // Delivered once each, in slot order; the read also returned 6, which
    // continues the sequence.
    expect(feed.events).toEqual(
      [3, 4, 5, 6].map((slot) => slotToEventId(slot))
    );
    // A push of a slot the fill delivered is dropped.
    feed.socket.deliver(pushed(5, RUN, feed.reqId));
    feed.heartbeat(6);
    await tick();
    expect(reads).toEqual([3]);
    expect(feed.events).toHaveLength(4);
    expect(feed.onError).not.toHaveBeenCalled();
    feed.unsubscribe();
  });

  it('stops filling at a position the log read does not return yet', async () => {
    const readEventsAfter: ReadEventsAfter = async () => ({
      data: [listed(3), listed(5)],
      hasMore: false,
    });
    const feed = await watchedFeed(
      { heartbeatMs: HEARTBEAT_MS },
      readEventsAfter
    );
    feed.ack();
    await tick();
    feed.heartbeat(5);
    await settle(() => feed.events.length >= 1, 'partial fill');
    await tick();
    expect(feed.events).toEqual([slotToEventId(3)]);
    expect(feed.onError).not.toHaveBeenCalled();
    feed.unsubscribe();
  });

  it('ends the feed when the read that would fill a gap fails', async () => {
    const feed = await watchedFeed({ heartbeatMs: HEARTBEAT_MS }, async () => {
      throw new Error('list failed');
    });
    feed.ack();
    await tick();
    feed.heartbeat(4);
    await settle(() => feed.onError.mock.calls.length > 0, 'fill failed');
    expect((feed.onError.mock.calls[0]?.[0] as LiveFeedError).code).toBe(
      'run-feed-gap'
    );
  });

  it('ends the feed on a heartbeat for another subscription after its ack, and ignores one before it', async () => {
    const feed = await watchedFeed({ heartbeatMs: HEARTBEAT_MS });
    // The replaced feed's last heartbeat, still in flight before the ack.
    feed.heartbeat(2, feed.reqId + 100);
    expect(feed.onError).not.toHaveBeenCalled();
    feed.ack();
    await tick();
    feed.heartbeat(2, feed.reqId + 100);
    expect(feed.onError).toHaveBeenCalledTimes(1);
    expect((feed.onError.mock.calls[0]?.[0] as LiveFeedError).code).toBe(
      'run-feed-replaced'
    );
  });

  it('arms nothing against a backend whose ack has no heartbeatMs', async () => {
    const feed = await watchedFeed();
    feed.ack();
    await tick();
    await vi.advanceTimersByTimeAsync(10 * HEARTBEAT_MS);
    expect(feed.onError).not.toHaveBeenCalled();
    feed.socket.deliver(pushed(3, RUN, feed.reqId));
    expect(feed.events).toEqual([slotToEventId(3)]);
    feed.unsubscribe();
  });

  it('stops its watchdog on unsubscribe', async () => {
    const feed = await watchedFeed({ heartbeatMs: HEARTBEAT_MS });
    feed.ack();
    await tick();
    feed.unsubscribe();
    await vi.advanceTimersByTimeAsync(10 * HEARTBEAT_MS);
    expect(feed.onError).not.toHaveBeenCalled();
  });
});

describe('cursorAfterSlot', () => {
  it("names the backend's cursor for everything after a slot", () => {
    expect(cursorAfterSlot(7)).toBe(`eid:${slotToEventId(7)}`);
  });
});
