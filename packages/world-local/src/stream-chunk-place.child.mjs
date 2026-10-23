// A writer in another OS process on a world-local data directory, for
// stream-chunk-place.test.ts: it opens its own streamer on the directory,
// waits for the parent's `go`, writes its chunks to one stream, each once the
// one before it landed, and reports when they all have. It runs world-local's
// TypeScript source with Node's type stripping, resolving the source's `.js`
// imports to their `.ts` files.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStreamer } = await import('./streamer.ts');
const [dataDir, runId, name, tag, count] = process.argv.slice(2);
const streamer = createStreamer(dataDir);

process.on('message', async (message) => {
  if (message !== 'go') return;
  try {
    for (let index = 0; index < Number(count); index += 1) {
      await streamer.streams.write(runId, name, `${tag}-${index}\n`);
    }
    report({ status: 'done' });
  } catch (error) {
    report({ status: 'error', message: String(error?.message ?? error) });
  }
});

function report(result) {
  process.send(result, () => process.exit(0));
}
process.send({ status: 'ready' });
