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
import { z } from 'zod';
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
async function candidate(
  decision: Decision,
  holdRunStartedMs = 0,
  /**
   * Answer the first `run_started` without its run, as a backend did for a
   * `run_started` that overtook `run_created`: before or after committing it.
   */
  runlessOnce?: 'before-commit' | 'after-commit'
) {
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
  const asWorld = world.asWorld();
  if (runlessOnce) {
    const create = asWorld.events.create.bind(asWorld.events);
    let answered = false;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const first = args[1].eventType === 'run_started' && !answered;
      if (first) answered = true;
      if (first && runlessOnce === 'before-commit') throw runlessResponse();
      const result = await create(...args);
      if (first) throw runlessResponse();
      return result;
    }) as typeof create;
  }
  setWorld(asWorld);
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

/** A `run_started` response that failed its schema at `run` alone. */
function runlessResponse() {
  const parsed = z
    .object({ run: z.object({ startedAt: z.coerce.date() }) })
    .safeParse({ event: {} });
  if (parsed.success) throw new Error('unreachable');
  return new WorkflowWorldError('v4 createEvent: invalid response body', {
    code: 'SCHEMA_VALIDATION',
    cause: parsed.error,
  });
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

  it.each([
    'before-commit',
    'after-commit',
  ] as const)('retries a run_started answered without its run (%s) by redelivery, which admits and completes', async (when) => {
    const { world, start } = await candidate('accept', 0, when);
    const warn = vi.spyOn(runtimeLogger, 'warn');

    await expect(world.deliver(start)).rejects.toSatisfy(WorkflowWorldError.is);
    // No fatal run_failed: the queue redelivers instead.
    expect(world.events.map((e) => e.eventType)).not.toContain('run_failed');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/answered without the run/),
      expect.anything()
    );

    await world.runUntilIdle();
    const types = world.events.map((e) => e.eventType);
    expect(types).toContain('run_completed');
    expect(types).not.toContain('run_failed');
    expect(types.filter((t) => t === 'run_started')).toHaveLength(1);
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
