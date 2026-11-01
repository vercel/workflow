/**
 * A `start({ hook })` run on the single-orchestrator engine that never opens
 * its start Hook still releases it at the run's end, against a real World
 * (world-local): the token is no longer resumable, and without a retention a
 * new start with it is admitted. With a retention, the token stays findable
 * but unresumable, and a new start conflicts naming the ended owner.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookConflictError,
  HookNotFoundError,
  RunExpiredError,
} from '@workflow/errors';
import {
  type CreateEventRequest,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type StartHook,
  startHookId,
  type World,
} from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { ulid } from 'ulid';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../../serialization.js';
import { runWorkflow } from '../../workflow.js';
import { setWorld } from '../world.js';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { pendingQueueDrain } from './suspension-handler.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));

const SPEC = SPEC_VERSION_SINGLE_ORCHESTRATOR;

// Never opens its start Hook: the token is only the run's idempotency key.
const ignoresStartHook = `
  async function workflow() { return "done"; }
  globalThis.__private_workflows = new Map([['workflow', workflow]]);
`;

let dir: string | undefined;

afterEach(async () => {
  setWorld(undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function localWorld(): Promise<World> {
  dir = await mkdtemp(join(tmpdir(), 'spec9-start-hook-terminal-'));
  const world: World = createWorld({ dataDir: dir });
  setWorld(world);
  return world;
}

/** Admits a candidate through `run_created`, as `start({ hook })` does. */
async function admit(world: World, startHook: StartHook): Promise<string> {
  const runId = `wrun_${ulid()}`;
  const input = await dehydrateWorkflowArguments([], runId, undefined, []);
  const created = await world.events.create(runId, {
    eventType: 'run_created',
    specVersion: SPEC,
    eventData: {
      deploymentId: 'dpl_start_hook_terminal',
      workflowName: 'workflow',
      input,
      startHook,
    },
  } as CreateEventRequest);
  expect(created.run?.startHook).toMatchObject({
    token: startHook.token,
    hookId: startHookId(runId),
  });
  return runId;
}

async function resume(world: World, runId: string, token: string) {
  return world.events.create(runId, {
    eventType: 'hook_received',
    specVersion: SPEC,
    correlationId: startHookId(runId),
    eventData: {
      token,
      payload: await dehydrateStepReturnValue('late', runId, undefined, []),
    },
  } as CreateEventRequest);
}

async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error('rejected without a value')
  );
}

describe.each([
  'node',
  'quickjs',
] as const)('the start Hook of a spec 9 run that never opens it (%s)', (engine) => {
  /** Starts and completes the run through the engine under test. */
  async function complete(world: World, runId: string) {
    await world.events.create(runId, {
      eventType: 'run_started',
      specVersion: SPEC,
    } as CreateEventRequest);
    const run = await world.runs.get(runId);
    const { data: events } = await world.events.list({
      runId,
      pagination: { sortOrder: 'asc', limit: 1000 },
    });
    if (engine === 'node') {
      const output = (await runWorkflow(
        ignoresStartHook,
        run,
        events,
        undefined,
        undefined,
        pendingQueueDrain(world, (data, params) =>
          world.events.create(runId, data, params)
        ),
        world.capabilities
      )) as Uint8Array;
      await world.events.create(runId, {
        eventType: 'run_completed',
        specVersion: SPEC,
        eventData: { output },
      } as CreateEventRequest);
    } else {
      await runWorkflowWithQuickJS({
        workflowCode: ignoresStartHook,
        workflowName: 'workflow',
        workflowRun: run,
        preloadedEvents: events,
        preloadedEventsComplete: true,
      });
    }
    expect((await world.runs.get(runId)).status).toBe('completed');
  }

  it('releases the token at the run end: not resumable, and a new start is admitted', async () => {
    const world = await localWorld();
    const token = `order:${ulid()}`;
    const owner = await admit(world, { token });

    await complete(world, owner);

    expect(
      HookNotFoundError.is(await settled(world.hooks.getByToken(token)))
    ).toBe(true);
    expect(
      HookNotFoundError.is(await settled(resume(world, owner, token)))
    ).toBe(true);
    const next = await admit(world, { token });
    expect((await world.hooks.getByToken(token)).runId).toBe(next);
  });

  it('keeps a retained token findable but not resumable, and a new start conflicts naming the owner', async () => {
    const world = await localWorld();
    const token = `order:${ulid()}`;
    const owner = await admit(world, {
      token,
      tokenRetentionUntil: new Date(Date.now() + 3_600_000),
    });

    await complete(world, owner);

    expect((await world.hooks.getByToken(token)).runId).toBe(owner);
    // Findable for the retention, but the ended run takes no deliveries.
    expect(RunExpiredError.is(await settled(resume(world, owner, token)))).toBe(
      true
    );
    const conflict = await settled(admit(world, { token }));
    assert(HookConflictError.is(conflict), String(conflict));
    expect(conflict.conflictingRunId).toBe(owner);
  });
});
