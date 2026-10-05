import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTEN_RECONNECT_DELAY_MS, listenChannel } from './streamer.js';

const { FakeClient, clients, connection } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const clients: InstanceType<typeof FakeClient>[] = [];
  const connection = {
    fail: false,
    hold: undefined as Promise<void> | undefined,
  };
  class FakeClient extends EventEmitter {
    connect = vi.fn(async () => {
      await connection.hold;
      if (connection.fail) throw new Error('connect ECONNREFUSED');
    });
    query = vi.fn(async (_text: string) => {});
    end = vi.fn(async () => {});
    constructor() {
      super();
      clients.push(this);
    }
  }
  return { FakeClient, clients, connection };
});

vi.mock('pg', () => ({ Client: FakeClient, Pool: vi.fn() }));

const pool = { options: {} } as any;

const dropConnection = (client: InstanceType<typeof FakeClient>) => {
  client.emit('error', new Error('Connection terminated unexpectedly'));
  client.emit('end');
};

describe('listenChannel after a dropped connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clients.length = 0;
    connection.fail = false;
    connection.hold = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles the client error and listens again on a new connection', async () => {
    const payloads: string[] = [];
    const onReconnect = vi.fn();
    const subscription = await listenChannel(
      pool,
      'topic',
      async (payload) => {
        payloads.push(payload);
      },
      onReconnect
    );

    expect(() => dropConnection(clients[0])).not.toThrow();
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAY_MS);

    expect(clients).toHaveLength(2);
    expect(clients[1].query).toHaveBeenCalledWith('LISTEN topic');
    expect(onReconnect).toHaveBeenCalledOnce();
    clients[1].emit('notification', { payload: 'after-restart' });
    expect(payloads).toEqual(['after-restart']);

    await subscription.close();
    expect(clients[1].query).toHaveBeenCalledWith('UNLISTEN topic');
    expect(clients[1].end).toHaveBeenCalled();
  });

  it('keeps retrying while the database is unavailable', async () => {
    const subscription = await listenChannel(pool, 'topic', async () => {});
    connection.fail = true;
    dropConnection(clients[0]);

    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAY_MS * 2);
    expect(clients).toHaveLength(3);

    connection.fail = false;
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAY_MS);
    expect(clients).toHaveLength(4);
    expect(clients[3].query).toHaveBeenCalledWith('LISTEN topic');

    await subscription.close();
  });

  it('stops reconnecting once closed', async () => {
    const subscription = await listenChannel(pool, 'topic', async () => {});
    dropConnection(clients[0]);
    await subscription.close();

    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAY_MS * 3);
    expect(clients).toHaveLength(1);
  });

  it('ends a reconnect that completes after close', async () => {
    const onReconnect = vi.fn();
    const subscription = await listenChannel(
      pool,
      'topic',
      async () => {},
      onReconnect
    );
    const release = Promise.withResolvers<void>();
    connection.hold = release.promise;
    dropConnection(clients[0]);
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAY_MS);
    expect(clients).toHaveLength(2);

    await subscription.close();
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(clients[1].end).toHaveBeenCalled();
    expect(clients[1].listenerCount('notification')).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('still rejects when the first connection fails', async () => {
    connection.fail = true;
    await expect(listenChannel(pool, 'topic', async () => {})).rejects.toThrow(
      'connect ECONNREFUSED'
    );
  });
});
