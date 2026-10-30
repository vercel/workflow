/**
 * The queued copy of a `start({ hook })` candidate on the single-orchestrator
 * engine: its `run_started` carries the start Hook request and may be the write
 * that admits or refuses the candidate. A refused candidate runs no code, creates
 * nothing and acknowledges, through every path a delivery can take before
 * the decision is known.
 */

import {
  EntityConflictError,
  HookConflictError,
  RUN_ERROR_CODES,
  START_HOOK_ADMISSION_DISABLED,
  START_HOOK_ADMISSION_REJECTED,
  ThrottleError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  slotToEventId,
  startHookId,
} from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from '../../serialization.js';
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

type Decision =
  | 'accept'
  | 'refuse'
  | 'reject'
  | 'disabled'
  | 'finished'
  | 'admit-on-run-started';

/**
 * A candidate and its first orchestrator message, carrying
 * `runInput.startHook`. Undecided unless `accept`: no `run_created` landed
 * (the direct write is still in flight or failed), and the World decides on
 * the `run_started` the delivery writes. `accept` is a candidate the direct
 * `run_created` already admitted; `admit-on-run-started` one that only the
 * queued copy's `run_started` admits.
 */
async function candidate(
  decision: Decision,
  holdRunStartedMs = 0,
  /**
   * Answer the first `run_started` with this error, before or after the World
   * commits it.
   */
  failFirstRunStarted?: {
    when: 'before-commit' | 'after-commit';
    error: () => unknown;
  },
  /**
   * `false`: a World that ignores `startHook`, which echoes it neither on
   * `run_started` nor on `runs.get`.
   */
  echo = true
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
      if (decision === 'disabled') {
        throw new WorkflowWorldError('disabled', {
          status: 400,
          code: START_HOOK_ADMISSION_DISABLED,
        });
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
      ...(echo
        ? { startHook: { token: TOKEN, hookId: startHookId(runId) } }
        : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }
  const asWorld = world.asWorld();
  // The start Hook the World holds for the run once admitted, which
  // `runs.get` echoes as the run's `startHook`.
  let admitted: { token: string; hookId: string } | undefined =
    decision === 'accept' && echo
      ? { token: TOKEN, hookId: startHookId(runId) }
      : undefined;
  {
    const get = asWorld.runs.get.bind(asWorld.runs);
    asWorld.runs.get = (async (...args: Parameters<typeof get>) => {
      const run = await get(...args);
      return admitted ? { ...run, startHook: admitted } : run;
    }) as typeof get;
  }
  if (echo) {
    // An admitting World echoes the start Hook on the run it returns (this
    // fake keeps no start Hooks of its own).
    const create = asWorld.events.create.bind(asWorld.events);
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      const startHook = (
        args[1] as { eventData?: { startHook?: { token: string } } }
      ).eventData?.startHook;
      if (args[1].eventType === 'run_started' && startHook && result.run) {
        admitted = { ...startHook, hookId: startHookId(runId) };
        return {
          ...result,
          run: {
            ...result.run,
            startHook: { ...startHook, hookId: startHookId(runId) },
          },
        };
      }
      return result;
    }) as typeof create;
  }
  if (failFirstRunStarted) {
    const { when, error } = failFirstRunStarted;
    const create = asWorld.events.create.bind(asWorld.events);
    let answered = false;
    asWorld.events.create = (async (...args: Parameters<typeof create>) => {
      const first = args[1].eventType === 'run_started' && !answered;
      if (first) answered = true;
      if (first && when === 'before-commit') throw error();
      const result = await create(...args);
      if (first) throw error();
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
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
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

  it('carries the start Hook request and the public key on run_started', async () => {
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

  it('redelivers a kill-switch answer, which recorded nothing for the candidate', async () => {
    const { world, start } = await candidate('disabled');

    await expect(world.deliver(start)).rejects.toMatchObject({
      code: START_HOOK_ADMISSION_DISABLED,
    });
    // Held for redelivery, not acknowledged; nothing ran.
    expect(world.held.length).toBe(1);
    expect(bodies).toBe(0);
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
  ] as const)('redelivers a run_started whose outcome the World could not settle (%s), never acknowledging it as a refusal', async (when) => {
    const { world, start } = await candidate('accept', 0, {
      when,
      error: () =>
        new WorkflowWorldError('in-band outcome unknown', {
          status: 503,
          code: 'in-band-outcome-unknown',
          retryAfter: 1,
        }),
    });

    await expect(world.deliver(start)).rejects.toMatchObject({ status: 503 });
    // Held for redelivery, not acknowledged; no step body ran, no run_failed.
    expect(world.held.length).toBe(1);
    expect(bodies).toBe(0);
    expect(world.events.map((e) => e.eventType)).not.toContain('run_failed');

    await world.runUntilIdle();
    const types = world.events.map((e) => e.eventType);
    expect(types).toContain('run_completed');
    expect(types).not.toContain('run_failed');
  });

  it('fails a redelivery whose committed run_started never echoed the token, running no code', async () => {
    // The admitting write committed, but its answer was lost: the redelivery
    // finds run_started in the log and must check the echo on the loaded run.
    const { world, start } = await candidate(
      'accept',
      0,
      {
        when: 'after-commit',
        error: () =>
          new WorkflowWorldError('in-band outcome unknown', {
            status: 503,
            code: 'in-band-outcome-unknown',
            retryAfter: 1,
          }),
      },
      false
    );

    // Redelivered, however the delivery reports it, and nothing ran yet.
    await world.deliver(start).catch(() => undefined);
    expect(world.events.map((e) => e.eventType)).toContain('run_started');
    expect(bodies).toBe(0);

    await world.runUntilIdle();

    expect(bodies).toBe(0);
    const types = world.events.map((e) => e.eventType);
    expect(types).not.toContain('step_created');
    expect(types).not.toContain('run_completed');
    expect(
      world.events.find((e) => e.eventType === 'run_failed')?.eventData
    ).toMatchObject({ errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
  });

  it('fails an already-started run whose start Hook echoes another token, running no code', async () => {
    const runId = `wrun_${ulid()}`;
    const input = await dehydrateWorkflowArguments([1], runId, undefined, []);
    const executionContext = { workflowVm: engine };
    const at = new Date();
    const world = new AppendOnlyWorld({ fence: true });
    world.seedLog(
      {
        runId,
        workflowName: 'workflow',
        deploymentId: 'dpl_test',
        status: 'running',
        executionContext,
        input,
        startHook: { token: 'order:other', hookId: startHookId(runId) },
        createdAt: at,
        updatedAt: at,
      } as any,
      [
        {
          eventId: slotToEventId(1),
          runId,
          eventType: 'run_created',
          createdAt: at,
          specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          eventData: {
            deploymentId: 'dpl_test',
            workflowName: 'workflow',
            input,
            executionContext,
          },
        },
        {
          eventId: slotToEventId(2),
          runId,
          eventType: 'run_started',
          createdAt: at,
          specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        },
      ] as unknown as Event[]
    );
    setWorld(world.asWorld());
    await workflowEntrypoint(oneStep)(new Request('https://example.test'));
    const start = world.enqueue(QUEUE, {
      runId,
      requestedAt: new Date(),
      runInput: {
        input,
        deploymentId: 'dpl_test',
        workflowName: 'workflow',
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        executionContext,
        startHook: { token: TOKEN },
      },
    });

    const result = await world.deliver(start);
    await world.runUntilIdle();

    expectAcknowledged(world, result, start);
    expect(bodies).toBe(0);
    const types = world.events.map((e) => e.eventType);
    expect(types).not.toContain('step_created');
    expect(
      world.events.find((e) => e.eventType === 'run_failed')?.eventData
    ).toMatchObject({ errorCode: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR });
  });

  // A World that continues a message on a new one (world-vercel near the
  // message's expiry, or its handoff bound) does so only for a delivery that
  // asked for a handoff, and the continuation drops `runInput`. So no exit
  // before admission may be a handoff: each must be a redelivery of the same
  // message, which still carries the start Hook request.
  it.each([
    [
      '503',
      () =>
        new WorkflowWorldError('unavailable', { status: 503, retryAfter: 1 }),
    ],
    ['429', () => new ThrottleError('busy', { retryAfter: 1 })],
  ] as const)('redelivers the same message, never a handoff, when the admitting run_started fails with a %s', async (_label, error) => {
    const { world, start, runStartedData } = await candidate(
      'admit-on-run-started',
      0,
      { when: 'before-commit', error }
    );

    const outcome = await world.deliver(start).then(
      (result) => ({ result }),
      (thrown: unknown) => ({ thrown })
    );

    expect(outcome).not.toHaveProperty('result');
    // Held for redelivery as the same message, start Hook request and all.
    expect(world.held).toHaveLength(1);
    expect(world.held[0].message).toBe(start.message);
    expect(world.held[0].messageId).toBe(start.messageId);
    expect(world.held[0].handoffCount ?? 0).toBe(0);
    expect(
      (world.held[0].message as { runInput?: { startHook?: unknown } }).runInput
        ?.startHook
    ).toEqual({ token: TOKEN });
    expect(world.events).toEqual([]);
    expect(bodies).toBe(0);

    // The redelivery admits it, from the request the message still held.
    await world.runUntilIdle();
    expect(runStartedData.at(-1)).toMatchObject({
      startHook: { token: TOKEN },
    });
    expect(world.events.map((e) => e.eventType)).toContain('run_completed');
  });

  describe.each(nonFirst)('on %s of an undecided candidate', (_label, as) => {
    it('learns a refusal from run_started and acknowledges', async () => {
      const { world, start, runStartedData } = await candidate('refuse');
      // The queue now delivers this message as a non-first delivery.
      world.held.splice(world.held.indexOf(start), 1);
      const held = as(start);

      const result = await world.deliver(held);

      // Reached the resilient `run_started` (no 404, no no-op exit), which
      // carried the start Hook request and refused the candidate.
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

/**
 * A `start({ hook })` run the World admitted with a payload already resumed
 * into its start Hook: the log holds `run_created` (carrying the start Hook)
 * and a `hook_received` for `startHookId(runId)` while the run is still
 * pending, and the first orchestrator message is still queued.
 */
async function admittedWithEarlyPayload(
  code: string,
  engine: 'node' | 'quickjs'
) {
  const runId = `wrun_${ulid()}`;
  const hookId = startHookId(runId);
  const input = await dehydrateWorkflowArguments([1], runId, undefined, []);
  const executionContext = { workflowVm: engine };
  const at = new Date();
  const events = [
    {
      eventId: slotToEventId(1),
      runId,
      eventType: 'run_created',
      createdAt: at,
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'workflow',
        input,
        executionContext,
        startHook: { token: TOKEN, hookId },
      },
    },
    {
      eventId: slotToEventId(2),
      runId,
      eventType: 'hook_received',
      correlationId: hookId,
      createdAt: at,
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      eventData: {
        token: TOKEN,
        payload: await dehydrateStepReturnValue(
          { message: 'early' },
          runId,
          undefined,
          []
        ),
      },
    },
  ] as unknown as Event[];
  const world = new AppendOnlyWorld({ fence: true });
  world.seedLog(
    {
      runId,
      workflowName: 'workflow',
      deploymentId: 'dpl_test',
      status: 'pending',
      executionContext,
      input,
      startHook: { token: TOKEN, hookId },
      createdAt: at,
      updatedAt: at,
    } as any,
    events
  );
  setWorld(world.asWorld());
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, {
    runId,
    requestedAt: new Date(),
    runInput: {
      input,
      deploymentId: 'dpl_test',
      workflowName: 'workflow',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      executionContext,
      startHook: { token: TOKEN },
    },
  });
  return { world, start, runId, hookId };
}

async function outputOf(world: AppendOnlyWorld, runId: string) {
  const completed = world.events.find((e) => e.eventType === 'run_completed');
  expect(completed).toBeDefined();
  return hydrateWorkflowReturnValue(
    (completed as { eventData: { output: Uint8Array } }).eventData.output,
    runId,
    undefined,
    []
  );
}

describe.each([
  'node',
  'quickjs',
] as const)('start Hook deliveries to a pending run on the single-orchestrator engine (%s)', (engine) => {
  it('delivers a payload resumed while the run was pending once the body opens the start Hook', async () => {
    const opens = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow(n) {
        const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
        const conflict = await hook.getConflict();
        const payload = await hook;
        return { conflict, message: payload.message };
      }
      ;globalThis.__private_workflows = new Map([["workflow", workflow]]);`;
    const { world, start, runId, hookId } = await admittedWithEarlyPayload(
      opens,
      engine
    );

    const result = await world.deliver(start);
    await world.runUntilIdle();

    expectAcknowledged(world, result, start);
    expect(await outputOf(world, runId)).toEqual({
      conflict: null,
      message: 'early',
    });
    // Bound, not created: the admission stands for the Hook's creation.
    expect(
      world.events.filter(
        (e) => e.eventType === 'hook_created' && e.correlationId === hookId
      )
    ).toEqual([]);
  });

  it('completes a run that never opens its start Hook, leaving the payload unread', async () => {
    const ignores = `async function workflow(n) { return n + 1; }
      ;globalThis.__private_workflows = new Map([["workflow", workflow]]);`;
    const { world, start, runId } = await admittedWithEarlyPayload(
      ignores,
      engine
    );

    const result = await world.deliver(start);
    await world.runUntilIdle();

    expectAcknowledged(world, result, start);
    expect(await outputOf(world, runId)).toBe(2);
    const types = world.events.map((e) => e.eventType);
    expect(types).not.toContain('run_failed');
    expect(types.filter((t) => t === 'hook_received')).toHaveLength(1);
  });
});
