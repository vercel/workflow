import { writeFile } from 'node:fs/promises';
import { createStreamer } from '../dist/streamer.js';

const {
  WORKFLOW_LOCAL_STREAM_CHILD_DIR: basedir,
  WORKFLOW_LOCAL_STREAM_CHILD_MARKER: marker,
  WORKFLOW_LOCAL_STREAM_CHILD_ACTION: action,
  WORKFLOW_LOCAL_STREAM_CHILD_STREAM: streamName,
  WORKFLOW_LOCAL_STREAM_CHILD_RUN_ID: runId,
  WORKFLOW_LOCAL_STREAM_CHILD_NONCE: nonce,
} = process.env;
if (!basedir || !marker || !action || !streamName || !runId)
  throw new Error('missing stream child configuration');
const streamer = createStreamer(basedir);
if (action === 'ordinary-close' || action === 'keyed-close') {
  await streamer.streams.close(runId, streamName);
  await writeFile(marker, JSON.stringify({ closed: action }));
} else if (action === 'keyed-append') {
  const result = await streamer.streams.appendKeyed(runId, streamName, {
    idempotencyKey: 'child-key',
    semanticDigest: 'child-digest',
    chunk: new TextEncoder().encode('child'),
  });
  await writeFile(marker, JSON.stringify(result));
} else if (action === 'ordinary-write-close') {
  await streamer.streams.write(runId, streamName, 'remote');
  await streamer.streams.close(runId, streamName);
  await writeFile(marker, JSON.stringify({ action }));
  process.send?.({ type: 'done' });
} else if (action === 'keyed-write-close') {
  await streamer.streams.appendKeyed(runId, streamName, {
    idempotencyKey: 'remote-key',
    semanticDigest: 'remote-digest',
    chunk: new TextEncoder().encode('remote'),
  });
  await streamer.streams.close(runId, streamName);
  await writeFile(marker, JSON.stringify({ action }));
  process.send?.({ type: 'done' });
} else if (
  action === 'ordinary-write-after-close' ||
  action === 'keyed-write-after-close'
) {
  try {
    if (action === 'ordinary-write-after-close')
      await streamer.streams.write(runId, streamName, 'late');
    else
      await streamer.streams.appendKeyed(runId, streamName, {
        idempotencyKey: 'late-key',
        semanticDigest: 'late-digest',
        chunk: new TextEncoder().encode('late'),
      });
    await writeFile(marker, JSON.stringify({ action, inserted: true }));
  } catch (error) {
    await writeFile(marker, JSON.stringify({ action, error: String(error) }));
  }
  process.send?.({ type: 'done' });
} else if (action === 'legacy-read' || action === 'legacy-read-rendezvous') {
  if (action === 'legacy-read-rendezvous') {
    if (!nonce) throw new Error('missing legacy rendezvous nonce');
    process.send?.({ type: 'legacy-ready', pid: process.pid, runId });
    await new Promise((resolve) => {
      const onMessage = (message) => {
        if (
          message?.type === 'legacy-release' &&
          message.nonce === nonce &&
          message.runId === runId
        ) {
          process.off('message', onMessage);
          resolve();
        }
      };
      process.on('message', onMessage);
    });
  }
  try {
    const page = await streamer.streams.getChunks(runId, streamName);
    await writeFile(
      marker,
      JSON.stringify({
        data: page.data.map(({ data, index }) => ({
          data: Buffer.from(data).toString('base64'),
          index,
        })),
        done: page.done,
      })
    );
  } catch (error) {
    await writeFile(marker, JSON.stringify({ error: String(error) }));
  }
  process.send?.({ type: 'done' });
} else {
  throw new Error(`unknown stream child action: ${action}`);
}
