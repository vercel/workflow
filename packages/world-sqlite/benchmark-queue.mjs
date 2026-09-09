import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NativeSqliteWorld } from './dist/native.js';

const messageCount = boundedInteger(
  process.env.WORKFLOW_SQLITE_QUEUE_BENCH_MESSAGES,
  1_000,
  1,
  100_000,
  'WORKFLOW_SQLITE_QUEUE_BENCH_MESSAGES'
);
const concurrency = boundedInteger(
  process.env.WORKFLOW_SQLITE_QUEUE_BENCH_CONCURRENCY,
  4,
  1,
  256,
  'WORKFLOW_SQLITE_QUEUE_BENCH_CONCURRENCY'
);
const directory = await mkdtemp(
  path.join(tmpdir(), 'workflow-sqlite-queue-bench-')
);
const native = new NativeSqliteWorld(path.join(directory, 'workflow.sqlite'));
let delivered = 0;
let workerStarted = false;
const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    delivered += 1;
    const body = '{"ok":true}';
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('queue benchmark server did not expose a TCP address');
}

try {
  const migrateStarted = performance.now();
  await native.migrate();
  const migrateMs = performance.now() - migrateStarted;

  const enqueueStarted = performance.now();
  await Promise.all(
    Array.from({ length: messageCount }, (_, index) =>
      native.enqueue(
        `message-${index}`,
        'local-js',
        'benchmark',
        `benchmark-${index}`,
        new Uint8Array([index & 0xff]),
        Date.now()
      )
    )
  );
  const enqueueMs = performance.now() - enqueueStarted;

  const drainStarted = performance.now();
  native.startQueueWorker(
    'local-js',
    ['benchmark'],
    `http://127.0.0.1:${address.port}/.well-known/workflow/v1/flow`,
    'benchmark-worker',
    30_000,
    5,
    5,
    10_000,
    concurrency
  );
  workerStarted = true;
  const deadline = Date.now() + 30_000;
  while ((await native.queueMessageCount('local-js')) !== 0) {
    if (Date.now() >= deadline) {
      throw new Error('queue benchmark exceeded its 30 second drain budget');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const drainMs = performance.now() - drainStarted;
  const report = await native.stopQueueWorker();
  workerStarted = false;

  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        messageCount,
        concurrency,
        migrateMs: rounded(migrateMs),
        enqueueMs: rounded(enqueueMs),
        enqueuePerSecond: rounded((messageCount * 1_000) / enqueueMs),
        drainMs: rounded(drainMs),
        deliveriesPerSecond: rounded((messageCount * 1_000) / drainMs),
        rssMiB: rounded(process.memoryUsage().rss / 1024 / 1024),
        delivered,
        report,
      },
      null,
      2
    )
  );
} finally {
  if (workerStarted) {
    await native.stopQueueWorker().catch(() => undefined);
  }
  native.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`
    );
  }
  return parsed;
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}
