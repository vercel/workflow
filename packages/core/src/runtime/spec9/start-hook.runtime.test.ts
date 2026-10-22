/**
 * The queued copy of a `start({ hook })` candidate on the single-orchestrator
 * engine: its `run_started` carries the reservation and may be the write that
 * admits or refuses the candidate. A refused candidate runs no code, creates
 * nothing and acknowledges, through every path a delivery can take before
 * the decision is known.
 */

import {
  EntityConflictError,
  HookConflictError,
  START_HOOK_ADMISSION_REJECTED,
  WorkflowWorldError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import {
  AppendOnlyWorld,
  type HeldMessage,
} from '../../test-support/append-only-world.js';
import { expectAcknowledged } from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';
const TOKEN = 'order:spec9';

let currentEngine: 'node' | 'quickjs' = 'node';
let bodies = 0;

registerStepFunction('start_hook_spec9_step', async (n: number) => {
  bodies++;
  return n + 1;
});

const oneStep = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("start_hook_spec9_step");
  async function workflow(n) { return await step(n); }
  ;globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

type Decision = 'accept' | 'refuse' | 'reject' | 'finished';

/**
 * A candidate and its first orchestrator message, carrying
 * `runInput.startHook`. Undecided unless `accept`: no `run_created` landed
 * (the direct write is still in flight or failed), and the World decides on
 * the `run_started` the delivery writes. `accept` is a candidate the direct
 * `run_created` already admitted.
 */
async function candidate(decision: Decision, holdRunStartedMs = 0) {
  const runId = `wrun_${ulid()}`;
  const input = await dehydrateWorkflowArguments([1], runId, undefined, []);
  const runStartedData: Record<string, unknown>[] = [];
  const world = new AppendOnlyWorld({
    fence: true,
    async beforeCreate(data) {
      if (data.eventType !== 'run_started') return;
      runStartedData.push(data.eventData ?? {});
      // Slow admission: anything that does not wait for it gets ahead.
      if (holdRunStartedMs) {
        await new Promise((r) => setTimeout(r, holdRunStartedMs));
      }
      if (decision === 'refuse') {
        throw new HookConflictError(TOKEN, 'wrun_owner');
      }
      if (decision === 'reject') {
        throw new WorkflowWorldError('disabled', {
          status: 400,
          code: START_HOOK_ADMISSION_REJECTED,
        });
      }
      if (decision === 'finished') {
        throw new EntityConflictError('finished');
      }
    },
  });
  if (decision === 'accept') {
    // Admitted by the direct `run_created`, which landed first.
    world.seedRun({
      runId,
      workflowName: 'workflow',
      deploymentId: 'dpl_test',
      status: 'pending',
      executionContext: { workflowVm: currentEngine },
      input,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }
  setWorld(world.asWorld());
  await workflowEntrypoint(oneStep)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, {
    runId,
    requestedAt: new Date(),
    runInput: {
      input,
      deploymentId: 'dpl_test',
      workflowName: 'workflow',
      specVersion: SPEC_VERSION_CURRENT,
      executionContext: { workflowVm: currentEngine },
      encryptionPublicKey: 'pk_base64',
      startHook: { token: TOKEN },
    },
  });
  return { world, start, runStartedData };
}

/** The non-first deliveries a candidate's message can take. */
const nonFirst: [string, (held: HeldMessage) => HeldMessage][] = [
  ['a redelivery', (held) => ({ ...held, deliveryCount: 2 })],
  ['a coalesced re-run', (held) => ({ ...held, coalescedRerun: 1 })],
  [
    'a handoff before run_started returned',
    (held) => ({ ...held, deliveryCount: 2, handoffCount: 1 }),
  ],
];

beforeEach(() => {
  bodies = 0;
  delete process.env.WORKFLOW_TURBO;
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('start Hook candidates on the single-orchestrator engine (%s)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('never takes turbo: a refused first delivery runs no step body and acknowledges', async () => {
    process.env.WORKFLOW_TURBO = '1';
    // Admission takes long enough that a turbo delivery's inline step body
    // would run while it is pending.
    const { world, start, runStartedData } = await candidate('refuse', 500);
    const info = vi.spyOn(runtimeLogger, 'info');

    const result = await world.deliver(start);

    expectAcknowledged(world, result, start);
    expect(bodies).toBe(0);
    expect(world.events).toEqual([]);
    expect(runStartedData).toHaveLength(1);
    // Nothing was written: the refusal came back before any other write.
    expect(world.creates).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/another run owns the token/),
      expect.objectContaining({ conflictingRunId: 'wrun_owner' })
    );
  });

  it('carries the reservation and the public key on run_started', async () => {
    const { world, start, runStartedData } = await candidate('accept');

    const result = await world.deliver(start);
    await world.runUntilIdle();

    expectAcknowledged(world, result, start);
    expect(runStartedData[0]).toMatchObject({
      startHook: { token: TOKEN },
      encryptionPublicKey: 'pk_base64',
    });
    expect(bodies).toBe(1);
    expect(world.events.map((e) => e.eventType)).toContain('run_completed');
  });

  it('acknowledges a permanent admission rejection', async () => {
    const { world, start } = await candidate('reject');
    const error = vi.spyOn(runtimeLogger, 'error');

    const result = await world.deliver(start);

    expectAcknowledged(world, result, start);
    expect(bodies).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/permanently rejected/),
      expect.anything()
    );
  });

  it('keeps the ordinary handling of a run that already finished', async () => {
    const { world, start } = await candidate('finished');
    const info = vi.spyOn(runtimeLogger, 'info');

    const result = await world.deliver(start);

    expectAcknowledged(world, result, start);
    expect(info).toHaveBeenCalledWith(
      'Run already finished during setup, skipping',
      expect.anything()
    );
  });

  describe.each(nonFirst)('on %s of an undecided candidate', (_label, as) => {
    it('learns a refusal from run_started and acknowledges', async () => {
      const { world, start, runStartedData } = await candidate('refuse');
      // The queue now delivers this message as a non-first delivery.
      world.held.splice(world.held.indexOf(start), 1);
      const held = as(start);

      const result = await world.deliver(held);

      // Reached the resilient `run_started` (no 404, no no-op exit), which
      // carried the reservation and refused the candidate.
      expect(runStartedData).toEqual([
        expect.objectContaining({ startHook: { token: TOKEN } }),
      ]);
      expectAcknowledged(world, result, held);
      expect(bodies).toBe(0);
      expect(world.events).toEqual([]);
    });

    it('runs an admitted candidate', async () => {
      const { world, start, runStartedData } = await candidate('accept');
      world.held.splice(world.held.indexOf(start), 1);

      await world.deliver(as(start));
      await world.runUntilIdle();

      expect(runStartedData[0]).toMatchObject({ startHook: { token: TOKEN } });
      expect(world.events.map((e) => e.eventType)).toContain('run_completed');
    });
  });
});
