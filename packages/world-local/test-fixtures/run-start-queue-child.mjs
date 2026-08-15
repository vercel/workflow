import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { lock } from 'proper-lockfile';
import { createQueue } from '../dist/queue.js';
import { createWorld } from '../dist/index.js';
import { createRunStartsStorage } from '../dist/storage/run-starts-storage.js';
import { start } from '../../core/dist/runtime/start.js';
import { setWorld } from '../../core/dist/runtime/world.js';

const {
  RUN_START_QUEUE_DIR: dataDir,
  RUN_START_QUEUE_ROLE: role,
  RUN_START_QUEUE_URL: baseUrl,
  RUN_START_QUEUE_MESSAGE_ID: messageId,
  RUN_START_QUEUE_NONCE: nonce,
} = process.env;
if (!dataDir || !role) throw new Error('missing queue child configuration');
const send = (message) => process.send?.(message);

const proofPath = `${dataDir}/receiver-proof-v1.json`;

async function updateReceiverProof(kind) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(proofPath, '', { flag: 'a' });
  const release = await lock(proofPath, {
    realpath: false,
    stale: 30_000,
    update: 1_000,
    retries: { retries: 300, factor: 1, minTimeout: 10, maxTimeout: 10 },
  });
  try {
    const text = await fs.readFile(proofPath, 'utf8');
    const proof = text
      ? JSON.parse(text)
      : { entries: 0, exits: 0, active: 0, peak: 0, activePids: [] };
    for (const pid of [...proof.activePids]) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
        proof.activePids = proof.activePids.filter((value) => value !== pid);
        proof.active -= 1;
        proof.exits += 1;
      }
    }
    if (kind === 'entry') {
      proof.entries += 1;
      proof.active += 1;
      proof.peak = Math.max(proof.peak, proof.active);
      proof.activePids.push(process.pid);
    } else {
      proof.activePids = proof.activePids.filter(
        (value) => value !== process.pid
      );
      proof.active -= 1;
      proof.exits += 1;
    }
    await fs.writeFile(proofPath, JSON.stringify(proof));
  } finally {
    await release();
  }
}

if (role === 'sender') {
  const queue = createQueue({ dataDir, baseUrl });
  await queue.queue(
    '__wkf_workflow_child',
    { stable: 'bytes' },
    { messageId, receiverAttempt: 'dsp_second_sender' }
  );
  send({ type: 'queued' });
  await new Promise(() => {});
} else if (role === 'bootstrap') {
  const queue = createQueue({ dataDir, baseUrl });
  send({ type: 'draining', role });
  await createRunStartsStorage(dataDir, {
    prepareProjection: async () => {
      throw new Error('existing ledger only');
    },
    materialize: async () => {},
    dispatch: async (entry, accepted, receiverAttempt) =>
      new Promise((resolve, reject) => {
        void queue.queue(entry.queueName, entry.queuePayload, {
          ...entry.queueOptions,
          messageId: entry.messageId,
          receiverAttempt,
          onAccepted: async () => {
            await accepted();
            resolve();
          },
          onAbandoned: reject,
        });
      }),
  }).drain();
  await queue.close();
  send({ type: 'drained', role });
} else if (role === 'startup' || role === 'core') {
  if (!baseUrl || !nonce) throw new Error('missing owner race configuration');
  const world = createWorld({
    dataDir,
    baseUrl,
    recoverActiveRuns: false,
  });
  const actualDrain = world.runStarts.drain.bind(world.runStarts);
  world.runStarts.drain = async () => {
    send({ type: 'drain-ready', role, pid: process.pid });
    await new Promise((resolve) => {
      process.once('message', (message) => {
        if (
          message?.type === 'drain-release' &&
          message.role === role &&
          message.nonce === nonce
        ) {
          resolve();
        }
      });
    });
    try {
      await actualDrain();
      send({ type: 'drain-complete', role, pid: process.pid });
    } catch (error) {
      send({
        type: 'drain-failed',
        role,
        pid: process.pid,
        error: String(error),
      });
      throw error;
    }
  };
  try {
    if (role === 'startup') {
      await world.start();
    } else {
      setWorld(world);
      const workflow = Object.assign(async () => undefined, {
        workflowId: 'child',
      });
      await start(workflow, [], { idempotencyKey: 'receiver-boundary' });
      setWorld(undefined);
    }
  } finally {
    setWorld(undefined);
    await world.close();
  }
} else {
  const queue = createQueue({ dataDir });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  process.on('message', (message) => {
    if (message?.type === 'release') release();
  });
  const handler = queue.createQueueHandler(
    '__wkf_workflow_',
    async (body, metadata) => {
      await updateReceiverProof('entry');
      try {
        send({ type: 'entered', body, messageId: metadata.messageId });
        if (role === 'hold') await released;
      } finally {
        await updateReceiverProof('exit');
      }
    }
  );
  const server = createServer(async (req, res) => {
    send({ type: 'request' });
    const response = await handler(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half',
      })
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
    if (role === 'accept') server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  send({ type: 'ready', port: server.address().port });
  await new Promise((resolve) => server.once('close', resolve));
  await queue.close();
}
