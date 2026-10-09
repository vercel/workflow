import type { Pool, PoolClient } from 'pg';

/**
 * Keep a connection the server drops from ending the process.
 *
 * A restart or failover, `idle_session_timeout`, `pg_terminate_backend`, or a
 * proxy closing idle sockets can end a connection at any time, and `pg`
 * reports it as an `'error'` event on the client. pg-pool forwards an idle
 * client's error to the pool, but detaches its own listener while a client is
 * checked out, and Drizzle transactions and the invocation mailbox hold
 * clients across statements. An `EventEmitter` with no `'error'` listener
 * throws, so either case is an uncaught exception. Graphile Worker attaches
 * listeners like these only while its runner is up, and a World that is only
 * read from never starts one.
 *
 * Logging is all that is left to do: pg-pool discards a failed client when it
 * is released, and a checked-out client's next query rejects, so its caller
 * still sees the error.
 *
 * Only for a pool the World creates. A pool the caller passes in is theirs to
 * listen on.
 */
export function handleConnectionErrors(
  pool: Pool,
  isClosing: () => boolean
): void {
  const log = (error: Error & { code?: string }) => {
    // Expected while the World shuts its pool down.
    if (isClosing()) return;
    // Never the error itself: pg-pool sets `error.client`, whose connection
    // parameters include the password.
    console.warn(
      `[world-postgres] Pooled PostgreSQL connection lost${error.code ? ` (${error.code})` : ''}: ${error.message}`
    );
  };
  pool.on('connect', (client: PoolClient) => client.on('error', log));
  // pg-pool re-emits an idle client's error here after the listener above has
  // logged it, so this one only keeps the pool from throwing.
  pool.on('error', () => {});
}
