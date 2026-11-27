// Cold-process time to first step on a spec 9 run, node:vm against QuickJS.
//
// One turbo first delivery per process, on the in-memory append-only World,
// from the built package (`pnpm --filter @workflow/core build`). The harness
// in src/runtime/spec9/engine-latency.bench.runtime.test.ts covers warm
// processes; vitest's module transform makes its first test unusable as a
// cold sample, hence this script. Findings: src/runtime/quickjs-performance.md.
//
//   node scripts/benchmark-engine-cold-start.mjs [--bundle <workflowCode.js>] [--runs 5]
//
// `--bundle` loads a build's workflow bundle (the `workflowCode` its flow
// route embeds) next to the benchmark workflow, so each VM pays for it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

if (args[0] === '--child') {
  await child(args[1], args[2] ?? '');
} else {
  const bundle = option('--bundle', '');
  const runs = Number(option('--runs', '5'));
  const median = (xs) =>
    [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  for (const engine of ['node', 'quickjs']) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const out = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--child', engine, bundle],
        { encoding: 'utf8' }
      );
      const line = out.stdout.trim().split('\n').at(-1);
      if (out.status !== 0 || !line) {
        throw new Error(`child failed: ${out.stderr.slice(-2000)}`);
      }
      samples.push(JSON.parse(line));
    }
    console.log(
      JSON.stringify({
        engine,
        bundleChars: samples[0].bundleChars,
        runs,
        ttfsMsMedian: median(samples.map((s) => s.ttfsMs)),
        ttfsMs: samples.map((s) => s.ttfsMs),
      })
    );
  }
}

async function child(engine, bundlePath) {
  const bundle = bundlePath ? fs.readFileSync(bundlePath, 'utf8') : '';
  const { AppendOnlyWorld } = await import(
    new URL('test-support/append-only-world.js', dist)
  );
  const { setWorld } = await import(new URL('runtime/world.js', dist));
  const { workflowEntrypoint } = await import(new URL('runtime.js', dist));
  const { registerStepFunction } = await import(new URL('private.js', dist));
  const { dehydrateWorkflowArguments } = await import(
    new URL('serialization.js', dist)
  );

  let bodyAt;
  registerStepFunction('cold_step', async (label) => {
    bodyAt ??= performance.now();
    return label;
  });
  const code = `${bundle}
;if (!globalThis.__private_workflows) globalThis.__private_workflows = new Map();
const __cold_step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("cold_step");
async function __cold_workflow() { return await __cold_step("first"); }
globalThis.__private_workflows.set("workflow", __cold_workflow);`;
  process.env.WORKFLOW_ORCHESTRATOR_LINGER_MS = '0';
  process.env.WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS = '0';
  process.env.WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS = '0';

  const runId = `wrun_cold_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld({});
  const input = await dehydrateWorkflowArguments([], runId, undefined, []);
  const executionContext = { workflowVm: engine };
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext,
    input,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  // `runInput` on the start message, as `start()` sends it: a turbo delivery.
  const start = world.enqueue('__wkf_workflow_workflow', {
    runId,
    requestedAt: new Date(),
    runInput: {
      deploymentId: 'dpl_test',
      workflowName: 'workflow',
      input,
      executionContext,
      specVersion: 9,
    },
  });
  const t0 = performance.now();
  await world.deliver(start);
  if (!world.events.some((e) => e.eventType === 'run_completed')) {
    throw new Error('the run did not complete');
  }
  console.log(
    JSON.stringify({
      engine,
      bundleChars: bundle.length,
      ttfsMs: +(bodyAt - t0).toFixed(1),
    })
  );
  process.exit(0);
}
