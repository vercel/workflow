// Drops every PostgreSQL connection this process holds, then prints what
// still works. A dropped connection with no `'error'` listener ends the
// process instead, so the test reads a crash as a non-zero exit.
// argv[2]: `world` (a World's own pool, never started) or `checked-out`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { handleConnectionErrors } from '../../dist/connection-errors.js';
import { createWorld } from '../../dist/index.js';

assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const name = `dropped_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.WORKFLOW_POSTGRES_URL);
url.searchParams.set('application_name', name);

const admin = new pg.Client({
  connectionString: process.env.WORKFLOW_POSTGRES_URL,
});
admin.on('error', () => {});
await admin.connect();
// What a database restart does to every connection at once.
const dropConnections = async () =>
  (
    await admin.query(
      'SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name = $1',
      [name]
    )
  ).rows[0].n;

if (process.argv[2] === 'world') {
  // Reads only, like an observability UI: no start(), so no Graphile Worker
  // listeners on the pool.
  const world = createWorld({ connectionString: url.href });
  const read = () => world.runs.list({ pagination: { limit: 1 } });
  await Promise.all([read(), read(), read()]);
  const dropped = await dropConnections();
  await sleep(500);
  await read();
  await world.close();
  console.log(JSON.stringify({ dropped, readAfterDrop: true }));
} else {
  // The way createWorld() sets up its own pool. A transaction holds its
  // client across statements, and pg-pool listens only on idle clients.
  const pool = new pg.Pool({ connectionString: url.href });
  handleConnectionErrors(pool, () => false);
  const held = await pool.connect();
  await held.query('BEGIN');
  const dropped = await dropConnections();
  await sleep(500);
  const heldQueryRejected = await held.query('SELECT 1').then(
    () => false,
    () => true
  );
  held.release();
  await pool.query('SELECT 1');
  await pool.end();
  console.log(JSON.stringify({ dropped, heldQueryRejected }));
}
await admin.end();
