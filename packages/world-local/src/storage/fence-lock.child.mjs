// Another OS process taking a run's fence file lock, for fence-lock.test.ts.
// `hold`: take the lock, report `held`, release it when told to. `loop`: take
// and release the lock over and over, logging `enter <pid>` and `exit <pid>`
// to a file while holding it. It runs world-local's TypeScript source with
// Node's type stripping, resolving the source's `.js` imports to their `.ts`
// files.
import { appendFileSync } from 'node:fs';
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { withFenceFileLock } = await import('./fence-lock.ts');
const [mode, lockDir, logPath] = process.argv.slice(2);

if (mode === 'hold') {
  await withFenceFileLock(lockDir, 'wrun_child', async () => {
    const release = new Promise((resolve) => process.once('message', resolve));
    process.send('held');
    await release;
  });
  process.send('released', () => process.exit(0));
} else {
  process.send('ready');
  for (;;) {
    await withFenceFileLock(lockDir, 'wrun_child', async () => {
      appendFileSync(logPath, `enter ${process.pid}\n`);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      appendFileSync(logPath, `exit ${process.pid}\n`);
    });
  }
}
