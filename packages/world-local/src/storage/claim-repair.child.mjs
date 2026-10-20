// A second OS process for claim-repair.test.ts: it opens its own storage on
// the parent's data directory, writes the one event the parent sends it, and
// SIGKILLs itself at the given point of that write, which leaves the step or
// wait claim without its event. It runs world-local's TypeScript source with
// Node's type stripping, like in-band-fence.child.mjs.
//
// Kill points:
//   claim:<suffix>  right after a claim file ending in <suffix> is linked
//   event:<type>    right before the <type> event file is written
import fs from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

// The parent forks this with `serialization: 'advanced'`, so the request's
// Uint8Array and Date values arrive intact.
const { dataDir, runId, request, killAt } = await new Promise((resolve) =>
  process.once('message', resolve)
);
const [killKind, killWhat] = killAt.split(':');
const kill = () => process.kill(process.pid, 'SIGKILL');

const link = fs.link;
fs.link = async (from, to) => {
  await link(from, to);
  const file = String(to);
  if (
    killKind === 'claim' &&
    file.includes(`${path.sep}.locks${path.sep}`) &&
    file.endsWith(killWhat)
  ) {
    kill();
  }
};
const writeFile = fs.writeFile;
fs.writeFile = async (file, data, options) => {
  if (
    killKind === 'event' &&
    String(file).includes(`${path.sep}events${path.sep}`) &&
    typeof data === 'string' &&
    JSON.parse(data).eventType === killWhat
  ) {
    kill();
  }
  return writeFile(file, data, options);
};

const { createStorage } = await import('../storage.ts');
const storage = createStorage(dataDir);
try {
  await storage.events.create(runId, request);
  process.send({ status: 'written' }, () => process.exit(0));
} catch (error) {
  process.send(
    { status: 'error', message: String(error?.message ?? error) },
    () => process.exit(0)
  );
}
