import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createQueue } from './queue.js';

type ChildMessage =
  | { type: 'ready'; port?: number }
  | {
      type: 'draining' | 'drained' | 'drain-ready' | 'drain-complete';
      role: 'bootstrap' | 'startup' | 'core';
      pid?: number;
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

  it('keeps one real receiver through synchronized startup/Core drain recovery', async () => {
    basedir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-start-queue-'));
    const firstReceiver = childRole('hold', { RUN_START_QUEUE_DIR: basedir });
    children.push(firstReceiver);
    const { port } = await nextMessage(firstReceiver, 'ready');
    const baseUrl = `http://127.0.0.1:${port}`;
    const nonce = 'receiver-boundary-nonce';
    const coreOwner = childRole('core', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
      RUN_START_QUEUE_NONCE: nonce,
    });
    children.push(coreOwner);
    const coreReady = await nextMessage(coreOwner, 'drain-ready');
    const pendingBeforeRelease = await fs.readdir(
      path.join(basedir, 'run-starts')
    );
    expect(
      pendingBeforeRelease.filter((name) => name.endsWith('.json'))
    ).toHaveLength(1);
    const startupOwner = childRole('startup', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: baseUrl,
      RUN_START_QUEUE_NONCE: nonce,
    });
    children.push(startupOwner);
    const startupReady = await nextMessage(startupOwner, 'drain-ready');
    expect(coreReady.pid).not.toBe(startupReady.pid);
    const pendingLedger = JSON.parse(
      await fs.readFile(
        path.join(
          basedir,
          'run-starts',
          pendingBeforeRelease.find((name) => name.endsWith('.json'))!
        ),
        'utf8'
      )
    ) as { finalization?: { dispatchState?: string } };
    expect(pendingLedger.finalization?.dispatchState).toBe('pending');
    coreOwner.send({ type: 'drain-release', role: 'core', nonce });
    startupOwner.send({ type: 'drain-release', role: 'startup', nonce });
    const firstEntry = await nextMessage(firstReceiver, 'entered');
    expect(await receiverProof(basedir)).toMatchObject({
      entries: 1,
      exits: 0,
      active: 1,
      peak: 1,
    });
    await nextMessage(startupOwner, 'drain-complete');

    await stop(coreOwner);
    await stop(firstReceiver);
    const recoveredReceiver = childRole('accept', {
      RUN_START_QUEUE_DIR: basedir,
    });
    children.push(recoveredReceiver);
    const recovered = await nextMessage(recoveredReceiver, 'ready');
    const recoveredDrain = childRole('startup', {
      RUN_START_QUEUE_DIR: basedir,
      RUN_START_QUEUE_URL: `http://127.0.0.1:${recovered.port}`,
      RUN_START_QUEUE_NONCE: nonce,
    });
    children.push(recoveredDrain);
    await nextMessage(recoveredDrain, 'drain-ready');
    recoveredDrain.send({ type: 'drain-release', role: 'startup', nonce });
    const recoveredEntry = await nextMessage(recoveredReceiver, 'entered');
    await nextMessage(recoveredDrain, 'drain-complete');
    await stop(recoveredReceiver);

    expect(recoveredEntry).toMatchObject({
      body: firstEntry.body,
      messageId: firstEntry.messageId,
    });
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
        messageId: firstEntry.messageId,
        dispatchState: 'acknowledged',
      },
    });
  }, 30_000);
});
