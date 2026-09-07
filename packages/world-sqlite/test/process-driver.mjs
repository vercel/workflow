import { createServer } from 'node:http';
import { createWorld } from '../dist/index.js';
import { NativeSqliteWorld } from '../dist/native.js';

const [action, databaseDir, runId] = process.argv.slice(2);
const queueName = '__wkf_workflow_phase1';

if (!action || !databaseDir) {
  throw new Error(
    'usage: process-driver.mjs <write|read-and-consume> <databaseDir> [runId]'
  );
}

if (action === 'write') {
  const world = createWorld({ databaseDir });
  await world.migrate();
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: 7,
    eventData: {
      deploymentId: 'local-js',
      workflowName: 'workflow//phase1//restart',
      input: new Uint8Array([1, 2, 3]),
    },
  });
  const createdRunId = created.run.runId;
  await world.events.create(createdRunId, {
    eventType: 'run_started',
    specVersion: 7,
  });
  const queued = await world.queue(
    queueName,
    {
      runId: createdRunId,
      phase1Bytes: new Uint8Array([4, 5, 6]),
    },
    { idempotencyKey: `phase1:${createdRunId}` }
  );
  await world.close();
  process.stdout.write(
    `${JSON.stringify({ runId: createdRunId, messageId: queued.messageId })}\n`
  );
} else if (action === 'read-and-consume') {
  if (!runId) throw new Error('read-and-consume requires a runId');

  let resolveDelivery;
  let rejectDelivery;
  const delivery = new Promise((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  let queueHandler;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const webRequest = new Request(`http://127.0.0.1${request.url ?? '/'}`, {
        method: request.method,
        headers: request.headers,
        body,
      });
      const webResponse = await queueHandler(webRequest);
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries())
      );
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      rejectDelivery(error);
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing listener address');

  const world = createWorld({
    databaseDir,
    queueNames: [queueName],
    flowUrl: `http://127.0.0.1:${address.port}/flow`,
  });
  queueHandler = world.createQueueHandler(
    '__wkf_workflow_',
    async (message, meta) => {
      resolveDelivery({ message, meta });
    }
  );

  let readResult;
  try {
    await world.start();
    let timeout;
    const deliveryTimeout = new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('queue delivery timed out')),
        10_000
      );
    });
    const [run, events, delivered] = await Promise.all([
      world.runs.get(runId),
      world.events.list({ runId }),
      Promise.race([delivery, deliveryTimeout]),
    ]).finally(() => clearTimeout(timeout));
    const message = delivered.message;
    readResult = {
      runStatus: run.status,
      eventIds: events.data.map((event) => event.eventId),
      messageId: delivered.meta.messageId,
      attempt: delivered.meta.attempt,
      bytes: Array.from(message.phase1Bytes),
    };
  } finally {
    await world.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  const inspector = new NativeSqliteWorld(world.databasePath);
  const queueMessageCount = await inspector.queueMessageCount('local-js');
  inspector.close();
  process.stdout.write(
    `${JSON.stringify({ ...readResult, queueMessageCount })}\n`
  );
} else {
  throw new Error(`unknown action: ${action}`);
}
