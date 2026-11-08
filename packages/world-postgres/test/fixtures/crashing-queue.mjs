import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getQueueTopicPrefix } from '@workflow/world';
import { Pool } from 'pg';
import { createQueue } from '../../dist/queue.js';

// A host that claims a queue delivery and never finishes it. The test kills
// this process with SIGKILL once it prints `claimed <messageId>`, leaving the
// Graphile job locked by a worker that no longer exists.
//
// CRASHING_QUEUE_RUN_SPEC_VERSION stamps the message with a run spec version
// (9 puts it in the run's named queue). CRASHING_QUEUE_STALE_SECONDS sets
// `jobLockStaleSeconds` (`0` behaves like a 5.1.0 process with its default:
// it neither renews nor registers as renewing).
assert(process.env.WORKFLOW_POSTGRES_URL, 'WORKFLOW_POSTGRES_URL is required');
const connectionString = process.env.WORKFLOW_POSTGRES_URL;
const pool = new Pool({ connectionString, max: 4 });
const staleSeconds = process.env.CRASHING_QUEUE_STALE_SECONDS;
const runSpecVersion = process.env.CRASHING_QUEUE_RUN_SPEC_VERSION;
const queue = createQueue(
  {
    connectionString,
    queueConcurrency: 1,
    applicationManagedShutdown: true,
    ...(staleSeconds ? { jobLockStaleSeconds: Number(staleSeconds) } : {}),
  },
  pool
);
// The app's flow handler, as registered when the app starts: this process
// is a worker. The delivery never finishes.
queue.registerHandler(getQueueTopicPrefix('workflow'), async (request) => {
  await request.text();
  process.stdout.write(`claimed ${request.headers.get('x-vqs-message-id')}\n`);
  await new Promise(() => {});
  return new Response();
});
await queue.queue(`${getQueueTopicPrefix('workflow')}test`, {
  runId: process.env.CRASHING_QUEUE_RUN_ID ?? `run_${randomUUID()}`,
  ...(runSpecVersion ? { runSpecVersion: Number(runSpecVersion) } : {}),
});
// Stay alive, holding the delivery, until the test kills the process.
setInterval(() => {}, 60_000);
