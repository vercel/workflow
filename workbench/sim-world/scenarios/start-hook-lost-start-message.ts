import type { ScenarioSpec } from '@workflow/world-sim';
import { messageFor, startHookWorld } from './start-hook-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
/** `START_HOOK_HOLDER_WAKE_AFTER_MS` in `@workflow/core`. */
const WAKE_AFTER = 60_000;
const token = 'order:lost-start-message';

export const scenario: ScenarioSpec = {
  id: 'start-hook-lost-start-message',
  name: "start Hook: the owner's start message is lost, and a duplicate start re-publishes it",
  description:
    'The owner is admitted but the queue loses its start message, so nothing ' +
    'will ever run it and it holds its token while pending. A duplicate ' +
    'refused within a minute of its creation leaves it alone; two refused ' +
    'past that publish one message for it between them. The owner runs, ' +
    'ends, and releases the token once its retention passes.',
  workflow: 'unadoptedOwnerWorkflow',
  input: ['owner'],
  ...startHookWorld,
  script: async (sim) => {
    const pause = sim.pauseDeliveries();
    const first = await sim.start({ caller: 'c1', hook: { token } }).outcome;
    const owner = first.kind === 'run' ? first.runId : '';
    sim.check(
      "the queue loses the admitted owner's start message",
      first.kind === 'run' && sim.dropQueued(messageFor(owner))
    );
    const queuedForOwner = () =>
      sim.world.pendingMessages().filter((m) => m.runId === owner).length;

    sim.advanceTime(WAKE_AFTER / 2);
    const early = await sim.start({ caller: 'c2', hook: { token } }).outcome;
    sim.check(
      'a duplicate inside a minute is refused naming the pending owner',
      early.kind === 'conflict' && early.conflictingRunId === owner
    );
    sim.check(
      'and wakes nothing: the owner may still be starting',
      queuedForOwner() === 0
    );

    sim.advanceTime(WAKE_AFTER / 2 + 1_000);
    const late = await Promise.all([
      sim.start({ caller: 'c3', hook: { token } }).outcome,
      sim.start({ caller: 'c4', hook: { token } }).outcome,
    ]);
    sim.check(
      'duplicates past a minute are refused naming it too',
      late.every((o) => o.kind === 'conflict' && o.conflictingRunId === owner)
    );
    sim.check(
      'and re-publish its start message, once between them',
      queuedForOwner() === 1
    );

    const ended = sim.until(
      { eventType: 'run_completed', runId: owner },
      'the owner runs and ends'
    );
    pause();
    await ended;

    const hold = sim.pauseDeliveries();
    sim.advanceTime(DAY);
    const next = await sim.start({
      caller: 'c5',
      hook: { token },
      input: ['next'],
    }).outcome;
    sim.check(
      "once the owner's retention passes, the token is free",
      next.kind === 'run'
    );
    hold();
  },
  expect: { status: 'completed', output: 'unadopted:owner' },
};
