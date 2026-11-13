// A writer for lock-contention.test.ts (or, with 0 runs, a control): on the
// parent's signal, writes runs
// of 12 events each to a world-local data directory shared with other
// writers, while a 1 ms heartbeat measures the longest time the thread went
// without running a timer. It runs world-local's TypeScript source with
// Node's type stripping, resolving the source's `.js` imports to `.ts`.
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (/^\\.\\.?\\//.test(s) && s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }'
  )}`
);

const { createStorage } = await import('../storage.ts');
const [dataDir, writer, runCount] = process.argv.slice(2);
const storage = createStorage(dataDir);
const spec = 8;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

process.send({ status: 'ready' });
await new Promise((resolve) => process.once('message', resolve));

let last = performance.now();
let maxGapMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  maxGapMs = Math.max(maxGapMs, now - last);
  last = now;
}, 1);

// Yields to the event loop after every write, as an app serving requests
// does, so the heartbeat measures how long one write held the thread.
const write = async (runId, event) => {
  const result = await storage.events.create(runId, event);
  await new Promise((resolve) => setImmediate(resolve));
  return result;
};

const runIds = [];
// A control (no runs): as busy as a writer, in bursts of synchronous work
// about as long as a write, each followed by a yield, but with no database,
// until the parent says stop. Its longest gap is what a busy process gets
// from the machine's scheduler, which on a loaded machine (CI runs every
// package's tests at once) is far more than an idle process sees.
if (Number(runCount) === 0) {
  let stopped = false;
  process.once('message', () => {
    stopped = true;
  });
  while (!stopped) {
    const burstEnd = performance.now() + 0.3;
    while (performance.now() < burstEnd) {
      JSON.parse(JSON.stringify({ writer, n: Math.random() }));
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
for (let n = 0; n < Number(runCount); n++) {
  const created = await write(null, {
    eventType: 'run_created',
    specVersion: spec,
    eventData: {
      deploymentId: 'dpl_contention',
      workflowName: 'contention',
      input: bytes([writer, n]),
    },
  });
  const runId = created.event.runId;
  runIds.push(runId);
  await write(runId, {
    eventType: 'run_started',
    specVersion: spec,
  });
  for (let i = 0; i < 3; i++) {
    const correlationId = `step_${i}`;
    await write(runId, {
      eventType: 'step_created',
      correlationId,
      specVersion: spec,
      eventData: { stepName: 'add', input: bytes([i]) },
    });
    await write(runId, {
      eventType: 'step_started',
      correlationId,
      specVersion: spec,
    });
    await write(runId, {
      eventType: 'step_completed',
      correlationId,
      specVersion: spec,
      eventData: { result: bytes(i) },
    });
  }
  await write(runId, {
    eventType: 'run_completed',
    specVersion: spec,
    eventData: { output: bytes(n) },
  });
}

clearInterval(heartbeat);
maxGapMs = Math.max(maxGapMs, performance.now() - last);
process.send({ status: 'done', maxGapMs, runIds });
