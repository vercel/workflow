import { createHash } from 'node:crypto';
import { Client, type Pool } from 'pg';

export const INVOCATION_INPUT_TOPIC = 'workflow_invocation_input';
export const INVOCATION_RESULT_TOPIC = 'workflow_invocation_result';
export const INVOCATION_FALLBACK_MS = 1_000;
const RECONNECT_BACKOFF_MS = 1_000;

type Topic = typeof INVOCATION_INPUT_TOPIC | typeof INVOCATION_RESULT_TOPIC;

/** Fixed-size notification identifiers; payloads/results stay in the table. */
export function invocationNotificationKey(...ids: string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

export interface InvocationWatch {
  readonly revision: number;
  wait(since: number, timeoutMs: number, signal: AbortSignal): Promise<void>;
  dispose(): void;
}

/**
 * One lazy LISTEN connection for this World's input and result waiters.
 * Notifications are hints. Subscription/reconnection also invalidates every
 * watch so a read made before LISTEN became active cannot strand a waiter.
 */
export function createInvocationNotifications(pool: Pool) {
  const watches = new Map<string, Set<() => void>>();
  let client: Client | undefined;
  let connecting: Promise<void> | undefined;
  let retryAfter = 0;
  let closed = false;
  const ending = new Set<Promise<void>>();

  const endConnection = (connection: Client) => {
    const promise = connection.end().catch(() => {});
    ending.add(promise);
    void promise.then(() => ending.delete(promise));
    return promise;
  };

  const wakeAll = () => {
    for (const callbacks of watches.values()) {
      for (const callback of callbacks) callback();
    }
  };

  const disconnected = (connection: Client) => {
    // An old connection's delayed end/error must not retire its replacement.
    if (client !== connection) return;
    client = undefined;
    retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
    wakeAll();
    // Keep the error observer installed through shutdown: pg may emit another
    // error while an in-flight connect/LISTEN is unwinding.
    void endConnection(connection);
  };

  const ensureListening = () => {
    if (closed || client || connecting || Date.now() < retryAfter) return;
    const connection = new Client({
      ...pool.options,
      application_name: `${pool.options.application_name ?? 'workflow'}:invocations`,
      connectionTimeoutMillis: pool.options.connectionTimeoutMillis || 1_000,
      query_timeout: pool.options.query_timeout || 1_000,
    });
    client = connection;
    connection.on('error', () => disconnected(connection));
    connection.on('end', () => disconnected(connection));
    connection.on('notification', (notification) => {
      if (closed || client !== connection) return;
      for (const notify of watches.get(
        `${notification.channel}:${notification.payload}`
      ) ?? []) {
        notify();
      }
    });
    connecting = (async () => {
      try {
        await connection.connect();
        if (closed || client !== connection) return;
        // Fixed, trusted channel names. Attach observers before LISTEN.
        await connection.query(
          `LISTEN ${INVOCATION_INPUT_TOPIC}; LISTEN ${INVOCATION_RESULT_TOPIC}`
        );
        if (!closed && client === connection) wakeAll();
      } catch {
        disconnected(connection);
      } finally {
        connecting = undefined;
      }
    })();
  };

  return {
    watch(topic: Topic, key: string): InvocationWatch {
      let revision = 0;
      let disposed = false;
      const waiters = new Set<() => void>();
      const notify = () => {
        revision++;
        for (const finish of waiters) finish();
      };
      const address = `${topic}:${key}`;
      const callbacks = watches.get(address) ?? new Set<() => void>();
      callbacks.add(notify);
      if (!closed) watches.set(address, callbacks);
      ensureListening();

      return {
        get revision() {
          return revision;
        },
        async wait(since, timeoutMs, signal) {
          signal.throwIfAborted();
          ensureListening();
          if (closed || disposed || revision !== since || timeoutMs <= 0)
            return;
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              waiters.delete(finish);
              signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            waiters.add(finish);
            signal.addEventListener('abort', finish, { once: true });
          });
          signal.throwIfAborted();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          callbacks.delete(notify);
          if (callbacks.size === 0) watches.delete(address);
          notify();
        },
      };
    },
    async close() {
      closed = true;
      wakeAll();
      watches.clear();
      const connection = client;
      client = undefined;
      if (connection) await endConnection(connection);
      await connecting;
      await Promise.all(ending);
    },
  };
}
