// A second OS process writing a stream on a world-local data directory, for
// streamer.test.ts: it opens its own streamer on the directory and performs
// each `write` / `writeMulti` / `close` the parent sends, answering once it
// is committed. It runs world-local's TypeScript source with Node's type
// stripping, resolving the source's `.js` imports to their `.ts` files.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStreamer } = await import('./streamer.ts');
const [dataDir, runId, name] = process.argv.slice(2);
const streamer = createStreamer(dataDir);

process.on('message', async (message) => {
  try {
    if (message.op === 'write') {
      for (const chunk of message.chunks) {
        await streamer.streams.write(runId, name, chunk);
      }
    } else if (message.op === 'writeMulti') {
      await streamer.streams.writeMulti(runId, name, message.chunks);
    } else if (message.op === 'close') {
      await streamer.streams.close(runId, name);
    }
    process.send({ status: 'done', op: message.op }, () => {
      if (message.op === 'close') process.exit(0);
    });
  } catch (error) {
    process.send({ status: 'error', message: String(error?.message ?? error) });
  }
});

process.send({ status: 'ready' });
