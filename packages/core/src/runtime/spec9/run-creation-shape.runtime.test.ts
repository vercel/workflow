/**
 * A single-orchestrator (spec 9) run whose creation is recorded on its first
 * `run_started` alone: the resilient start's `run_started` created the run
 * and holds the first slot with the creation data, and the log has no
 * `run_created` (`isRunCreationEvent`). Every reader takes the run's input and
 * identity from that `run_started`, as it does from a `run_created`.
 */
import type { Event, WorkflowRun } from '@workflow/world';
import { FIRST_EVENT_SLOT, slotToEventId } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  dataOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let added = 0;
registerStepFunction('rcs_add', async (a: number, b: number) => {
  added++;
  return a + b;
});

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

/** The run's arguments reach the body and a step. */
const code = `const add = ${step('rcs_add')};
  async function workflow(a, b) { return (await add(a, b)) * 10; }${registerWorkflow()}`;

const types = (events: readonly Event[]) => events.map((e) => e.eventType);

/**
 * A resilient start: `run_created` never landed, and the first orchestrator
 * message carries `runInput`. The World records the creation on the
 * `run_started` that creates the run.
 */
async function resilientStart(engine: 'node' | 'quickjs', args: unknown[]) {
  const runId = `wrun_${ulid()}`;
  const world = new AppendOnlyWorld({ creationOnStart: true });
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(ORCHESTRATOR_QUEUE, {
    runId,
    requestedAt: new Date(),
    runInput: {
      input: await dehydrateWorkflowArguments(args, runId, undefined, []),
      deploymentId: 'dpl_test',
      workflowName: 'workflow',
      specVersion: 9,
      executionContext: { workflowVm: engine },
    },
  });
  return { world, runId, start };
}

/**
 * A fresh World holding `events`, as a later delivery finds the log. The run
 * record carries no input, so the replay can only have read it from the log.
 */
async function coldWorld(
  source: AppendOnlyWorld,
  runId: string,
  events: readonly Event[]
) {
  const run = (await source.asWorld().runs.get(runId)) as WorkflowRun;
  const cold = new AppendOnlyWorld({ skipStepInputs: true });
  cold.seedLog({ ...run, input: undefined, status: 'running' }, events);
  setWorld(cold.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  return cold;
}

beforeEach(() => {
  added = 0;
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('run creation recorded on run_started (%s engine)', (engine) => {
  it('runs a resilient start whose run_started is the creation', async () => {
    const { world, start } = await resilientStart(engine, [2, 3]);
    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(50);
    expect(types(world.events)).toEqual([
      'run_started',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
    const [creation] = world.events;
    expect(creation?.eventId).toBe(slotToEventId(FIRST_EVENT_SLOT));
    expect(dataOf(creation)?.workflowName).toBe('workflow');
  });

  it('replays a finished log with no run_created from cold, reading the input from the run_started', async () => {
    const { world, runId, start } = await resilientStart(engine, [2, 3]);
    await world.deliver(start);
    await world.runUntilIdle();
    const terminal = world.events.findIndex(
      (event) => event.eventType === 'run_completed'
    );
    const cold = await coldWorld(world, runId, world.events.slice(0, terminal));
    await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId }));

    expect(await runResult(cold)).toBe(50);
    // Nothing ran again, and the replay wrote nothing but the completion.
    expect(added).toBe(1);
    expect(cold.creates.map((c) => c.event.eventType)).toEqual([
      'run_completed',
    ]);
  });

  it('runs the body from a log holding only its creating run_started, with no runInput on the message', async () => {
    // The delivery that wrote the start died right after it: the
    // redelivery carries no `runInput`, so the input is in the log alone.
    const { world, runId, start } = await resilientStart(engine, [4, 5]);
    const asWorld = world.asWorld();
    const create = asWorld.events.create.bind(asWorld.events);
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      if (args[1].eventType !== 'run_started') {
        throw new Error('invocation died');
      }
      return create(...args);
    }) as typeof create;
    setWorld(asWorld);
    await workflowEntrypoint(code)(new Request('https://example.test'));
    await world.deliver(start).catch(() => {});
    expect(types(world.events)).toEqual(['run_started']);

    const cold = await coldWorld(world, runId, world.events);
    await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId }));
    await cold.runUntilIdle();

    expect(await runResult(cold)).toBe(90);
    expect(types(cold.events)).toEqual([
      'run_started',
      'step_started',
      'step_completed',
      'run_completed',
    ]);
  });
});
