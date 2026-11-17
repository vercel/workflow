/**
 * The per-run event ceiling (`maxEvents`) on every orchestrator delivery of a
 * spec 9 run, against an append-only World.
 *
 * A spec 9 run writes `run_started` on its first delivery only, so a later
 * delivery learns the ceiling from its log load. A run whose log is already
 * past the ceiling fails on its next delivery without reading the whole log.
 */

import { HookNotFoundError, RUN_ERROR_CODES } from '@workflow/errors';
import {
  type Event,
  type Hook,
  isSealedNoopEvent,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateRunError,
} from '../../serialization.js';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import { resumeHook } from '../resume-hook.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const QUEUE = '__wkf_workflow_workflow';

// One hook per iteration, forever: every resume is a new delivery that
// replays the whole log and adds to it.
const LOOP_WORKFLOW = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    for (let i = 0; ; i++) {
      await createHook({ token: "loop-" + i });
    }
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

// One sleep per iteration, forever: every timer is a new delivery.
const SLEEP_LOOP_WORKFLOW = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    for (;;) {
      await sleep("1s");
    }
  }
  globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

let currentEngine: 'node' | 'quickjs' = 'node';

type WorldOptions = ConstructorParameters<typeof AppendOnlyWorld>[0];

/** A World view over `world` with `hooks.getByToken`, for `resumeHook()`. */
function view(world: AppendOnlyWorld, runId: string): World {
  const base = world.asWorld();
  (base as { hooks: unknown }).hooks = {
    async getByToken(token: string): Promise<Hook> {
      const created = world.events.find(
        (e) =>
          e.eventType === 'hook_created' &&
          (e as { eventData?: { token?: string } }).eventData?.token === token
      );
      if (!created) throw new HookNotFoundError(token);
      return {
        runId,
        hookId: created.correlationId as string,
        token,
        ownerId: 'owner_test',
        projectId: 'project_test',
        environment: 'production',
        createdAt: created.createdAt,
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        resumeContext: {
          deploymentId: 'dpl_test',
          workflowName: 'workflow',
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          workflowCoreVersion: '5.0.0',
        },
      } as Hook;
    },
  };
  return base;
}

async function setup(options: WorldOptions = {}, code = LOOP_WORKFLOW) {
  const runId = `wrun_me_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
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
  setWorld(view(world, runId));
  await workflowEntrypoint(code)(new Request('https://example.test'));
  world.enqueue(QUEUE, { runId, requestedAt: new Date() });
  return { world, runId };
}

const eventsOf = (world: AppendOnlyWorld, type: string) =>
  world.events.filter((event) => event.eventType === type);

/** The events the ceiling counts: every one but a sealed `noop`. */
const workflowEventCount = (world: AppendOnlyWorld) =>
  world.events.filter((event) => !isSealedNoopEvent(event)).length;

const errorCodeOf = (event: Event | undefined) =>
  (event as { eventData?: { errorCode?: string } } | undefined)?.eventData
    ?.errorCode;

/** The error a `run_failed` recorded. */
async function runErrorOf(event: Event | undefined, runId: string) {
  const error = (event as { eventData?: { error?: unknown } } | undefined)
    ?.eventData?.error;
  return (await hydrateRunError(error, runId, undefined)) as {
    message: string;
  };
}

/** A clock the runtime reads through `Date.now()`, moved by tests. */
function offsetClock() {
  let offsetMs = 0;
  const realNow = Date.now.bind(Date);
  const spy = vi
    .spyOn(Date, 'now')
    .mockImplementation(() => realNow() + offsetMs);
  return {
    advance(ms: number) {
      offsetMs += ms;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

/**
 * A hook-loop run whose log holds `resumes` resumed hooks, read by `list` in
 * pages of `listPageSize`.
 */
async function longRun(resumes: number, listPageSize: number) {
  const { world, runId } = await setup({ listPageSize });
  await world.runUntilIdle();
  for (let i = 0; i < resumes; i++) {
    await resumeHook(`loop-${i}`, { value: i });
    await world.runUntilIdle();
  }
  expect(eventsOf(world, 'hook_created')).toHaveLength(resumes + 1);
  expect(eventsOf(world, 'run_failed')).toHaveLength(0);
  return { world, runId };
}

/** How many events the run's first delivery leaves in the log. */
async function firstDeliveryEventCount(): Promise<number> {
  const { world } = await setup();
  await world.runUntilIdle();
  expect(eventsOf(world, 'hook_created')).toHaveLength(1);
  return workflowEventCount(world);
}

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('the event ceiling on later deliveries of a spec 9 run (%s engine)', (engine) => {
  beforeEach(() => {
    currentEngine = engine;
  });

  it('fails the run when a delivery after the first reaches the ceiling', async () => {
    // A ceiling the first delivery stays below, and the first resume reaches.
    const maxEvents = (await firstDeliveryEventCount()) + 1;
    const { world } = await setup({ maxEvents });
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);

    await resumeHook('loop-0', { value: 0 });
    await world.runUntilIdle();

    const failed = eventsOf(world, 'run_failed');
    expect(failed).toHaveLength(1);
    expect(errorCodeOf(failed[0])).toBe(RUN_ERROR_CODES.MAX_EVENTS_EXCEEDED);
    // The workflow never ran past the ceiling.
    expect(eventsOf(world, 'hook_created')).toHaveLength(1);
  });

  it('does not count sealed noops on a later delivery', async () => {
    const maxEvents = (await firstDeliveryEventCount()) + 10;
    const { world } = await setup({ maxEvents });
    await world.runUntilIdle();
    for (let i = 0; i < maxEvents; i++) {
      world.appendOutOfBand({ eventType: 'noop' } as Partial<Event>);
    }
    await resumeHook('loop-0', { value: 0 });
    await world.runUntilIdle();
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'hook_created')).toHaveLength(2);
  });

  it('keeps running against a World that reports the ceiling on run_started only', async () => {
    const maxEvents = (await firstDeliveryEventCount()) + 1;
    const { world } = await setup({ maxEvents, maxEventsOnStartOnly: true });
    await world.runUntilIdle();

    await resumeHook('loop-0', { value: 0 });
    await world.runUntilIdle();

    // Such a World gives a later delivery no ceiling to enforce.
    expect(eventsOf(world, 'run_failed')).toHaveLength(0);
    expect(eventsOf(world, 'hook_created')).toHaveLength(2);
  });

  it('fails a run already past the ceiling without reading its whole log', async () => {
    const listPageSize = 2;
    const resumes = 10;
    const { world, runId } = await longRun(resumes, listPageSize);

    // The ceiling now sits well below the log: two pages hold it.
    world.maxEvents = listPageSize * 2;
    const logSize = world.events.length;
    const listsBefore = world.listCalls.length;

    await resumeHook(`loop-${resumes}`, { value: resumes });
    await world.runUntilIdle();

    const failed = eventsOf(world, 'run_failed');
    expect(failed).toHaveLength(1);
    expect(errorCodeOf(failed[0])).toBe(RUN_ERROR_CODES.MAX_EVENTS_EXCEEDED);
    expect(eventsOf(world, 'hook_created')).toHaveLength(resumes + 1);
    // The delivery's pages covered the ceiling, not the log.
    const pagesRead = world.listCalls.length - listsBefore;
    expect(pagesRead * listPageSize).toBeLessThan(logSize);
    expect(pagesRead * listPageSize).toBeGreaterThanOrEqual(world.maxEvents);
    // The count is what the delivery read, and says so.
    expect((await runErrorOf(failed[0], runId)).message).toContain(
      'holds at least'
    );
  });

  // A legacy lazy hook resume writes its `hook_received` in setup, deduped
  // against the log. On a load stopped at the ceiling the dedupe would miss
  // one recorded past the cut, so the run fails before that write.
  it('fails a legacy lazy hook resume past the ceiling before writing or reading more', async () => {
    const listPageSize = 2;
    const resumes = 10;
    const { world, runId } = await longRun(resumes, listPageSize);
    const hookId = eventsOf(world, 'hook_created').at(-1)?.correlationId;
    const resumeId = '01J0000000000000000000RSM1';
    const payload = await dehydrateStepReturnValue(
      { value: 'legacy' },
      runId,
      undefined
    );
    // The producer already recorded this resume, past where the next load
    // stops.
    world.appendOutOfBand({
      eventType: 'hook_received',
      correlationId: hookId,
      resumeId,
      eventData: { token: `loop-${resumes}`, payload },
    } as Partial<Event>);

    world.maxEvents = listPageSize * 2;
    const logSize = world.events.length;
    const listsBefore = world.listCalls.length;
    const receivedBefore = world.creates.filter(
      (c) => c.event.eventType === 'hook_received'
    ).length;

    await world.deliver(
      world.enqueue(QUEUE, {
        runId,
        hookInput: {
          hookId,
          resumeId,
          token: `loop-${resumes}`,
          payload,
          payloadDigest: 'c'.repeat(64),
          deploymentId: 'dpl_test',
        },
      })
    );

    const failed = eventsOf(world, 'run_failed');
    expect(failed).toHaveLength(1);
    expect(errorCodeOf(failed[0])).toBe(RUN_ERROR_CODES.MAX_EVENTS_EXCEEDED);
    expect(
      world.creates.filter((c) => c.event.eventType === 'hook_received')
    ).toHaveLength(receivedBefore);
    const pagesRead = world.listCalls.length - listsBefore;
    expect(pagesRead * listPageSize).toBeLessThan(logSize);
  });
});

describe('the event ceiling on a reload in the middle of a delivery (node engine)', () => {
  beforeEach(() => {
    currentEngine = 'node';
  });

  // An incomplete skipped-slot report on the delivery's own wait_completed
  // makes it reload the log in full before consuming the write; the check
  // before each replay fails the run on what that reload holds.
  it('fails the run when the reload reaches the ceiling', async () => {
    const clock = offsetClock();
    try {
      const { world } = await setup(
        { reportIncomplete: true },
        SLEEP_LOOP_WORKFLOW
      );
      // The first delivery only: its timer is not due yet.
      const first = world.held[0];
      if (!first) throw new Error('no held message');
      await world.deliver(first);
      expect(eventsOf(world, 'wait_created')).toHaveLength(1);
      // The timer delivery's own load stays below the ceiling; its
      // wait_completed reaches it.
      world.maxEvents = workflowEventCount(world) + 1;
      const listsBefore = world.listCalls.length;

      clock.advance(2_000);
      await world.runUntilIdle();

      expect(eventsOf(world, 'wait_completed')).toHaveLength(1);
      const failed = eventsOf(world, 'run_failed');
      expect(failed).toHaveLength(1);
      expect(errorCodeOf(failed[0])).toBe(RUN_ERROR_CODES.MAX_EVENTS_EXCEEDED);
      expect(eventsOf(world, 'wait_created')).toHaveLength(1);
      // Two full loads from the start: the delivery's setup, and the reload.
      const fullLoads = world.listCalls
        .slice(listsBefore)
        .filter(
          (call) =>
            (call.pagination as { cursor?: string } | undefined)?.cursor ===
            undefined
        );
      expect(fullLoads).toHaveLength(2);
    } finally {
      clock.restore();
    }
  });
});
