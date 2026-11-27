import { EntityConflictError, WorkflowWorldError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import {
  type Event,
  isChildEntityCreationEventType,
  isTerminalRunEventType,
  isTerminalWorkflowRunStatus,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import type { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  eventsOf,
  expectAcknowledged,
  registerWorkflow,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

// A run cancelled while one of its deliveries is in flight: the inline step
// the delivery runs returns into a cancelled run, its `step_completed` is
// accepted (a step may finish whatever its run's state), and the replay that
// follows creates the next step, which the World refuses. That refusal says
// the run finished, not that it failed (#5750).

let bodyEntered = withResolvers<void>();
let releaseBody = withResolvers<void>();

registerStepFunction('cmd_first', async () => {
  bodyEntered.resolve();
  await releaseBody.promise;
  return 1;
});
registerStepFunction('cmd_second', async () => 2);

const twoStepWorkflow = `const first = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("cmd_first");
  const second = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("cmd_second");
  async function workflow() {
    await first();
    await second();
    return "done";
  }${registerWorkflow()}`;

type CreateData = { eventType: string; eventData?: Record<string, unknown> };
type SeededRun = { world: AppendOnlyWorld; runId: string };

/** Whether `data` creates an entity of the run: a step (or an inline step's
 * creation-bearing first `step_started`), a hook, a wait or a rate call. */
const createsEntity = (data: CreateData) =>
  isChildEntityCreationEventType(data.eventType) ||
  (data.eventType === 'step_started' && data.eventData?.input !== undefined);

const statusOf = async ({ world, runId }: SeededRun) =>
  (await world.asWorld().runs.get(runId)).status;

const cancel = ({ world }: SeededRun) =>
  world.appendOutOfBand({ eventType: 'run_cancelled' } as Partial<Event>);

/**
 * World-local's answer to a write on a terminal run
 * (`world-local/src/storage/events-storage.ts`), which the fake World
 * otherwise answers with `RunExpiredError`: a second terminal event or a new
 * entity is a conflict.
 */
async function refuseLikeWorldLocal(
  run: SeededRun | undefined,
  data: CreateData
): Promise<void> {
  if (!run || data.eventType === 'run_cancelled') return;
  const status = await statusOf(run);
  if (!isTerminalWorkflowRunStatus(status)) return;
  if (isTerminalRunEventType(data.eventType)) {
    throw new EntityConflictError(
      `Cannot transition run from terminal state "${status}"`
    );
  }
  if (createsEntity(data)) {
    throw new EntityConflictError(
      `Cannot create new entities on run in terminal state "${status}"`
    );
  }
}

/**
 * Seeds a run of the two-step workflow on a World that refuses writes on a
 * terminal run as world-local does, and takes no batch writes, as
 * world-local does not: each write of the delivery is a single create, whose
 * refusal ends the replay. With `cancelOnOutcome`, the run is cancelled as
 * the first step's `step_completed` commits, before its answer arrives.
 */
async function setupCancellableRun(
  engine: 'node' | 'quickjs',
  { cancelOnOutcome }: { cancelOnOutcome: boolean }
) {
  let run: SeededRun | undefined;
  const setup = await setupOrchestratorRun(
    twoStepWorkflow,
    [],
    {
      noBatch: true,
      beforeCreate: (data) => refuseLikeWorldLocal(run, data),
      afterCommit: (committed) => {
        if (
          run &&
          cancelOnOutcome &&
          committed.some((event) => event.eventType === 'step_completed')
        ) {
          cancel(run);
        }
      },
    },
    engine
  );
  run = { world: setup.world, runId: setup.runId };
  return { ...setup, run };
}

/** Asserts the run ended cancelled, with no failure of the run or a step. */
async function expectCancelledOnly(run: SeededRun): Promise<void> {
  expect(await statusOf(run)).toBe('cancelled');
  for (const type of ['run_failed', 'step_retrying', 'step_failed']) {
    expect(eventsOf(run.world, type)).toEqual([]);
  }
}

beforeEach(() => {
  bodyEntered = withResolvers<void>();
  releaseBody = withResolvers<void>();
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe.each([
  'node',
  'quickjs',
] as const)('a run cancelled while its inline step runs (%s engine)', (engine) => {
  it.each([
    ['while the body runs', false],
    ['as its step_completed commits', true],
  ] as const)('is acknowledged, not failed, when the cancel lands %s', async (_when, cancelOnOutcome) => {
    const errors = vi.spyOn(runtimeLogger, 'error');
    const { world, run, start } = await setupCancellableRun(engine, {
      cancelOnOutcome,
    });

    const delivery = world.deliver(start);
    await bodyEntered.promise;
    if (!cancelOnOutcome) cancel(run);
    releaseBody.resolve();
    expectAcknowledged(world, await delivery, start);
    await world.runUntilIdle();

    expect(errors).not.toHaveBeenCalled();
    expect(eventsOf(world, 'step_completed')).toHaveLength(1);
    await expectCancelledOnly(run);
    // Delivered once: the message was not redelivered.
    expect(
      world.deliveries.filter((d) => d.messageId === start.messageId)
    ).toHaveLength(1);
  });

  it('redelivers, without failing the run, when re-reading the run fails transiently', async () => {
    const { world, run, start } = await setupCancellableRun(engine, {
      cancelOnOutcome: true,
    });
    // The first read of the run after the cancel is the one the conflict
    // makes; it fails as an unavailable World does.
    const unavailable = new WorkflowWorldError('unavailable', { status: 503 });
    let failedReads = 0;
    const flaky = world.asWorld();
    flaky.runs.get = (async (id: string) => {
      if (eventsOf(world, 'run_cancelled').length > 0 && failedReads === 0) {
        failedReads++;
        throw unavailable;
      }
      return world.asWorld().runs.get(id);
    }) as typeof flaky.runs.get;
    setWorld(flaky);

    releaseBody.resolve();
    await expect(world.deliver(start)).rejects.toBe(unavailable);
    expect(failedReads).toBe(1);
    expect(
      world.held.find((held) => held.messageId === start.messageId)
        ?.deliveryCount
    ).toBe(2);
    await world.runUntilIdle();

    await expectCancelledOnly(run);
  });
});

describe.each([
  'node',
  'quickjs',
] as const)('a conflict during replay on a running run (%s engine)', (engine) => {
  it('still fails the run', async () => {
    const errors = vi
      .spyOn(runtimeLogger, 'error')
      .mockImplementation(() => undefined);
    const { world, runId, start } = await setupOrchestratorRun(
      twoStepWorkflow,
      [],
      {
        noBatch: true,
        beforeCreate: (data) => {
          if (
            createsEntity(data) &&
            data.eventData?.stepName === 'cmd_second'
          ) {
            throw new EntityConflictError('Step already created');
          }
        },
      },
      engine
    );

    releaseBody.resolve();
    expectAcknowledged(world, await world.deliver(start), start);

    expect(eventsOf(world, 'run_failed')).toHaveLength(1);
    expect(await statusOf({ world, runId })).toBe('failed');
    expect(errors).toHaveBeenCalledWith(
      'Error while running workflow',
      expect.objectContaining({
        errorName: 'EntityConflictError',
        errorMessage: 'Step already created',
      })
    );
  });
});
