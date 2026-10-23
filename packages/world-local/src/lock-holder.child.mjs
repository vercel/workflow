// A process holding a proper-lockfile lock taken with `lockHolderFs()`, for
// lock-holder.test.ts and in-band-fence.test.ts: it locks the file it is
// given, reports `holding`, and releases the lock when told to. A test kills
// it to leave the lock behind with no process holding it. It runs
// world-local's TypeScript source with Node's type stripping, resolving the
// source's `.js` imports to their `.ts` files.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { lock } = await import('proper-lockfile');
const { lockHolderFs } = await import('./lock-holder.ts');
const [file] = process.argv.slice(2);
const release = await lock(file, {
  fs: lockHolderFs(),
  realpath: false,
  stale: 30_000,
  update: 1_000,
});

process.on('message', async (message) => {
  if (message !== 'release') return;
  await release();
  process.send({ status: 'released' }, () => process.exit(0));
});
process.send({ status: 'holding' });
