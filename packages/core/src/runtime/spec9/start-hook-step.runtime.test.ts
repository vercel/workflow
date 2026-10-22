/**
 * `start({ hook })` called from a workflow on the single-orchestrator engine,
 * where `start()` is a step: a refusal reaches the workflow on the first
 * attempt with its type intact, and an uncertain start is retried until it
 * becomes the owner or is refused naming the first candidate.
 */

import { HookConflictError, WorkflowWorldError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type WorkflowRun } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { start } from '../start.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';
const TOKEN = 'order:child';

/** The World the child start writes to, separate from the parent's. */
let childWorld: {
  createCalls: number;
  answer: (attempt: number, runId: string) => Promise<unknown>;
  admitted: string[];
};

function childWorldObject() {
  return {
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: async () => 'dpl_test',
    capabilities: {
      atomicStartHook: { active: true },
      hookRetention: { active: true },
      inBandFence: true,
    },
    queue: async () => ({ messageId: null }),
    events: {
      create: async (runId: string, data: any) => {
        childWorld.createCalls++;
        return childWorld.answer(childWorld.createCalls, runId).then(() => {
          childWorld.admitted.push(runId);
          return {
            run: {
              runId,
              status: 'pending',
              startHook: data.eventData.startHook,
            },
          };
        });
      },
    },
  } as any;
}

registerStepFunction(
  'start_child_with_hook',
  Object.assign(
    async () => {
      const run = await start({ workflowId: 'child' }, [], {
        world: childWorldObject(),
        hook: { token: TOKEN },
      });
      return run.runId;
    },
    { maxRetries: 3 }
  )
);

const WORKFLOW = `const startChild = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("start_child_with_hook");
  async function workflow() {
    try {
      return { started: await startChild() };
    } catch (e) {
      return { error: e.name, conflictingRunId: e.conflictingRunId };
    }
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

let currentEngine: 'node' | 'quickjs' = 'node';
let clockOffsetMs = 0;

async function runParent() {
  const runId = `wrun_parent_${Math.random().toString(36).slice(2)}`;
  // A step retry waits out its backoff on the queue: move the clock with it.
  const world = new AppendOnlyWorld({
    fence: true,
    advanceClock: (seconds) => {
      clockOffsetMs += seconds * 1000;
    },
  });
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: currentEngine },
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  setWorld(world.asWorld());
  await workflowEntrypoint(WORKFLOW)(new Request('https://example.test'));
  world.enqueue(QUEUE, { runId, requestedAt: new Date() });
  await world.runUntilIdle();
  const completed = world.events.find((e) => e.eventType === 'run_completed');
  expect(completed).toBeDefined();
  const output = await hydrateWorkflowReturnValue(
    (completed as any).eventData.output,
    runId,
    undefined
  );
  return {
    world,
    output,
    count: (type: string) =>
      world.events.filter((e) => e.eventType === type).length,
  };
}

beforeEach(() => {
  childWorld = { createCalls: 0, answer: async () => {}, admitted: [] };
  clockOffsetMs = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('start({ hook }) inside a single-orchestrator step (%s)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('hands a refusal to the workflow on the first attempt, as HookConflictError', async () => {
    childWorld.answer = async () => {
      throw new HookConflictError(TOKEN, 'wrun_owner');
    };

    const { output, count } = await runParent();

    expect(output).toEqual({
      error: 'HookConflictError',
      conflictingRunId: 'wrun_owner',
    });
    expect(count('step_retrying')).toBe(0);
    expect(childWorld.createCalls).toBe(1);
  });

  it('retries an uncertain start, ending with exactly one owner', async () => {
    // Attempt 1: admitted, but the response is lost. Attempt 2: a new
    // candidate, refused in favor of the first.
    let first: string | undefined;
    childWorld.answer = async (attempt, runId) => {
      if (attempt === 1) {
        first = runId;
        throw new WorkflowWorldError('gateway timeout', { status: 504 });
      }
      throw new HookConflictError(TOKEN, first);
    };

    const { output, count } = await runParent();

    expect(count('step_retrying')).toBe(1);
    expect(output).toEqual({
      error: 'HookConflictError',
      conflictingRunId: first,
    });
    expect(childWorld.admitted).toEqual([]);
  });

  it('retries an uncertain start into an admission', async () => {
    childWorld.answer = async (attempt) => {
      if (attempt === 1) {
        throw new WorkflowWorldError('gateway timeout', { status: 504 });
      }
    };

    const { output, count } = await runParent();

    expect(count('step_retrying')).toBe(1);
    expect(output).toEqual({ started: childWorld.admitted[0] });
    expect(childWorld.admitted).toHaveLength(1);
  });
});
