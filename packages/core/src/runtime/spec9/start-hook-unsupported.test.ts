/**
 * The single-orchestrator engine does not admit `start({ hook })` candidates
 * yet. `start()` refuses the combination, so a keyed spec 9 message only
 * comes from another SDK version: its delivery must write and run nothing,
 * or its `run_started` would create the run without its start Hook.
 */

import { SPEC_VERSION_SINGLE_ORCHESTRATOR } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { expectAcknowledged } from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';

let bodies = 0;

registerStepFunction('start_hook_unsupported_step', async (n: number) => {
  bodies++;
  return n + 1;
});

const oneStep = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("start_hook_unsupported_step");
  async function workflow(n) { return await step(n); }
  ;globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

beforeEach(() => {
  bodies = 0;
  delete process.env.WORKFLOW_TURBO;
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
  delete process.env.WORKFLOW_TURBO;
});

describe.each([
  'node',
  'quickjs',
] as const)('a start Hook candidate on the single-orchestrator engine (%s)', (engine) => {
  it.each([
    ['', undefined],
    [' under turbo', '1'],
  ])('is acknowledged without a write or a step body%s', async (_label, turbo) => {
    if (turbo) process.env.WORKFLOW_TURBO = turbo;
    const runId = `wrun_${ulid()}`;
    const input = await dehydrateWorkflowArguments([1], runId, undefined, []);
    const world = new AppendOnlyWorld({ fence: true });
    setWorld(world.asWorld());
    await workflowEntrypoint(oneStep)(new Request('https://example.test'));
    const error = vi.spyOn(runtimeLogger, 'error');
    const start = world.enqueue(QUEUE, {
      runId,
      requestedAt: new Date(),
      runInput: {
        input,
        deploymentId: 'dpl_test',
        workflowName: 'workflow',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        executionContext: { workflowVm: engine },
        startHook: { token: 'order:spec9' },
      },
    });

    const result = await world.deliver(start);
    await world.runUntilIdle();

    expectAcknowledged(world, result, start);
    expect(world.creates).toHaveLength(0);
    expect(world.events).toEqual([]);
    expect(bodies).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/does not support start Hooks on spec 9 runs/),
      expect.objectContaining({ workflowRunId: runId })
    );
  });
});
