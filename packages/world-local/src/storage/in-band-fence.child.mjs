// A second OS process on a world-local data directory, for
// in-band-fence.test.ts: it opens its own storage on the directory, waits
// for the parent's `go`, makes one in-band write at the count it was given,
// and reports what the World answered. It runs world-local's TypeScript
// source with Node's type stripping, resolving the source's `.js` imports to
// their `.ts` files.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStorage } = await import('../storage.ts');
const [dataDir, runId, expected, specVersion] = process.argv.slice(2);
const storage = createStorage(dataDir);

process.on('message', async (message) => {
  if (message !== 'go') return;
  try {
    const result = await storage.events.create(
      runId,
      {
        eventType: 'attr_set',
        specVersion: Number(specVersion),
        eventData: {
          changes: [{ key: 'writer', value: `pid ${process.pid}` }],
          writer: { type: 'workflow' },
        },
      },
      { inBand: true, expectedSeqInBand: Number(expected) }
    );
    report({ status: 'accepted', eventId: result.event?.eventId });
  } catch (error) {
    report({
      status: error?.name === 'InBandSupersededError' ? 'refused' : 'error',
      name: error?.name,
      message: String(error?.message ?? error),
      seqInBand: error?.seqInBand,
    });
  }
});

function report(result) {
  process.send(result, () => process.exit(0));
}
process.send({ status: 'ready' });
