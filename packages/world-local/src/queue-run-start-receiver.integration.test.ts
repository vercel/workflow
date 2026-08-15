import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueue } from './queue.js';
import { createRunStartsStorage } from './storage/run-starts-storage.js';

type ChildMessage =
  | { type: 'ready'; port?: number }
  | {
      type: 'draining' | 'drained';
      role: 'bootstrap' | 'startup' | 'core';
    }
  | { type: 'queued' }
  | { type: 'request' }
  | { type: 'entered'; body: unknown; messageId: string };
const inbox = new WeakMap<ChildProcess, ChildMessage[]>();

async function receiverProof(dataDir: string) {
  return JSON.parse(
    await fs.readFile(path.join(dataDir, 'receiver-proof-v1.json'), 'utf8')
  ) as { entries: number; exits: number; active: number; peak: number };
}

function childRole(
  role: 'hold' | 'accept' | 'sender' | 'bootstrap' | 'startup' | 'core',
  env: Record<string, string>
) {
  const child = fork(
    path.join(
      process.cwd(),
      'packages/world-local/test-fixtures/run-start-queue-child.mjs'
    ),
    [],
    {
      env: { ...process.env, RUN_START_QUEUE_ROLE: role, ...env },
      silent: true,
    }
  );
  const messages: ChildMessage[] = [];
  inbox.set(child, messages);
  child.on('message', (message: ChildMessage) => messages.push(message));
  return child;
}

function nextMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T
): Promise<Extract<ChildMessage, { type: T }>> {
  const existing = inbox.get(child)?.find((message) => message.type === type);
  if (existing)
    return Promise.resolve(existing as Extract<ChildMessage, { type: T }>);
  return new Promise((resolve, reject) => {
    const finish = (
      error?: Error,
      message?: Extract<ChildMessage, { type: T }>
    ) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for ${type}`)),
      10_000
    );
    const onMessage = (message: ChildMessage) => {
      if (message.type === type)
        finish(undefined, message as Extract<ChildMessage, { type: T }>);
    };
    const onExit = (code: number | null) =>
      finish(new Error(`child exited ${code} before ${type}`));
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.killed)
    return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

describe('run-start receiver queue boundary', () => {
  const children: ChildProcess[] = [];
  const queues: ReturnType<typeof createQueue>[] = [];
  let basedir = '';

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stop));
    await Promise.all(queues.splice(0).map((queue) => queue.close()));
    if (basedir) await fs.rm(basedir, { recursive: true, force: true });
  });

  it('keeps one real receiver through second-sender loss and startup/Core drain recovery', async () => {
    basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-start-queue-'));
    const firstReceiver = childRole('hold', { RUN_START_QUEUE_DIR: basedir });
    children.push(firstReceiver);
    const { port } = await nextMessage(firstReceiver, 'ready');
    const baseUrl = `http://127.0.0.1:${port}`;
    const seed = createRunStartsStorage(basedir, {
      prepareProjection: async (entry) => ({
        version: 1 as const,
        runBytes: JSON.stringify({ runId: entry.runId }),
        eventBytes: JSON.stringify({
          eventType: 'run_created',
          runId: entry.runId,
        }),
        eventId: 'evnt_00000000000000000000000001',
        digest: 'projection-a',
      }),
      materialize: async () => {},
      dispatch: async () => {},
    });
    const reservation = await seed.reserveOrAdoptRunStart({
      deploymentId: 'dpl_local',
      idempotencyKey: 'receiver-boundary',
      specVersion: 5,
      startShapeDigest: 'shape-a',
      workflowName: 'child',
    });
    const receipt = await seed.finalizeOrAdoptRunStart({
      reservationId: reservation.reservationId,
      runId: reservation.runId,
      semanticDigest: 'semantic-a',
      envelopeIntegrityDigest: 'envelope-a',
      envelope: { event: 'run_created' },
      queueName: '__wkf_workflow_child',
      queuePayload: { runId: reservation.runId, stable: 'bytes' },
      queueOptions: {},
    });
    const firstSender = childRole('bootstrap', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
    });
    children.push(firstSender);
    await nextMessage(firstSender, 'draining');
    const firstEntry = await nextMessage(firstReceiver, 'entered');
    expect(await receiverProof(basedir)).toMatchObject({
      entries: 1,
      exits: 0,
      active: 1,
      peak: 1,
    });
    const secondSender = childRole('sender', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
      RUN_START_QUEUE_MESSAGE_ID: receipt.messageId,
    });
    children.push(secondSender);
    await nextMessage(secondSender, 'queued');
    await nextMessage(firstReceiver, 'request');
    expect(await receiverProof(basedir)).toMatchObject({
      entries: 1,
      exits: 0,
      active: 1,
      peak: 1,
    });
    await stop(secondSender); // sender dies while first receiver owns durable attempt
    const startupOwner = childRole('startup', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
    });
    const coreOwner = childRole('core', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
    });
    children.push(startupOwner, coreOwner);
    await Promise.all([
      nextMessage(startupOwner, 'draining'),
      nextMessage(coreOwner, 'draining'),
      nextMessage(startupOwner, 'drained'),
      nextMessage(coreOwner, 'drained'),
    ]);
    expect(firstEntry).toMatchObject({
      body: { runId: reservation.runId, stable: 'bytes' },
      messageId: receipt.messageId,
    });

    await stop(firstSender);
    await stop(firstReceiver);
    const recoveredReceiver = childRole('accept', {
      RUN_START_QUEUE_DIR: basedir,
    });
    children.push(recoveredReceiver);
    const recovered = await nextMessage(recoveredReceiver, 'ready');
    const recoveredDrain = childRole('core', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: `http://127.0.0.1:${recovered.port}`,
    });
    children.push(recoveredDrain);
    await nextMessage(recoveredDrain, 'draining');
    const recoveredEntry = await nextMessage(recoveredReceiver, 'entered');
    await nextMessage(recoveredDrain, 'drained');
    await stop(recoveredReceiver);

    expect(recoveredEntry).toMatchObject({
      body: firstEntry.body,
      messageId: firstEntry.messageId,
    });
    expect(await seed.pendingDispatches()).toEqual([]);
    expect(await receiverProof(basedir)).toMatchObject({
      entries: 2,
      exits: 2,
      active: 0,
      peak: 1,
    });
    const ledgers = await Promise.all(
      (await fs.readdir(path.join(basedir, 'run-starts')))
        .filter((name) => name.endsWith('.json'))
        .map(
          async (name) =>
            JSON.parse(
              await fs.readFile(path.join(basedir, 'run-starts', name), 'utf8')
            ) as { finalization?: unknown }
        )
    );
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      finalization: {
        messageId: receipt.messageId,
        dispatchState: 'acknowledged',
      },
    });
  }, 30_000);
});
