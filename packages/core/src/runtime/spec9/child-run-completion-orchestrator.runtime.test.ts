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

/** Resolves once every `cra_inc` body of the run has started. */
let allIncStarted: () => void = () => {};
let allIncStartedPromise: Promise<void> = Promise.resolve();

registerStepFunction('cra_inc', async (n: number) => {
  incStarted++;
  if (incStarted >= STEPS) allIncStarted();
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

/**
 * Longest a `cra_inc` outcome write is held when the bodies do not all start
 * (the workflow drains, and each body waits for the outcome before it).
 */
const OUTCOME_HOLD_MS = 200;

/**
 * Holds each `cra_inc` outcome write until every `cra_inc` body has started,
 * or {@link OUTCOME_HOLD_MS}, whichever is first. While the workflow runs
 * ahead, the bodies start without waiting for these writes, so body `k`
 * finds exactly `k` outcomes unconfirmed (`RAN_AHEAD`) however slow the
 * machine. A fixed delay let a slow runner commit an outcome before the last
 * body started. While it drains, each body waits for the previous outcome,
 * which commits once the hold times out (`DRAINED`).
 */
const slowOutcomes = {
  async beforeCreate(data: {
    eventType: string;
    eventData?: { stepName?: string };
  }) {
    if (
      data.eventType === 'step_completed' &&
      data.eventData?.stepName === 'cra_inc'
    ) {
      await Promise.race([
        allIncStartedPromise,
        new Promise((resolve) => setTimeout(resolve, OUTCOME_HOLD_MS)),
      ]);
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
  allIncStartedPromise = new Promise<void>((resolve) => {
    allIncStarted = resolve;
  });
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

/**
 * A delivery with nothing left to run lingers while the run waits on a hook
 * (`awaitsExternalWork`). The parent's completion hook stays open between
 * waits, but it is only external work while a child is awaited.
 */
describe.each([
  'node',
  'quickjs',
] as const)('orchestrator linger beside the completion hook (%s engine)', (engine) => {
  const LINGER_MS = 700;

  async function firstDelivery(body: string) {
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', String(LINGER_MS));
    const setup = await setupOrchestratorRun(
      workflowCode(body),
      [0],
      { subscribe: true },
      engine
    );
    const startedAt = Date.now();
    await setup.world.deliver(setup.start);
    return { world: setup.world, ms: Date.now() - startedAt };
  }

  it('does not linger on an idle completion hook', async () => {
    finished = ['wrun_child'];
    const { world, ms } = await firstDelivery(`
      const id = await startChild();
      await returnValue(id);
      await globalThis[Symbol.for("WORKFLOW_SLEEP")]("1d");
      return 1;
    `);
    // Waited, then parked on a day-long sleep with the hook still open.
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
    expect(eventsOf(world, 'hook_disposed')).toHaveLength(0);
    expect(eventsOf(world, 'wait_created').length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LINGER_MS);
  });

  it('lingers while a child is awaited', async () => {
    const { world, ms } = await firstDelivery(`
      const id = await startChild();
      return await returnValue(id);
    `);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
    expect(ms).toBeGreaterThanOrEqual(LINGER_MS);
  });
});
