import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { createQueue } from '../../dist/queue.js';

// A host that claims a queue delivery and never finishes it. The test kills
// this process with SIGKILL once it prints `claimed <messageId>`, leaving the
// Graphile job locked by a worker that no longer exists.
assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const connectionString = process.env.WORKFLOW_POSTGRES_URL;
const pool = new Pool({ connectionString, max: 4 });
const server = createServer(async (request) => {
  await request.toArray();
  process.stdout.write(`claimed ${request.headers['x-vqs-message-id']}\n`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address !== 'string', 'Expected a TCP server');
process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
const queue = createQueue(
  { connectionString, queueConcurrency: 1, applicationManagedShutdown: true },
  pool
);
await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
  runId: `run_${randomUUID()}`,
});
// Stay alive, holding the delivery, until the test kills the process.
setInterval(() => {}, 60_000);
