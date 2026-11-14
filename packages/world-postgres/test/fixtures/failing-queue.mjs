import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getQueueTopicPrefix, IN_PROCESS_QUEUE_HANDLER } from '@workflow/world';
import { Pool } from 'pg';
import { createQueue } from '../../dist/queue.js';

assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const connectionString = process.env.WORKFLOW_POSTGRES_URL;
const pool = new Pool({ connectionString, max: 4 });
const queue = createQueue(
  { connectionString, queueConcurrency: 1, applicationManagedShutdown: true },
  pool
);
// The app's flow handler, as registered when the app starts; every delivery
// to it fails.
queue.registerHandler(
  getQueueTopicPrefix('workflow'),
  Object.assign(async () => new Response(null), {
    [IN_PROCESS_QUEUE_HANDLER]: async () => {
      throw new Error('test queue delivery failure');
    },
  })
);
try {
  const { messageId } = await queue.queue(
    `${getQueueTopicPrefix('workflow')}test`,
    { runId: `run_${randomUUID()}` }
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const jobs = await pool.query(
      'SELECT attempts, last_error, locked_at FROM graphile_worker._private_jobs WHERE key = $1',
      [messageId]
    );
    const job = jobs.rows[0];
    if (job && job.last_error !== null && job.locked_at === null) {
      assert.equal(job.attempts, 1);
      break;
    }
    assert(Date.now() < deadline, 'Queue delivery did not fail');
    await sleep(20);
  }
} finally {
  await queue.close();
  await pool.query('TRUNCATE graphile_worker._private_jobs');
  await pool.end();
}
