import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createQueue } from '../dist/queue.js';
import { createRunStartsStorage } from '../dist/storage/run-starts-storage.js';

const {
  RUN_START_QUEUE_DIR: dataDir,
  RUN_START_QUEUE_ROLE: role,
  RUN_START_QUEUE_URL: baseUrl,
  RUN_START_QUEUE_MESSAGE_ID: messageId,
} = process.env;
if (!dataDir || !role) throw new Error('missing queue child configuration');
const send = (message) => process.send?.(message);

if (role === 'sender') {
  const queue = createQueue({ dataDir, baseUrl });
  await queue.queue(
    '__wkf_workflow_child',
    { stable: 'bytes' },
    { messageId, receiverAttempt: 'dsp_second_sender' }
  );
  send({ type: 'queued' });
  await new Promise(() => {});
}

if (role === 'drain') {
  const queue = createQueue({ dataDir, baseUrl });
  send({ type: 'draining' });
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
}

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
    send({ type: 'entered', body, messageId: metadata.messageId });
    if (role === 'hold') await released;
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
