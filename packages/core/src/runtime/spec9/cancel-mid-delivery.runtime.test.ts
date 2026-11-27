import {
  EntityConflictError,
  RunExpiredError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
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
// follows writes the run's next entity, which the World refuses. That refusal
// says the run finished, not that it failed (#5750).

let bodyEntered = withResolvers<void>();
let releaseBody = withResolvers<void>();

registerStepFunction('cmd_first', async () => {
  bodyEntered.resolve();
  await releaseBody.promise;
  return 1;
});
registerStepFunction('cmd_second', async () => 2);

const useStep = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;

/** The inline step, then a second step: the next write is its creation. */
const twoStepWorkflow = `const first = ${useStep('cmd_first')};
  const second = ${useStep('cmd_second')};
  async function workflow() {
    await first();
    await second();
    return "done";
  }${registerWorkflow()}`;

/** The inline step, then a sleep: the next write is its `wait_created`. */
const stepThenSleepWorkflow = `const first = ${useStep('cmd_first')};
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    await first();
    await sleep("1d");
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
 * (`world-local/src/storage/events-storage.ts`; world-postgres answers the
 * same), which the fake World otherwise answers with `RunExpiredError`: a
 * second terminal event or a new entity is a conflict.
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
 * How the World refuses the replay's next write on the cancelled run:
 *
 * - `conflict`: as world-local and world-postgres do, and as world-vercel
 *   maps the backend's 409, with `EntityConflictError`. The next write is the
 *   second step's creation.
 * - `expiry`: as the fake World does by default, with `RunExpiredError`. An
 *   inline step's creation-bearing start refused that way is the step's own
 *   start refusal and never reaches the replay's catch, so the next write
 *   here is a sleep's `wait_created`, which does.
 */
type Refusal = 'conflict' | 'expiry';

/**
 * Seeds a run that refuses its next write once cancelled (see
 * {@link Refusal}), on a World that takes no batch writes, as world-local
 * does not: each write of the delivery is a single create, whose refusal ends
 * the replay. With `cancelOnOutcome`, the run is cancelled as the first
 * step's `step_completed` commits, before its answer arrives.
 */
async function setupCancellableRun(
  engine: 'node' | 'quickjs',
  refusal: Refusal,
  { cancelOnOutcome }: { cancelOnOutcome: boolean }
) {
  let run: SeededRun | undefined;
  const setup = await setupOrchestratorRun(
    refusal === 'conflict' ? twoStepWorkflow : stepThenSleepWorkflow,
    [],
    {
      noBatch: true,
      ...(refusal === 'conflict'
        ? { beforeCreate: (data) => refuseLikeWorldLocal(run, data) }
        : {}),
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

/**
 * Installs a World whose next read of the run, once the run is cancelled,
 * fails with `error`; later reads answer as before. Returns how many reads
 * failed.
 */
function failNextRunReadAfterCancel(
  { world }: SeededRun,
  error: Error
): () => number {
  let failed = 0;
  const failing = world.asWorld();
  failing.runs.get = (async (id: string) => {
    if (eventsOf(world, 'run_cancelled').length > 0 && failed === 0) {
      failed++;
      throw error;
    }
    return world.asWorld().runs.get(id);
  }) as typeof failing.runs.get;
  setWorld(failing);
  return () => failed;
}

/** Asserts the run ended cancelled, with no failure of the run or a step. */
async function expectCancelledOnly(run: SeededRun): Promise<void> {
  expect(await statusOf(run)).toBe('cancelled');
  for (const type of ['run_failed', 'step_retrying', 'step_failed']) {
    expect(eventsOf(run.world, type)).toEqual([]);
  }
}

const SKIPPED = 'Run already finished during replay, skipping';

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
  describe.each([
    'conflict',
    'expiry',
  ] as const)('whose next write the World refuses (%s)', (refusal) => {
    it.each([
      ['while the body runs', false],
      ['as its step_completed commits', true],
    ] as const)('is acknowledged, not failed, when the cancel lands %s', async (_when, cancelOnOutcome) => {
      const errors = vi.spyOn(runtimeLogger, 'error');
      const info = vi.spyOn(runtimeLogger, 'info');
      const { world, run, start } = await setupCancellableRun(engine, refusal, {
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
      if (engine === 'node' && !cancelOnOutcome) {
        // On the node engine the `step_completed` write's skipped-slot report
        // brings the cancel in, and the next pass's terminal check stops the
        // delivery before any write. Kept to pin that path, and for symmetry
        // with QuickJS, whose replay goes on to the refused write.
        expect(info).not.toHaveBeenCalledWith(SKIPPED, expect.anything());
      } else {
        expect(info).toHaveBeenCalledWith(
          SKIPPED,
          expect.objectContaining({ status: 'cancelled' })
        );
      }
    });

    it.each([
      ['expired', new RunExpiredError('run expired')],
      ['not-found', new WorkflowRunNotFoundError('wrun_gone')],
      ['not-found', new WorkflowWorldError('not found', { status: 404 })],
    ] as const)('is acknowledged when re-reading the run finds it gone (%s: %s)', async (reason, readError) => {
      const errors = vi.spyOn(runtimeLogger, 'error');
      const info = vi.spyOn(runtimeLogger, 'info');
      const { world, run, start } = await setupCancellableRun(engine, refusal, {
        cancelOnOutcome: true,
      });
      const failedReads = failNextRunReadAfterCancel(run, readError);

      releaseBody.resolve();
      expectAcknowledged(world, await world.deliver(start), start);
      await world.runUntilIdle();

      expect(failedReads()).toBe(1);
      expect(errors).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        SKIPPED,
        expect.objectContaining({ runGone: reason })
      );
      await expectCancelledOnly(run);
    });

    it('redelivers, without failing the run, when re-reading the run fails transiently', async () => {
      const { world, run, start } = await setupCancellableRun(engine, refusal, {
        cancelOnOutcome: true,
      });
      const unavailable = new WorkflowWorldError('unavailable', {
        status: 503,
      });
      const failedReads = failNextRunReadAfterCancel(run, unavailable);

      releaseBody.resolve();
      await expect(world.deliver(start)).rejects.toBe(unavailable);
      expect(failedReads()).toBe(1);
      expect(
        world.held.find((held) => held.messageId === start.messageId)
          ?.deliveryCount
      ).toBe(2);
      await world.runUntilIdle();

      await expectCancelledOnly(run);
    });
  });
});

describe.each([
  'node',
  'quickjs',
] as const)('a refusal during replay on a running run (%s engine)', (engine) => {
  it.each([
    [
      'a conflict',
      twoStepWorkflow,
      (data: CreateData) =>
        createsEntity(data) && data.eventData?.stepName === 'cmd_second',
      new EntityConflictError('Step already created'),
    ],
    [
      'an expiry',
      stepThenSleepWorkflow,
      (data: CreateData) => data.eventType === 'wait_created',
      new RunExpiredError('Gone for another reason'),
    ],
  ] as const)('still fails the run on %s', async (_what, code, refuses, refusal) => {
    const errors = vi
      .spyOn(runtimeLogger, 'error')
      .mockImplementation(() => undefined);
    const { world, runId, start } = await setupOrchestratorRun(
      code,
      [],
      {
        noBatch: true,
        beforeCreate: (data) => {
          if (refuses(data)) throw refusal;
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
        errorName: refusal.name,
        errorMessage: refusal.message,
      })
    );
  });
});
