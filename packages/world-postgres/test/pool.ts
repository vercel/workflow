import { once } from 'node:events';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * A `pg` Pool whose `end()` also waits until every connection it opened has
 * closed. Use it for a pool that is ended right before its container stops.
 *
 * The stock `end()` resolves as soon as no client is checked out: it asks each
 * idle client to end, but does not wait for the server to close the socket.
 * Stopping the container in that window makes Postgres' fast shutdown
 * terminate the stragglers with a FATAL 57P01 ("terminating connection due to
 * administrator command"), which pg-pool re-emits as an `'error'` on the pool.
 * Once Graphile Worker has released the pool nothing listens there, so Vitest
 * reports an uncaught exception and fails a run in which every test passed.
 */
export class TestPool extends Pool {
  readonly #connected = new Set<PoolClient>();

  constructor(config?: PoolConfig) {
    super(config);
    this.on('connect', (client) => this.#connected.add(client));
    // pg-pool emits `remove` once the client's connection has closed.
    this.on('remove', (client) => this.#connected.delete(client));
  }

  override end(): Promise<void>;
  override end(callback: () => void): void;
  override end(callback?: () => void): Promise<void> | void {
    const ended = this.#endAndDisconnect();
    if (!callback) return ended;
    void ended.then(callback);
  }

  async #endAndDisconnect(): Promise<void> {
    await super.end();
    while (this.#connected.size > 0) await once(this, 'remove');
  }
}
