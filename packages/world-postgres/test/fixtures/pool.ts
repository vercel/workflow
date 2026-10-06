import type { Pool } from 'pg';

/**
 * Keeps a test-owned pool from failing the run when its container stops.
 *
 * `pool.end()` resolves as soon as it has asked its idle clients to close,
 * before their sockets are gone. Stopping the container right after it then
 * terminates those backends (`57P01`, "terminating connection due to
 * administrator command"), each client's idle listener re-emits that on the
 * pool, and a pool with no `error` listener throws it as an uncaught
 * exception. Graphile Worker listens while a queue runs, but removes its
 * listener when the queue closes, which is before teardown.
 */
export function tolerateTeardown(pool: Pool): Pool {
  pool.on('error', () => {});
  return pool;
}
