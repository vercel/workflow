import type { ScenarioSpec } from '@workflow/world-sim';
import {
  ownerOf,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

/**
 * The client dies after its enqueue commits and before its `run_created`, so
 * its candidate exists only as a queue message. Its restart retries with the
 * same token, as a new candidate, and the two race.
 */
function startDiesAfterEnqueue(
  order: 'retry-wins' | 'queued-wins'
): ScenarioSpec {
  const token = `order:dies-after-enqueue:${order}`;
  return {
    id: `start-hook-start-dies-after-enqueue-${order}`,
    name:
      order === 'retry-wins'
        ? "start Hook: start() dies after its enqueue, and its retry is decided before the old candidate's queued copy"
        : "start Hook: start() dies after its enqueue, and the old candidate's queued copy is decided before the retry",
    description:
      'The first candidate is only a queue message. ' +
      (order === 'retry-wins'
        ? 'The retry takes the token; the old queued copy is refused naming it and acked.'
        : 'Its queued copy admits it; the retry is refused naming the old candidate, so the client still learns its owner.'),
    workflow: 'reservedOwnerWorkflow',
    input: [token],
    ...startHookWorld,
    script: async (sim) => {
      const died = sim.fault.die(
        { writer: 'caller:c1', call: 'queue' },
        'c1 dies after its enqueue commits'
      );
      sim.start({ caller: 'c1', hook: { token } });
      const old = (await died).message?.runId ?? '';

      if (order === 'queued-wins') {
        await sim.until(
          { eventType: 'run_started', runId: old, failed: false },
          'the old queued copy admits its candidate'
        );
      }
      const retry = await sim.start({ caller: 'c1/2', hook: { token } })
        .outcome;
      const owner = ownerOf(retry);

      if (order === 'retry-wins') {
        sim.check('the retry is admitted', retry.kind === 'run');
        await sim.until(
          { eventType: 'run_started', runId: old, failed: true },
          'the old queued copy is refused'
        );
        sim.check(
          'the old candidate never became a run',
          sim.world.run(old) === undefined
        );
      } else {
        sim.check(
          'the retry is refused naming the old candidate',
          retry.kind === 'conflict' && owner === old
        );
      }
      sim.check('exactly one run', sim.world.runs().length === 1);

      const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
      sim.check(
        'the payload reaches the owner',
        delivered.kind === 'delivered' && delivered.runId === owner
      );
    },
    expect: { status: 'completed', output: 'paid' },
  };
}

export const retryWins = startDiesAfterEnqueue('retry-wins');
export const queuedWins = startDiesAfterEnqueue('queued-wins');
