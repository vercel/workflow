#!/usr/bin/env node
/**
 * How much polling a run's usage slows the rest of the web server.
 *
 * world-local reads SQLite synchronously, so while a `fetchRunUsage` RPC
 * runs, the server answers nothing else. This seeds a data directory with a
 * live (unfinished) run, starts the built web server on it, and samples the
 * runs-list RPC (`fetchRuns`) every 50 ms: first alone, then while
 * `fetchRunUsage` polls the run every 5 s, as an open run page does.
 *
 *   pnpm --filter @workflow/web build
 *   node packages/web/scripts/usage-polling-bench.mjs [options]
 *
 * Options:
 *   --steps <n>          steps in the run (default 300)
 *   --payload <bytes>    each step's input and result size (default 262144)
 *   --seconds <n>        how long each phase samples (default 30)
 *   --write-every <ms>   keep the run writing: one more step this often
 *                        (default 0: the run sits waiting, like a sleep)
 *   --port <n>           server port (default 3471)
 *   --json               print the results as JSON
 *
 * Needs world-local and web built (it loads world-local's `dist` and starts
 * `packages/web/server.js`).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decode, encode } from 'cbor-x';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const worldLocalDist = path.resolve(webDir, '../world-local/dist');

const { values } = parseArgs({
  options: {
    steps: { type: 'string', default: '300' },
    payload: { type: 'string', default: String(256 * 1024) },
    seconds: { type: 'string', default: '30' },
    'write-every': { type: 'string', default: '0' },
    port: { type: 'string', default: '3471' },
    json: { type: 'boolean', default: false },
  },
});
const STEPS = Number(values.steps);
const PAYLOAD = Number(values.payload);
const SECONDS = Number(values.seconds);
const WRITE_EVERY_MS = Number(values['write-every']);
const PORT = Number(values.port);
const SAMPLE_EVERY_MS = 50;
const POLL_EVERY_MS = 5000;

// A Buffer is stored as an array of numbers; a Uint8Array as base64, which is
// what the runtime writes.
const payload = () => new Uint8Array(randomBytes(PAYLOAD));

const { createStorage } = await import(path.join(worldLocalDist, 'storage.js'));
const { databaseFor } = await import(path.join(worldLocalDist, 'db/index.js'));
const { createRun, createStep, updateRun, updateStep } = await import(
  path.join(worldLocalDist, 'test-helpers.js')
);

const dataDir = mkdtempSync(path.join(tmpdir(), 'usage-polling-bench-'));
const storage = createStorage(dataDir);

async function writeStep(runId, i) {
  const stepId = `step_${i}`;
  await createStep(storage, runId, {
    stepId,
    stepName: `step//./src/workflows/bench//work${i % 5}`,
    input: payload(),
  });
  await updateStep(storage, runId, stepId, 'step_started');
  await updateStep(storage, runId, stepId, 'step_completed', {
    result: payload(),
  });
}

const seedStart = performance.now();
const run = await createRun(storage, {
  deploymentId: 'dpl_bench',
  workflowName: 'workflow//./src/workflows/bench//benchWorkflow',
  input: payload(),
});
await updateRun(storage, run.runId, 'run_started');
for (let i = 0; i < STEPS; i++) await writeStep(run.runId, i);
const stored = databaseFor(dataDir).get(
  'SELECT SUM(length(CAST(doc AS BLOB))) AS bytes FROM events WHERE run_id = ?',
  run.runId
);
const seedMs = performance.now() - seedStart;

const server = spawn(process.execPath, ['server.js'], {
  cwd: webDir,
  env: {
    ...process.env,
    WORKFLOW_TARGET_WORLD: 'local',
    WORKFLOW_LOCAL_DATA_DIR: dataDir,
    WORKFLOW_OBSERVABILITY_CWD: dataDir,
    PORT: String(PORT),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const base = `http://localhost:${PORT}`;

async function rpc(method, params) {
  const response = await fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/cbor',
      accept: 'application/cbor',
    },
    body: encode({ method, params }),
  });
  const body = decode(new Uint8Array(await response.arrayBuffer()));
  if (!body?.success) {
    throw new Error(`${method} failed: ${JSON.stringify(body?.error)}`);
  }
  return body.data;
}

let nextStep = STEPS;
let stopping = false;
const serverExited = new Promise((resolve) => server.once('exit', resolve));
server.once('exit', (code) => {
  if (code && !stopping) {
    console.error(`web server exited with code ${code}`);
    process.exit(1);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let i = 0; ; i++) {
  try {
    await rpc('fetchRuns', { params: { limit: 20 } });
    break;
  } catch (error) {
    if (i > 100) throw error;
    await sleep(200);
  }
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    p50: Number(at(0.5).toFixed(1)),
    p99: Number(at(0.99).toFixed(1)),
    max: Number(sorted.at(-1).toFixed(1)),
  };
}

/** Samples fetchRuns for SECONDS, optionally polling usage alongside. */
async function phase({ pollUsage }) {
  const deadline = Date.now() + SECONDS * 1000;
  const runsMs = [];
  const usageMs = [];
  let stop = false;

  const poller = (async () => {
    while (pollUsage && !stop) {
      const t = performance.now();
      await rpc('fetchRunUsage', { runId: run.runId });
      usageMs.push(performance.now() - t);
      await sleep(POLL_EVERY_MS);
    }
  })();
  const writer = (async () => {
    while (WRITE_EVERY_MS > 0 && !stop) {
      await sleep(WRITE_EVERY_MS);
      if (!stop) await writeStep(run.runId, nextStep++);
    }
  })();

  while (Date.now() < deadline) {
    const t = performance.now();
    await rpc('fetchRuns', { params: { limit: 20 } });
    runsMs.push(performance.now() - t);
    await sleep(SAMPLE_EVERY_MS);
  }
  stop = true;
  await Promise.all([poller, writer]);
  return {
    fetchRuns: stats(runsMs),
    ...(usageMs.length > 0 && { fetchRunUsage: stats(usageMs) }),
  };
}

let results;
try {
  const alone = await phase({ pollUsage: false });
  const polling = await phase({ pollUsage: true });
  const usage = await rpc('fetchRunUsage', { runId: run.runId });
  results = {
    run: {
      steps: STEPS,
      payloadBytes: PAYLOAD,
      storedEventBytes: Number(stored?.bytes ?? 0),
      events: usage.events,
      seededInMs: Math.round(seedMs),
      writeEveryMs: WRITE_EVERY_MS,
    },
    alone,
    polling,
  };
} finally {
  stopping = true;
  server.kill();
  await serverExited;
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (values.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const { run: r, alone, polling } = results;
  const fmt = (s) =>
    `p50 ${s.p50} ms, p99 ${s.p99} ms, max ${s.max} ms (n=${s.n})`;
  console.log(
    `run: ${r.steps} steps × ${r.payloadBytes} B input + result, ${(r.storedEventBytes / 1e6).toFixed(1)} MB of events, ${r.events} events${r.writeEveryMs ? `, one more step every ${r.writeEveryMs} ms` : ', waiting'}`
  );
  console.log(`fetchRuns alone:             ${fmt(alone.fetchRuns)}`);
  console.log(`fetchRuns while usage polls: ${fmt(polling.fetchRuns)}`);
  console.log(`fetchRunUsage:               ${fmt(polling.fetchRunUsage)}`);
}
