import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { SqliteWorldProbe, WorkflowNativeError, nativeInfo } = await import(
  './index.mjs'
);
const { NativeSqliteWorld, NativeTypeTagSentinel } = await import(
  './binding.js'
);
const execFileAsync = promisify(execFile);

const fixturePath = new URL(
  '../../fixtures/world-contract/v1/resilient-run-start.json',
  import.meta.url
);
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'world-native-'));
const databasePath = path.join(directory, 'world.sqlite');

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
  const directOperation = direct.createResilientRunStarted(
    `${fixture.when.runId.slice(0, -1)}B`,
    fixture.when.event.specVersion,
    fixture.when.event.eventData.deploymentId,
    fixture.when.event.eventData.workflowName,
    directInput,
    JSON.stringify(fixture.when.event.eventData.executionContext),
    JSON.stringify(fixture.when.event.eventData.attributes),
    fixture.when.event.eventData.allowReservedAttributes,
    fixture.when.event.eventData.encryptionPublicKey
  );
  directInput.fill(42);
  const directActual = JSON.parse(await directOperation);
  assert.deepEqual(directActual.run.input, fixture.then.run.input);
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

  process.stdout.write(
    `Node native probe passed (SQLite ${nativeInfo.sqliteVersion})\n`
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
