// A worker thread for claim-repair.test.ts: it opens its own storage on the
// test's data directory and writes the one event it is given, but pauses,
// alive, right after linking a claim file whose name has `pauseAfter`, until
// the test posts 'go'. It runs world-local's TypeScript source with Node's
// type stripping, like claim-repair.child.mjs.
import fs from 'node:fs/promises';
import { register } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { dataDir, runId, request, pauseAfter } = workerData;
const link = fs.link;
let paused = false;
fs.link = async (from, to) => {
  await link(from, to);
  if (!paused && String(to).endsWith(pauseAfter)) {
    paused = true;
    parentPort.postMessage({ status: 'claimed' });
    await new Promise((resolve) => parentPort.once('message', resolve));
  }
};

const { createStorage } = await import('../storage.ts');
const storage = createStorage(dataDir);
try {
  await storage.events.create(runId, request);
  parentPort.postMessage({ status: 'written' });
} catch (error) {
  parentPort.postMessage({
    status: 'error',
    message: String(error?.message ?? error),
  });
}
