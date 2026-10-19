// Independent writer on the parent's real data directory. Run the
// TypeScript source using Node's type stripping, as in in-band-fence.child.mjs.
import fs from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStorage } = await import('../storage.ts');
const [dataDir, runId, specVersion] = process.argv.slice(2);
const storage = createStorage(dataDir);

process.on('message', async (message) => {
  if (message?.type !== 'go') return;
  try {
    if (message.pauseAt) {
      const link = fs.link.bind(fs);
      fs.link = async (source, destination) => {
        if (
          String(destination).includes(`${path.sep}events${path.sep}`) &&
          JSON.parse(await fs.readFile(source, 'utf8')).eventType ===
            'run_created'
        ) {
          if (message.pauseAt === 'after-link') await link(source, destination);
          process.send({ status: 'paused' });
          // Keep the IPC listener alive until the parent kills this process.
          // No finally block runs to clean up the staged creation event.
          await new Promise(() => {});
        }
        return link(source, destination);
      };
    }
    const result = await storage.events.create(
      runId,
      message.request ?? {
        eventType: 'run_started',
        specVersion: Number(specVersion),
      }
    );
    report({
      status: result.run.status,
      events: result.events?.map((event) => event.eventType),
      deploymentId: result.run.deploymentId,
      input: Array.from(result.run.input),
    });
  } catch (error) {
    report({ status: 'error', message: String(error) });
  }
});

function report(result) {
  process.send(result, () => process.exit(0));
}
process.send('ready');
