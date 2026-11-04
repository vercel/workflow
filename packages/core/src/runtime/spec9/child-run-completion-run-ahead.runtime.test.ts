import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

/**
 * Spec 9 run-ahead (see `run-ahead.runtime.test.ts`) beside a child the
 * parent started: a child the parent does not await must not stop it.
 */

let currentWorld: AppendOnlyWorld | undefined;
/** Per `cra_inc` body start: how many earlier `cra_inc` outcomes were uncommitted. */
let unconfirmed: number[] = [];
let incStarted = 0;
/** Children `cra_readFinished` reports as finished. */
let finished: string[] = [];

registerStepFunction('cra_inc', async (n: number) => {
  incStarted++;
  const world = currentWorld;
  if (world) {
    const committed = eventsOf(world, 'step_completed').filter(
      (event) =>
        (event as { eventData?: { stepName?: string } }).eventData?.stepName ===
        'cra_inc'
    ).length;
    unconfirmed.push(incStarted - 1 - committed);
  }
  return n + 1;
});
registerStepFunction('cra_start', async () => 'wrun_child');
registerStepFunction('cra_readFinished', async (ids: string[]) =>
  ids.filter((id) => finished.includes(id))
);
registerStepFunction('cra_readValue', async () => 42);

// The module is compiled into real workflow bundles; it has no runtime
// imports, so its transpiled source runs in the VM as is.
const moduleSource = ts.transpileModule(
  readFileSync(new URL('../child-run-completion.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }
).outputText;

const workflowCode = (body: string) => `
const __completion = (function () { var exports = {}; ${moduleSource}; return exports; })();
const useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
const inc = useStep("cra_inc");
const startChild = useStep("cra_start");
const readFinished = useStep("cra_readFinished");
const readValue = useStep("cra_readValue");
// What \`run.returnValue\` does for a run this workflow started.
const returnValue = (id) => __completion.awaitChildRunCompletion(
  id,
  globalThis[Symbol.for("WORKFLOW_CONTEXT")].workflowRunId,
  () => readValue(id),
  (ids) => readFinished(ids)
);
async function loop(steps) {
  let n = 0;
  for (let i = 0; i < steps; i++) n = await inc(n);
  return n;
}
async function workflow(steps) { ${body} }${registerWorkflow()}`;

const STEPS = 6;
const RAN_AHEAD = [0, 1, 2, 3, 4, 5];
const DRAINED = [0, 0, 0, 0, 0, 0];

const slowOutcomes = {
  async beforeCreate(data: { eventType: string }) {
    if (data.eventType === 'step_completed') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  },
};

async function run(body: string, { untilSteps = false } = {}) {
  const setup = await setupOrchestratorRun(
    workflowCode(body),
    [STEPS],
    slowOutcomes,
    'node'
  );
  currentWorld = setup.world;
  for (let i = 0; i < 50 && setup.world.held.length > 0; i++) {
    await setup.world.deliver(setup.world.held[0]!);
    // A parent still waiting on its child never finishes here.
    if (untilSteps && incStarted >= STEPS) break;
  }
  return setup.world;
}

beforeEach(() => {
  unconfirmed = [];
  incStarted = 0;
  finished = [];
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.stubEnv('VERCEL_URL', 'run-ahead.example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
  currentWorld = undefined;
});

describe('spec 9 run-ahead beside a child run (node engine)', () => {
  it('runs ahead beside a child whose returnValue is never read', async () => {
    const world = await run(`await startChild(); return await loop(steps);`);
    expect(await runResult(world)).toBe(STEPS);
    expect(eventsOf(world, 'hook_created')).toHaveLength(0);
    expect(unconfirmed).toEqual(RAN_AHEAD);
  });

  it('runs ahead beside a returnValue that is read but not yet awaited', async () => {
    const world = await run(`
      const id = await startChild();
      const pending = returnValue(id);
      return await loop(steps);
    `);
    expect(await runResult(world)).toBe(STEPS);
    // Reading it registered nothing.
    expect(eventsOf(world, 'hook_created')).toHaveLength(0);
    expect(unconfirmed).toEqual(RAN_AHEAD);
  });

  it('runs ahead after a wait, with the completion hook still open', async () => {
    finished = ['wrun_child'];
    const world = await run(`
      const id = await startChild();
      await returnValue(id);
      return await loop(steps);
    `);
    expect(await runResult(world)).toBe(STEPS);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
    expect(eventsOf(world, 'hook_disposed')).toHaveLength(0);
    expect(unconfirmed).toEqual(RAN_AHEAD);
  });

  it('drains while the workflow is actually waiting on the child', async () => {
    // The child's completion schedules `readReturnValue` at whichever
    // boundary it lands on, so every boundary of the wait is path-changing.
    await run(
      `
      const id = await startChild();
      const [n] = await Promise.all([loop(steps), returnValue(id)]);
      return n;
    `,
      { untilSteps: true }
    );
    expect(unconfirmed).toEqual(DRAINED);
  });
});
