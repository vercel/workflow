import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInvocationNotifications,
  INVOCATION_INPUT_TOPIC,
  INVOCATION_RESULT_TOPIC,
  type InvocationWatch,
  invocationNotificationKey,
} from './invocation-notifications.js';

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: unknown) {
      // biome-ignore lint/correctness/noConstructorReturn: Replace the pg constructor with a configurable test client factory.
      return mocks.client(options);
    }
  },
}));

class FakeClient extends EventEmitter {
  connect = vi.fn(async () => {});
  query = vi.fn(async (_sql: string) => {});
  end = vi.fn(async () => {
    this.emit('end');
  });
}

describe('shared invocation notifications', () => {
  let notifications: ReturnType<typeof createInvocationNotifications>;
  let clients: FakeClient[];
  const signal = new AbortController().signal;
  const inputKey = invocationNotificationKey('run-a');
  const resultKey = invocationNotificationKey('run-a', 'request-a');

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    mocks.client.mockReset().mockImplementation(() => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
    notifications = createInvocationNotifications({ options: {} } as Pool);
  });

  afterEach(async () => {
    await notifications.close();
    vi.useRealTimers();
  });

  async function ready(watch: InvocationWatch) {
    await vi.waitFor(() => expect(watch.revision).toBeGreaterThan(0));
  }

  it('opens one lazy connection and only wakes matching input/result watches', async () => {
    expect(mocks.client).not.toHaveBeenCalled();
    const input = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    const result = notifications.watch(INVOCATION_RESULT_TOPIC, resultKey);
    const other = notifications.watch(
      INVOCATION_INPUT_TOPIC,
      invocationNotificationKey('run-b')
    );
    await ready(input);
    expect(mocks.client).toHaveBeenCalledOnce();
    expect(clients[0].query).toHaveBeenCalledWith(
      `LISTEN ${INVOCATION_INPUT_TOPIC}; LISTEN ${INVOCATION_RESULT_TOPIC}`
    );
    const inputRevision = input.revision;
    const resultRevision = result.revision;
    const otherRevision = other.revision;
    const received = input.wait(inputRevision, 10_000, signal);
    clients[0].emit('notification', {
      channel: INVOCATION_INPUT_TOPIC,
      payload: inputKey,
    });
    await received;
    expect(input.revision).toBe(inputRevision + 1);
    expect(result.revision).toBe(resultRevision);
    expect(other.revision).toBe(otherRevision);
    const responded = result.wait(resultRevision, 10_000, signal);
    clients[0].emit('notification', {
      channel: INVOCATION_RESULT_TOPIC,
      payload: resultKey,
    });
    await responded;
    input.dispose();
    result.dispose();
    other.dispose();
  });

  it('does not miss a notification arriving between the database read and wait', async () => {
    const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    await ready(watch);
    const beforeRead = watch.revision;
    clients[0].emit('notification', {
      channel: INVOCATION_INPUT_TOPIC,
      payload: inputKey,
    });
    let settled = false;
    const waiting = watch.wait(beforeRead, 10_000, signal).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true); // no clock advancement / fallback poll
    await waiting;
    watch.dispose();
  });

  it('invalidates reads made before the LISTEN subscription was established', async () => {
    const connecting = Promise.withResolvers<void>();
    const client = new FakeClient();
    client.connect.mockReturnValue(connecting.promise);
    mocks.client.mockReturnValueOnce(client);
    const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    const waiting = watch.wait(watch.revision, 10_000, signal);
    // A write may have committed with its notification lost before LISTEN.
    connecting.resolve();
    await ready(watch);
    await waiting; // subscription completion forces another authoritative read
    watch.dispose();
  });

  it('uses the slow timeout when no notification arrives', async () => {
    const watch = notifications.watch(INVOCATION_RESULT_TOPIC, resultKey);
    await ready(watch);
    let settled = false;
    const waiting = watch.wait(watch.revision, 1_000, signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
    watch.dispose();
  });

  for (const event of ['error', 'end']) {
    it(`wakes waiters on ${event}, reconnects with backoff and ignores old connection events`, async () => {
      const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
      await ready(watch);
      const disconnected = watch.wait(watch.revision, 10_000, signal);
      const first = clients[0];
      first.emit(event, new Error('listener disconnected'));
      await disconnected;
      expect(first.end).toHaveBeenCalledOnce();
      const fallback = watch.wait(watch.revision, 1_000, signal);
      expect(clients).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await fallback;
      const beforeReconnect = watch.revision;
      const reconnected = watch.wait(beforeReconnect, 10_000, signal);
      await vi.waitFor(() =>
        expect(watch.revision).toBeGreaterThan(beforeReconnect)
      );
      await reconnected;
      expect(clients).toHaveLength(2);
      first.emit('end');
      const beforeNotification = watch.revision;
      clients[1].emit('notification', {
        channel: INVOCATION_INPUT_TOPIC,
        payload: inputKey,
      });
      expect(watch.revision).toBe(beforeNotification + 1);
      watch.dispose();
    });
  }

  it('falls back after LISTEN fails and permits a later subscription attempt', async () => {
    const failed = new FakeClient();
    failed.query.mockRejectedValueOnce(new Error('LISTEN unavailable'));
    mocks.client.mockReturnValueOnce(failed);
    const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    await ready(watch); // disconnect wakes the initial read
    expect(failed.end).toHaveBeenCalledOnce();
    const waiting = watch.wait(watch.revision, 1_000, signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
    const before = watch.revision;
    const retry = watch.wait(before, 10_000, signal);
    await vi.waitFor(() => expect(watch.revision).toBeGreaterThan(before));
    await retry;
    expect(mocks.client).toHaveBeenCalledTimes(2);
    watch.dispose();
  });

  it('cancels waits and removes disposed watches', async () => {
    const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    await ready(watch);
    const controller = new AbortController();
    const error = new Error('cancelled');
    const waiting = watch.wait(watch.revision, 10_000, controller.signal);
    const rejected = expect(waiting).rejects.toBe(error);
    controller.abort(error);
    await rejected;
    watch.dispose();
    const revision = watch.revision;
    clients[0].emit('notification', {
      channel: INVOCATION_INPUT_TOPIC,
      payload: inputKey,
    });
    expect(watch.revision).toBe(revision);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes during connection setup without issuing LISTEN or reopening', async () => {
    const gate = Promise.withResolvers<void>();
    const client = new FakeClient();
    client.connect.mockReturnValue(gate.promise);
    mocks.client.mockReturnValueOnce(client);
    const watch = notifications.watch(INVOCATION_INPUT_TOPIC, inputKey);
    const waiting = watch.wait(watch.revision, 10_000, signal);
    const closing = notifications.close();
    await waiting;
    gate.resolve();
    await closing;
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
    await watch.wait(watch.revision, 1_000, signal);
    expect(mocks.client).toHaveBeenCalledOnce();
    watch.dispose();
  });
});
