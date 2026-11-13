import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { createQueue } from '../../dist/queue.js';

// A peer host with an explicit, shorter stale window (`'all'` scope): it
// renews its own deliveries and releases any job of this World whose lock
// went unrenewed for SHORT_WINDOW_STALE_SECONDS. Commands on stdin:
// `start` starts its runner (it prints `ready`); `fail` / `ok` answer every
// delivery it holds with 500 / 200 (it prints `responded <status>`). It
// prints `claimed <attempt>` for each delivery it receives.
assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const connectionString = process.env.WORKFLOW_POSTGRES_URL;
const pool = new Pool({ connectionString, max: 4 });
const held = [];
const server = createServer(async (request, response) => {
  await request.toArray();
  held.push(response);
  process.stdout.write(`claimed ${request.headers['x-vqs-message-attempt']}\n`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address !== 'string', 'Expected a TCP server');
process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;

const queue = createQueue(
  {
    connectionString,
    queueConcurrency: 1,
    applicationManagedShutdown: true,
    jobLockStaleSeconds: Number(process.env.SHORT_WINDOW_STALE_SECONDS ?? '1'),
  },
  pool
);

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line === 'start') {
    await queue.start();
    process.stdout.write('ready\n');
    return;
  }
  const status = line === 'fail' ? 500 : 200;
  for (const response of held.splice(0)) {
    response.statusCode = status;
    response.end(status === 200 ? '{}' : 'failed');
  }
  process.stdout.write(`responded ${status}\n`);
});
process.stdout.write('listening\n');
