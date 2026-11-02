/**
 * Every orchestrator and step message a run's deliveries send names the run's
 * spec version, so routing never reads the run for them and a World keys and
 * serializes them from the payload alone. Runs end to end on world-local, for
 * spec 8 and spec 9 runs on both workflow VM engines.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  messageRunSpecVersion,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  type WorkflowInvokePayload,
  type World,
} from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { MAX_MAX_INLINE_STEPS } from './constants.js';
import type { RunSpec } from './run-spec-routing.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// Every routing decision, in delivery order. A result carrying `run` is a
// routing read of the run.
const { routed } = vi.hoisted(() => ({ routed: [] as RunSpec[] }));
vi.mock('./run-spec-routing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-spec-routing.js')>();
  return {
    ...actual,
    resolveRunSpec: async (
      ...args: Parameters<typeof actual.resolveRunSpec>
    ) => {
      const spec = await actual.resolveRunSpec(...args);
      routed.push(spec);
      return spec;
    },
  };
});
const routingReads = () =>
  routed.filter((spec) => spec.run !== undefined).length;

const STEP_NAME = 'specStampAdd';
registerStepFunction(STEP_NAME, async (a: number, b: number) => a + b);

// Wider than any inline budget, so steps also run from their own messages,
// and a sleep, so the run arms a timer.
const FAN_OUT = MAX_MAX_INLINE_STEPS + 1;
const WORKFLOW_CODE = `
  const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(STEP_NAME)});
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    const first = await add(0, 1);
    const sums = await Promise.all(
      Array.from({ length: ${FAN_OUT} }, (_, i) => add(first, i))
    );
    await sleep("1s");
    return await add(sums.length, 0);
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

type Sent = { queueName: string; payload: WorkflowInvokePayload };

describe('spec stamps on world-local', () => {
  let dataDir: string;
  let world: LocalWorld | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-spec-stamp-'));
    routed.length = 0;
  });

  afterEach(async () => {
    setWorld(undefined);
    await world?.close();
    world = undefined;
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  async function runToCompletion(params: {
    specVersion: number;
    workflowVm: 'quickjs' | undefined;
    startMessage: (runId: string) => WorkflowInvokePayload;
  }) {
    const local = createWorld({ dataDir });
    world = local;
    local.registerHandler('__wkf_workflow_', workflowEntrypoint(WORKFLOW_CODE));
    const sent: Sent[] = [];
    const queue = local.queue.bind(local);
    local.queue = ((queueName, payload, opts) => {
      if (queueName.startsWith('__wkf_workflow_')) {
        sent.push({ queueName, payload: payload as WorkflowInvokePayload });
      }
      return queue(queueName, payload, opts);
    }) as typeof local.queue;
    setWorld(local as unknown as World);
    await local.start();
    const created = await local.events.create(null, {
      eventType: 'run_created',
      specVersion: params.specVersion,
      eventData: {
        deploymentId: 'dpl_spec_stamp',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
        ...(params.workflowVm && {
          executionContext: { workflowVm: params.workflowVm },
        }),
      },
    });
    const runId = created.run?.runId as string;
    await queue('__wkf_workflow_workflow', params.startMessage(runId));
    await vi.waitFor(
      async () => {
        const run = await local.runs.get(runId);
        expect(run.status).toBe('completed');
      },
      { timeout: 30_000, interval: 50 }
    );
    return { runId, sent };
  }

  const cases = [
    { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM, engine: 'node' },
    { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM, engine: 'quickjs' },
    { specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR, engine: 'node' },
    { specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR, engine: 'quickjs' },
  ] as const;

  it.each(
    cases
  )('stamps every message of a spec $specVersion run ($engine)', async ({
    specVersion,
    engine,
  }) => {
    const { sent } = await runToCompletion({
      specVersion,
      workflowVm: engine === 'quickjs' ? 'quickjs' : undefined,
      startMessage: (runId) => ({ runId, runSpecVersion: specVersion }),
    });
    const steps = sent.filter((s) => s.payload.stepId !== undefined);
    const timers = sent.filter((s) => s.payload.waitContinuation);
    const wakes = sent.filter(
      (s) => s.payload.stepId === undefined && !s.payload.waitContinuation
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(timers.length).toBeGreaterThan(0);
    for (const { payload } of sent) {
      expect(messageRunSpecVersion(payload)).toBe(specVersion);
    }
    // Orchestrator wakes and timers carry the hint itself, not only a step's
    // run identity.
    for (const { payload } of [...timers, ...wakes]) {
      expect(payload.runSpecVersion).toBe(specVersion);
    }
    expect(routingReads()).toBe(0);
    expect(routed.length).toBeGreaterThan(0);
    for (const spec of routed) expect(spec.specVersion).toBe(specVersion);
  });

  it.each(
    cases
  )('reads the run once for an unstamped message of a spec $specVersion run ($engine)', async ({
    specVersion,
    engine,
  }) => {
    await runToCompletion({
      specVersion,
      workflowVm: engine === 'quickjs' ? 'quickjs' : undefined,
      startMessage: (runId) => ({ runId }),
    });
    expect(routingReads()).toBe(1);
  });

  it.each([
    'node',
    'quickjs',
  ] as const)('hands a spec 9 run message with a spec 8 hint to the spec 9 orchestrator ($engine)', async (engine) => {
    const { sent } = await runToCompletion({
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      workflowVm: engine === 'quickjs' ? 'quickjs' : undefined,
      startMessage: (runId) => ({
        runId,
        runSpecVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
      }),
    });
    expect(routed[0]?.specVersion).toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
    // The spec 8 orchestrator re-sent it, with the run's version.
    expect(sent[0]?.payload).toMatchObject({
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    expect(
      routed
        .slice(1)
        .every((spec) => spec.specVersion === SPEC_VERSION_SINGLE_ORCHESTRATOR)
    ).toBe(true);
    expect(routingReads()).toBe(0);
  });
});
