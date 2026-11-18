#!/usr/bin/env node
/**
 * Seeds a Local World data directory with runs to review the run's Usage
 * page (`/run/<runId>/usage`) on, and optionally serves the web UI on it.
 *
 *   pnpm --filter @workflow/world-local build
 *   pnpm --filter @workflow/web build
 *   node packages/web/scripts/seed-usage-run.mjs --serve
 *
 * It prints the data directory and the Usage page URL of each run:
 *
 * - `processOrder`, completed: two attributes, eight step functions (so the
 *   table folds the smallest into "+ N other steps"), one of them retried
 *   twice and one called four times, a sleep, a hook that receives one
 *   payload, and a stream with three chunks.
 * - `syncInventory`, still running (no `run_completed`): its page keeps
 *   polling, and the header and the page show the numbers so far.
 *
 * The events go through the World's storage API (`events.create`), the call
 * the runtime makes, so the counts are the ones a real run of these shapes
 * writes. The payloads are random bytes.
 *
 * Options:
 *   --data-dir <dir>   where to write (default: a new temporary directory)
 *   --serve            start the built web server on it afterwards
 *   --port <n>         the server's port (default 3456)
 *
 * Needs world-local built (it loads world-local's `dist`), and web built
 * for `--serve` (it starts `packages/web/server.js`).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const worldLocalDist = path.resolve(webDir, '../world-local/dist');

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string', default: '3456' },
  },
});
const PORT = Number(values.port);
const dataDir = values['data-dir']
  ? path.resolve(values['data-dir'])
  : mkdtempSync(path.join(tmpdir(), 'workflow-usage-seed-'));
mkdirSync(dataDir, { recursive: true });

const { createWorld } = await import(path.join(worldLocalDist, 'index.js'));
const { SPEC_VERSION_CURRENT } = await import('@workflow/world');

const world = createWorld({ dataDir });
const bytes = (size) => new Uint8Array(randomBytes(size));

/** One event, as the runtime writes it. */
async function event(runId, eventType, rest = {}) {
  return world.events.create(runId, {
    eventType,
    specVersion: SPEC_VERSION_CURRENT,
    ...rest,
  });
}

async function startRun(workflowName, attributes) {
  const { run } = await event(null, 'run_created', {
    eventData: {
      deploymentId: 'dpl_usage_seed',
      workflowName,
      input: bytes(400),
    },
  });
  await event(run.runId, 'run_started');
  if (attributes) {
    await event(run.runId, 'attr_set', {
      eventData: {
        changes: Object.entries(attributes).map(([key, value]) => ({
          key,
          value,
        })),
        writer: { type: 'workflow' },
      },
    });
  }
  return run.runId;
}

let stepCount = 0;

/** One call of a step: created, started, then `retries` retries, then completed. */
async function step(runId, stepName, { retries = 0, size = 600 } = {}) {
  const stepId = `step_${String(++stepCount).padStart(4, '0')}`;
  await event(runId, 'step_created', {
    correlationId: stepId,
    eventData: { stepName, input: bytes(size) },
  });
  for (let attempt = 1; attempt <= retries; attempt++) {
    await event(runId, 'step_started', { correlationId: stepId });
    await event(runId, 'step_retrying', {
      correlationId: stepId,
      eventData: {
        error: { message: `attempt ${attempt} failed` },
        retryAfter: new Date(),
      },
    });
  }
  await event(runId, 'step_started', { correlationId: stepId });
  await event(runId, 'step_completed', {
    correlationId: stepId,
    eventData: { result: bytes(size) },
  });
}

const stepName = (workflow, name) =>
  `step//./src/workflows/${workflow}//${name}`;

// A completed order: steps of eight functions, a retried charge, a sleep,
// a hook and a stream.
const order = await startRun('workflow//./src/workflows/order//processOrder', {
  customer: 'acme',
  region: 'us-east',
});
const orderStep = (name, options) =>
  step(order, stepName('order', name), options);
await orderStep('validateOrder');
await orderStep('chargeCard', { retries: 2, size: 1200 });
for (let i = 0; i < 4; i++) await orderStep('reserveInventory');
for (let i = 0; i < 3; i++) await orderStep('sendEmail', { size: 2400 });
await orderStep('applyDiscount');
await orderStep('calculateTax');
await orderStep('createShipment', { size: 4000 });
await orderStep('notifyWarehouse');

await event(order, 'wait_created', {
  correlationId: 'wait_0001',
  eventData: { resumeAt: new Date() },
});
await event(order, 'wait_completed', { correlationId: 'wait_0001' });

await event(order, 'hook_created', {
  correlationId: 'hook_0001',
  eventData: { token: `approval:${order}` },
});
await event(order, 'hook_received', {
  correlationId: 'hook_0001',
  eventData: { payload: bytes(800) },
});
await event(order, 'hook_disposed', { correlationId: 'hook_0001' });

for (const chunk of ['label printed', 'picked up', 'delivered']) {
  await world.streams.write(order, 'shipment-updates', chunk);
}
await world.streams.close(order, 'shipment-updates');
await event(order, 'run_completed', { eventData: { output: bytes(300) } });

// A run that has not finished.
const sync = await startRun(
  'workflow//./src/workflows/inventory//syncInventory'
);
await step(sync, stepName('inventory', 'fetchStock'));
await step(sync, stepName('inventory', 'writeStock'), { retries: 1 });

await world.close();

const base = `http://localhost:${PORT}`;
console.log(`Seeded ${dataDir}`);
console.log(`  processOrder (completed): ${base}/run/${order}/usage`);
console.log(`  syncInventory (running):  ${base}/run/${sync}/usage`);

if (values.serve) {
  console.log(`Serving the web UI on ${base} (Ctrl+C to stop)`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: webDir,
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: 'local',
      WORKFLOW_LOCAL_DATA_DIR: dataDir,
      WORKFLOW_OBSERVABILITY_CWD: dataDir,
      PORT: String(PORT),
    },
    stdio: 'inherit',
  });
  process.on('SIGINT', () => server.kill('SIGINT'));
} else {
  console.log(
    `Serve it with: WORKFLOW_TARGET_WORLD=local WORKFLOW_LOCAL_DATA_DIR=${dataDir} PORT=${PORT} node packages/web/server.js`
  );
}
