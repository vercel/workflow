import type { Event, WorkflowRun } from '@workflow/world';
import { slotToEventId } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  creationsOf,
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
  stepMessagesOf,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const calls: Record<string, number> = {};
const count = (name: string) => {
  calls[name] = (calls[name] ?? 0) + 1;
};

registerStepFunction('cs_add', async (a: number, b: number) => {
  count('cs_add');
  return a + b;
});
const once = Object.assign(
  async (n: number) => {
    count('cs_once');
    return n + 1;
  },
  { maxRetries: 0 }
);
registerStepFunction('cs_once', once);

const step = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

/** A sequential step, then a fan-out of three. */
const mixedWorkflow = `const add = ${step('cs_add')};
  async function workflow() {
    const first = await add(1, 2);
    const [a, b, c] = await Promise.all([add(first, 1), add(first, 2), add(first, 3)]);
    return a + b + c;
  }${registerWorkflow()}`;

const oneStepWorkflow = `const add = ${step('cs_add')};
  async function workflow() { return await add(20, 22); }${registerWorkflow()}`;

const onceWorkflow = `const once = ${step('cs_once')};
  async function workflow() { return await once(await once(0)); }${registerWorkflow()}`;

/** The log types of every step event, per step, in log order. */
function stepShapes(events: readonly Event[]): string[][] {
  const byStep = new Map<string, string[]>();
  for (const event of events) {
    if (!event.eventType.startsWith('step_') || !event.correlationId) continue;
    const shape = byStep.get(event.correlationId) ?? [];
    shape.push(event.eventType);
    byStep.set(event.correlationId, shape);
  }
  return [...byStep.values()];
}

/**
 * The log an earlier runtime wrote for the same decisions: each inline step's
 * creation-bearing `step_started` split into a `step_created` (inline) and a
 * bare `step_started` behind it, positions renumbered.
 */
function toOlderShape(events: readonly Event[]): Event[] {
  const out: Event[] = [];
  for (const event of events) {
    const data = dataOf(event);
    if (event.eventType === 'step_started' && data?.inline === true) {
      const { workflowName, input, inline, ...start } = data;
      out.push({
        ...event,
        eventType: 'step_created',
        eventData: {
          stepName: start.stepName,
          workflowName,
          input,
          inline,
        },
      } as Event);
      out.push({ ...event, eventData: start } as Event);
      continue;
    }
    out.push(event);
  }
  return out.map((event, index) => ({
    ...event,
    eventId: slotToEventId(index + 1),
  }));
}

/** A fresh World holding `events`, as a later delivery finds the log. */
async function seededWorld(
  source: AppendOnlyWorld,
  events: readonly Event[],
  code: string,
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = {}
) {
  const run = (await source
    .asWorld()
    .runs.get(source.events[0]!.runId)) as WorkflowRun;
  const cold = new AppendOnlyWorld(options);
  cold.seedLog({ ...run, status: 'running' }, events);
  setWorld(cold.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  return { cold, runId: run.runId };
}

/** Runs `code` to the end of its first delivery, failing its first outcome. */
async function diedBeforeOutcome(
  code: string,
  engine: 'node' | 'quickjs'
): Promise<AppendOnlyWorld> {
  const { world, start } = await setupOrchestratorRun(code, [], {}, engine);
  const asWorld = world.asWorld();
  const create = asWorld.events.create.bind(asWorld.events);
  asWorld.events.create = (async (...args: Parameters<typeof create>) => {
    if (args[1].eventType === 'step_completed') {
      throw new Error('invocation died');
    }
    return create(...args);
  }) as typeof create;
  setWorld(asWorld);
  await workflowEntrypoint(code)(new Request('https://example.test'));
  await world.deliver(start).catch(() => {});
  return world;
}

beforeEach(() => {
  for (const key of Object.keys(calls)) delete calls[key];
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('step creation shape (%s engine)', (engine) => {
  it('writes one event before the outcome of an inline step, and two for a background step, in a mixed fan-out', async () => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '2');
    const { world } = await setupOrchestratorRun(mixedWorkflow, [], {}, engine);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(15);
    const shapes = stepShapes(world.events);
    expect(shapes).toHaveLength(4);
    const inline = shapes.filter((shape) => shape[0] === 'step_started');
    const background = shapes.filter((shape) => shape[0] === 'step_created');
    // The sequential step and the fan-out's first two run inline.
    expect(inline).toHaveLength(3);
    for (const shape of inline) {
      expect(shape).toEqual(['step_started', 'step_completed']);
    }
    expect(background).toEqual([
      ['step_created', 'step_started', 'step_completed'],
    ]);
    expect(stepMessagesOf(world)).toHaveLength(1);
    // A background step's own start carries no creation.
    const createdId = eventsOf(world, 'step_created')[0]?.correlationId;
    const backgroundStart = eventsOf(world, 'step_started').find(
      (event) => event.correlationId === createdId
    );
    expect(dataOf(backgroundStart)?.inline).toBeUndefined();
    expect(dataOf(backgroundStart)?.input).toBeUndefined();
  });

  it('creates a step that allows no retries by its start alone', async () => {
    const { world } = await setupOrchestratorRun(onceWorkflow, [], {}, engine);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(2);
    expect(calls.cs_once).toBe(2);
    expect(eventsOf(world, 'step_created')).toEqual([]);
    expect(stepShapes(world.events)).toEqual([
      ['step_started', 'step_completed'],
      ['step_started', 'step_completed'],
    ]);
  });

  it.each([
    'new',
    'older',
  ] as const)('replays a finished log in the %s shape to the same result from cold', async (shape) => {
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '2');
    const { world } = await setupOrchestratorRun(mixedWorkflow, [], {}, engine);
    await world.runUntilIdle();
    const result = await runResult(world);
    const ran = calls.cs_add;

    const terminal = world.events.findIndex(
      (event) => event.eventType === 'run_completed'
    );
    const log = world.events.slice(0, terminal);
    const { cold, runId } = await seededWorld(
      world,
      shape === 'older' ? toOlderShape(log) : log,
      mixedWorkflow,
      { skipStepInputs: true }
    );
    await cold.deliver(cold.enqueue(ORCHESTRATOR_QUEUE, { runId }));

    expect(await runResult(cold)).toBe(result);
    // Nothing ran again, and the replay wrote nothing but the completion.
    expect(calls.cs_add).toBe(ran);
    expect(cold.creates.map((c) => c.event.eventType)).toEqual([
      'run_completed',
    ]);
  });

  it.each([
    'new',
    'older',
  ] as const)('runs an inline step again from a log in the %s shape whose delivery died before its outcome, reading its input back', async (shape) => {
    const world = await diedBeforeOutcome(oneStepWorkflow, engine);
    expect(stepShapes(world.events)).toEqual([['step_started']]);
    expect(calls.cs_add).toBe(1);

    const log =
      shape === 'older' ? toOlderShape(world.events) : [...world.events];
    // Replay pages omit step inputs, so the input is read back from the
    // step's creation.
    const { cold, runId } = await seededWorld(world, log, oneStepWorkflow, {
      skipStepInputs: true,
    });
    // A redelivery of the message that created the step.
    const redelivery = cold.enqueue(ORCHESTRATOR_QUEUE, { runId });
    redelivery.messageId = world.deliveries[0]?.messageId as string;
    redelivery.deliveryCount = 2;
    await cold.runUntilIdle();

    expect(await runResult(cold)).toBe(42);
    expect(cold.strippedStepInputs).toBeGreaterThan(0);
    expect(calls.cs_add).toBe(2);
    // Run again inline as a redelivery attempt of the same step, never
    // created a second time and never moved to its own message.
    const starts = eventsOf(cold, 'step_started');
    expect(starts.map((e) => dataOf(e)?.attempt)).toEqual([1, 2]);
    expect(eventsOf(cold, 'step_retrying')).toHaveLength(0);
    expect(dataOf(starts[1])?.input).toBeUndefined();
    expect(creationsOf(cold)).toHaveLength(1);
    expect(stepMessagesOf(cold)).toEqual([]);
  });
});
