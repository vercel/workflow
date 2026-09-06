import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { SqliteWorldProbe, WorkflowNativeError, nativeInfo } = await import(
  './index.mjs'
);
const { NativeSqliteWorld, NativeTypeTagSentinel, roundTripContext } =
  await import('./binding.js');
const execFileAsync = promisify(execFile);

const fixturePath = new URL(
  '../../fixtures/world-contract/v1/resilient-run-start.json',
  import.meta.url
);
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'world-native-'));
const databasePath = path.join(directory, 'world.sqlite');
const servers = [];

try {
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.name, 'resilient-run-start-synthesizes-created');
  assert.deepEqual(fixture.requires, ['run-started-preload']);
  assert.equal(fixture.persistedSpecVersion, fixture.when.event.specVersion);
  assert.equal(fixture.given.storage, 'empty');
  assert.equal(fixture.when.operation, 'events.create');
  assert.equal(fixture.when.event.eventType, 'run_started');
  assert.equal(nativeInfo.adapterProtocolVersion, 1);
  assert.equal(nativeInfo.nodeApiVersion, 8);
  assert.equal(nativeInfo.sqliteVersion, '3.53.2');
  assert.throws(
    () => NativeSqliteWorld.prototype.close.call(new NativeTypeTagSentinel()),
    TypeError
  );
  const panicProbe = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL('./panic-probe.mjs', import.meta.url))],
    { encoding: 'utf8' }
  );
  assert.match(panicProbe.stdout, /native panic became a Promise rejection/);
  assert.match(panicProbe.stderr, /intentional native task panic probe/);

  const sharedContextPart = { bytes: new Uint8Array([0, 1, 255]) };
  const portableContext = roundTripContext({
    left: sharedContextPart,
    right: sharedContextPart,
  });
  assert.deepEqual(portableContext.left.bytes, Buffer.from([0, 1, 255]));
  assert.deepEqual(portableContext.right.bytes, Buffer.from([0, 1, 255]));
  assert.notStrictEqual(portableContext.left, portableContext.right);
  const cyclicContext = {};
  cyclicContext.self = cyclicContext;
  assert.throws(
    () => roundTripContext(cyclicContext),
    /cyclic references are not supported/
  );

  const unmigrated = new SqliteWorldProbe(databasePath);
  assert.equal(await fileExists(databasePath), false);
  await assert.rejects(
    () => unmigrated.snapshotContract(fixture.when.runId),
    (error) =>
      error instanceof WorkflowNativeError &&
      error.code === 'not_migrated' &&
      error.kind === 'not_migrated'
  );
  await unmigrated.close();
  assert.equal(await fileExists(databasePath), false);

  const world = new SqliteWorldProbe(databasePath);
  assert.equal(await fileExists(databasePath), false);
  await world.migrate();
  assert.equal(await fileExists(databasePath), true);

  const input = Buffer.from(
    fixture.when.event.eventData.input.$bytes,
    'base64'
  );
  const operation = world.createResilientRunStarted({
    runId: fixture.when.runId,
    specVersion: fixture.when.event.specVersion,
    deploymentId: fixture.when.event.eventData.deploymentId,
    workflowName: fixture.when.event.eventData.workflowName,
    input,
    executionContext: fixture.when.event.eventData.executionContext,
    attributes: fixture.when.event.eventData.attributes,
    allowReservedAttributes:
      fixture.when.event.eventData.allowReservedAttributes,
    encryptionPublicKey: fixture.when.event.eventData.encryptionPublicKey,
  });
  input.fill(42);
  const actual = await operation;
  assert.deepEqual(actual, fixture.then);

  const retry = await world.createResilientRunStarted({
    runId: fixture.when.runId,
    specVersion: fixture.when.event.specVersion,
    deploymentId: fixture.when.event.eventData.deploymentId,
    workflowName: fixture.when.event.eventData.workflowName,
    input: Buffer.from(fixture.when.event.eventData.input.$bytes, 'base64'),
    executionContext: fixture.when.event.eventData.executionContext,
    attributes: fixture.when.event.eventData.attributes,
    allowReservedAttributes:
      fixture.when.event.eventData.allowReservedAttributes,
    encryptionPublicKey: fixture.when.event.eventData.encryptionPublicKey,
  });
  assert.equal(retry.result.event, null);
  assert.equal(retry.events.length, 2);

  const queueScope = `node-probe:${fixture.when.event.eventData.deploymentId}`;
  const queuePrefix = '__wkf_workflow_';
  const queueName = `${queuePrefix}${fixture.when.event.eventData.workflowName}`;
  const deliveries = [];
  const callbackServer = await listen(async (request, response) => {
    const body = await readRequestBody(request);
    deliveries.push({
      attempt: Number(request.headers['x-vqs-message-attempt']),
      body: JSON.parse(body.toString()),
      messageId: request.headers['x-vqs-message-id'],
      queueName: request.headers['x-vqs-queue-name'],
      url: request.url,
    });
    if (deliveries.length === 1) {
      const inCallbackReconciliation = await world.reconcileActiveRuns({
        scope: queueScope,
        deploymentId: fixture.when.event.eventData.deploymentId,
        queuePrefix,
      });
      assert.equal(inCallbackReconciliation.createdMessageCount, 0);
      sendJson(response, 500, { error: 'retry this delivery' });
    } else if (deliveries.length === 2) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ timeoutSeconds: 0.02 }));
    } else {
      sendJson(response, 200, {});
    }
  });
  servers.push(callbackServer);

  await world.startQueueWorker({
    scope: queueScope,
    queueName,
    flowUrl: `${callbackServer.url}/.well-known/workflow/v1/flow?source=native`,
    leaseDurationMs: 1_000,
    pollIntervalMs: 5,
    retryDelayMs: 10,
    requestTimeoutMs: 250,
  });
  const reconciliation = await world.reconcileActiveRuns({
    scope: queueScope,
    deploymentId: fixture.when.event.eventData.deploymentId,
    queuePrefix,
  });
  assert.equal(reconciliation.activeRunCount, 1);
  assert.equal(reconciliation.createdMessageCount, 1);
  await eventually(
    async () => (await world.queueMessageCount(queueScope)) === 0
  );
  assert.deepEqual(
    deliveries.map(({ attempt }) => attempt),
    [1, 2, 3]
  );
  assert.equal(new Set(deliveries.map(({ messageId }) => messageId)).size, 1);
  assert.deepEqual(
    deliveries.map(({ body }) => body),
    Array(3).fill({ runId: fixture.when.runId })
  );
  assert.ok(deliveries.every((delivery) => delivery.queueName === queueName));
  assert.ok(
    deliveries.every(
      (delivery) =>
        delivery.url === '/.well-known/workflow/v1/flow?source=native'
    )
  );
  const workerReport = await world.stopQueueWorker();
  assert.deepEqual(workerReport, {
    claims: 3,
    acknowledgements: 1,
    reschedules: 2,
    deliveryFailures: 1,
    storageFailures: 0,
  });

  assert.equal(await world.close(), true);
  assert.equal(await world.close(), false);
  await assert.rejects(
    () => world.snapshotContract(fixture.when.runId),
    (error) => error instanceof WorkflowNativeError && error.kind === 'closed'
  );

  const reopened = new SqliteWorldProbe(databasePath);
  const durable = await reopened.snapshotContract(fixture.when.runId);
  assert.deepEqual(durable, {
    run: fixture.then.run,
    events: fixture.then.events,
  });
  await reopened.close();

  const directDatabasePath = path.join(directory, 'direct.sqlite');
  const direct = new NativeSqliteWorld(directDatabasePath);
  await direct.migrate();
  const directInput = Buffer.from(
    fixture.when.event.eventData.input.$bytes,
    'base64'
  );
  const directContext = {
    ...fixture.when.event.eventData.executionContext,
    binary: new Uint8Array([0, 1, 255]),
  };
  const directOperation = direct.createResilientRunStarted(
    `${fixture.when.runId.slice(0, -1)}B`,
    fixture.when.event.specVersion,
    fixture.when.event.eventData.deploymentId,
    fixture.when.event.eventData.workflowName,
    directInput,
    directContext,
    JSON.stringify(fixture.when.event.eventData.attributes),
    fixture.when.event.eventData.allowReservedAttributes,
    fixture.when.event.eventData.encryptionPublicKey
  );
  directInput.fill(42);
  const directActual = JSON.parse(await directOperation);
  assert.deepEqual(directActual.run.input, fixture.then.run.input);
  assert.deepEqual(directActual.run.executionContext.binary, [0, 1, 255]);
  direct.close();

  const drainingDatabasePath = path.join(directory, 'draining.sqlite');
  const draining = new SqliteWorldProbe(drainingDatabasePath);
  let migrationSettled = false;
  const pendingMigration = draining.migrate().finally(() => {
    migrationSettled = true;
  });
  const closeResult = await draining.close();
  assert.equal(closeResult, true);
  assert.equal(migrationSettled, true);
  await pendingMigration;
  assert.equal(await fileExists(drainingDatabasePath), true);

  const cancellationDatabasePath = path.join(directory, 'cancellation.sqlite');
  const cancellation = new SqliteWorldProbe(cancellationDatabasePath);
  await cancellation.migrate();
  await cancellation.createResilientRunStarted({
    runId: fixture.when.runId,
    specVersion: fixture.when.event.specVersion,
    deploymentId: fixture.when.event.eventData.deploymentId,
    workflowName: fixture.when.event.eventData.workflowName,
    input: Buffer.from(fixture.when.event.eventData.input.$bytes, 'base64'),
    executionContext: fixture.when.event.eventData.executionContext,
    attributes: fixture.when.event.eventData.attributes,
    allowReservedAttributes:
      fixture.when.event.eventData.allowReservedAttributes,
    encryptionPublicKey: fixture.when.event.eventData.encryptionPublicKey,
  });
  let markCallbackStarted;
  const callbackStarted = new Promise((resolve) => {
    markCallbackStarted = resolve;
  });
  const stalledServer = await listen(async (request, response) => {
    await readRequestBody(request);
    markCallbackStarted();
    await delay(2_000);
    if (!response.destroyed) sendJson(response, 200, {});
  });
  servers.push(stalledServer);
  await cancellation.startQueueWorker({
    scope: queueScope,
    queueName,
    flowUrl: `${stalledServer.url}/flow`,
    leaseDurationMs: 1_000,
    pollIntervalMs: 5,
    retryDelayMs: 10,
    requestTimeoutMs: 100,
  });
  await cancellation.reconcileActiveRuns({
    scope: queueScope,
    deploymentId: fixture.when.event.eventData.deploymentId,
    queuePrefix,
  });
  await callbackStarted;
  const closeStartedAt = performance.now();
  assert.equal(await cancellation.close(), true);
  assert.ok(performance.now() - closeStartedAt < 500);
  const cancellationReopened = new SqliteWorldProbe(cancellationDatabasePath);
  assert.equal(await cancellationReopened.queueMessageCount(queueScope), 1);
  await cancellationReopened.close();

  process.stdout.write(
    `Node native probe passed (SQLite ${nativeInfo.sqliteVersion})\n`
  );
} finally {
  for (const server of servers) server.server.closeAllConnections();
  await Promise.all(servers.map(({ server }) => closeServer(server)));
  await fs.rm(directory, { recursive: true, force: true });
}

async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-length': body.length,
    'content-type': 'application/json',
  });
  response.end(body);
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
