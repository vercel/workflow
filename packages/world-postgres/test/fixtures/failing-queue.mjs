import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { createQueue } from '../../dist/queue.js';

assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const connectionString = process.env.WORKFLOW_POSTGRES_URL;
const pool = new Pool({ connectionString, max: 4 });
const failSettlement = process.env.WORKFLOW_QUEUE_SETTLEMENT_FAILURE === '1';
if (failSettlement) {
  await pool.query(
    `CREATE FUNCTION workflow.fail_queue_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-sensitive-settlement-detail'; END $$; CREATE TRIGGER fail_queue_settlement BEFORE UPDATE ON workflow.workflow_queue_payloads FOR EACH ROW EXECUTE FUNCTION workflow.fail_queue_settlement()`
  );
}
const server = createServer(async (request, response) => {
  await request.toArray();
  response.writeHead(failSettlement ? 200 : 503, {
    'content-type': 'text/plain',
  });
  response.end(failSettlement ? '{}' : 'test queue delivery failure');
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
try {
  const { messageId } = await queue.queue(
    `${getQueueTopicPrefix('workflow')}test`,
    { runId: `run_${randomUUID()}` }
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const jobs = await pool.query(
      "SELECT attempts, last_error, locked_at FROM graphile_worker._private_jobs WHERE payload->>'messageId' = $1",
      [messageId]
    );
    const job = jobs.rows[0];
    if (job && job.last_error !== null && job.locked_at === null) {
      assert.equal(job.attempts, 1);
      assert(!job.last_error.includes('synthetic-sensitive-settlement-detail'));
      break;
    }
    assert(Date.now() < deadline, 'Queue delivery did not fail');
    await sleep(20);
  }
} finally {
  await queue.close();
  if (failSettlement)
    await pool.query(
      'DROP TRIGGER fail_queue_settlement ON workflow.workflow_queue_payloads; DROP FUNCTION workflow.fail_queue_settlement()'
    );
  await pool.query('TRUNCATE graphile_worker._private_jobs');
  await pool.end();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
