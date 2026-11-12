// A writer for crash-consistency.test.ts: drives runs through their whole
// lifecycle (steps, waits, hooks, a terminal event) on a world-local data
// directory until the parent kills it with SIGKILL. It runs world-local's
// TypeScript source with Node's type stripping, resolving the source's `.js`
// imports to their `.ts` files.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStorage } = await import('../storage.ts');
const [dataDir, writer] = process.argv.slice(2);
const storage = createStorage(dataDir);
const spec = 8;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

let n = 0;
process.send?.({ status: 'ready' });
for (;;) {
  n++;
  const created = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: spec,
    eventData: {
      deploymentId: 'dpl_crash',
      workflowName: 'crash',
      input: bytes([writer, n]),
    },
  });
  const runId = created.event.runId;
  await storage.events.create(runId, {
    eventType: 'run_started',
    specVersion: spec,
  });
  const hookToken = `crash:${writer}:${n % 3}`;
  await storage.events
    .create(runId, {
      eventType: 'hook_created',
      correlationId: `hook_${writer}_${n}`,
      specVersion: spec,
      eventData: { token: hookToken },
    })
    .catch(() => {});
  for (let i = 0; i < 3; i++) {
    const stepId = `step_${i}`;
    await storage.events.create(runId, {
      eventType: 'step_created',
      correlationId: stepId,
      specVersion: spec,
      eventData: { stepName: 'add', input: bytes([i]) },
    });
    await storage.events.create(runId, {
      eventType: 'step_started',
      correlationId: stepId,
      specVersion: spec,
    });
    await storage.events.create(runId, {
      eventType: 'step_completed',
      correlationId: stepId,
      specVersion: spec,
      eventData: { result: bytes(i) },
    });
  }
  await storage.events.create(runId, {
    eventType: 'wait_created',
    correlationId: 'wait_1',
    specVersion: spec,
    eventData: { resumeAt: new Date() },
  });
  await storage.events.create(runId, {
    eventType: 'wait_completed',
    correlationId: 'wait_1',
    specVersion: spec,
  });
  await storage.events.create(runId, {
    eventType: 'run_completed',
    specVersion: spec,
    eventData: { output: bytes('done') },
  });
}
