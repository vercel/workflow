#!/usr/bin/env node
/**
 * How long `world.experimental_usage.getRun` holds the process.
 *
 * node:sqlite is synchronous: while a usage read runs a query, the process
 * answers nothing else (a web server polling a run's usage stops serving).
 * The read counts a run's first pass in batches and yields between them,
 * so what matters is the longest stretch without a yield, not the total.
 * This measures it with a tick loop: the largest gap between two turns of
 * the event loop while the read runs is the longest synchronous block.
 *
 *   pnpm --filter @workflow/world-local build
 *   node packages/world-local/scripts/usage-blocking-bench.mjs [options]
 *
 * Options:
 *   --large-steps <n>     steps in the large run (default 300)
 *   --payload <bytes>     the large run's step input and result size
 *                         (default 262144: about 210 MB of events)
 *   --small-events <n>    events in the small-row run read first (default
 *                         12000: trains the batch size on small rows)
 *   --finished-steps <n>  small steps in the finished zero-retention run
 *                         and its twin that keeps its data (default 15000:
 *                         45,003 events)
 *   --json                print the results as JSON
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const { values } = parseArgs({
  options: {
    'large-steps': { type: 'string', default: '300' },
    payload: { type: 'string', default: String(256 * 1024) },
    'small-events': { type: 'string', default: '12000' },
    'finished-steps': { type: 'string', default: '15000' },
    json: { type: 'boolean', default: false },
  },
});
const LARGE_STEPS = Number(values['large-steps']);
const PAYLOAD = Number(values.payload);
const SMALL_EVENTS = Number(values['small-events']);
const FINISHED_STEPS = Number(values['finished-steps']);

const { createStorage } = await import(path.join(dist, 'storage.js'));
const { databaseFor } = await import(path.join(dist, 'db/index.js'));
const { createRun, createStep, updateRun, updateStep } = await import(
  path.join(dist, 'test-helpers.js')
);

process.env.WORKFLOW_LOCAL_SQLITE_KEEP_CONNECTIONS = '1';
const dataDir = mkdtempSync(path.join(tmpdir(), 'usage-blocking-bench-'));
const seed = createStorage(dataDir);
// A Buffer is stored as an array of numbers; a Uint8Array as base64, which
// is what the runtime writes.
const bytes = (n) => new Uint8Array(randomBytes(n));

async function seedRun(steps, payload, name, { finish, attributes } = {}) {
  const run = await createRun(seed, {
    deploymentId: 'dpl_bench',
    workflowName: `workflow//./src/workflows/bench//${name}`,
    input: bytes(payload),
    ...(attributes && { attributes, allowReservedAttributes: true }),
  });
  await updateRun(seed, run.runId, 'run_started');
  for (let i = 0; i < steps; i++) {
    const stepId = `step_${i}`;
    await createStep(seed, run.runId, {
      stepId,
      stepName: `step//./src/workflows/bench//work${i % 5}`,
      input: bytes(payload),
    });
    await updateStep(seed, run.runId, stepId, 'step_started');
    await updateStep(seed, run.runId, stepId, 'step_completed', {
      result: bytes(payload),
    });
  }
  if (finish) {
    await updateRun(seed, run.runId, 'run_completed', {
      output: bytes(payload),
    });
  }
  return run.runId;
}

/** Reads a run's usage, timing the read and its longest synchronous block. */
async function measure(storage, runId) {
  let longest = 0;
  let last = performance.now();
  let running = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const started = performance.now();
  const usage = await storage.experimental_usage.getRun(runId);
  const total = performance.now() - started;
  running = false;
  // The gap that ends with the read itself.
  longest = Math.max(longest, performance.now() - last);
  return {
    events: usage.events,
    totalMs: Number(total.toFixed(1)),
    longestBlockMs: Number(longest.toFixed(1)),
  };
}

let results;
try {
  const smallRun = await seedRun(
    Math.ceil((SMALL_EVENTS - 2) / 3),
    16,
    'small'
  );
  const largeRun = await seedRun(LARGE_STEPS, PAYLOAD, 'large');
  // Finished before it is read: one deletes its data when it finishes.
  const purgedRun = await seedRun(FINISHED_STEPS, 16, 'purged', {
    finish: true,
    attributes: { $retention: '0' },
  });
  const keptRun = await seedRun(FINISHED_STEPS, 16, 'kept', {
    finish: true,
    attributes: { zretention: '0' },
  });
  const stored = (runId) =>
    Number(
      databaseFor(dataDir).get(
        'SELECT SUM(length(CAST(doc AS BLOB))) AS bytes FROM events WHERE run_id = ?',
        runId
      )?.bytes ?? 0
    );

  // Each scenario reads through a World of its own (a fresh usage cache).
  results = {
    largeRunMB: Number((stored(largeRun) / 1e6).toFixed(1)),
    largeAlone: await measure(createStorage(dataDir), largeRun),
    largeAfterSmall: await (async () => {
      const storage = createStorage(dataDir);
      const small = await measure(storage, smallRun);
      const large = await measure(storage, largeRun);
      return { small, large };
    })(),
    finishedPurged: await measure(createStorage(dataDir), purgedRun),
    finishedKept: await measure(createStorage(dataDir), keptRun),
    repeatRead: await (async () => {
      const storage = createStorage(dataDir);
      await storage.experimental_usage.getRun(largeRun);
      return measure(storage, largeRun);
    })(),
  };
} finally {
  databaseFor(dataDir).close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (values.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const fmt = (r) =>
    `${r.events} events, read ${r.totalMs} ms, longest block ${r.longestBlockMs} ms`;
  console.log(`large run: ${results.largeRunMB} MB of events`);
  console.log(
    `large run, first read:               ${fmt(results.largeAlone)}`
  );
  console.log(
    `small-row run, first read:           ${fmt(results.largeAfterSmall.small)}`
  );
  console.log(
    `large run, first read after it:      ${fmt(results.largeAfterSmall.large)}`
  );
  console.log(
    `large run, repeat read (cached):     ${fmt(results.repeatRead)}`
  );
  console.log(
    `finished zero-retention run, first:  ${fmt(results.finishedPurged)}`
  );
  console.log(
    `finished kept twin, first read:      ${fmt(results.finishedKept)}`
  );
}
