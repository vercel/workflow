import type { ScenarioSpec } from '@workflow/world-sim';
import { resumeOnceAdopted, startHookWorld } from './start-hook-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Eve's handoff. The source owns the token through its start Hook and adopts
 * it; a successor force-claims the adopted Hook; the source stays parked
 * (it does not end). The reservation moves with the Hook, retention
 * included, so the token follows the successor: a duplicate is refused
 * naming the successor, still refused once the successor has ended (the
 * source's 24h default retention carried over), and admitted once that
 * passes, with the source still parked.
 *
 * The crash variant kills the successor's delivery just after its forced
 * `hook_created` commits, before the runtime wakes the source.
 */
function handoff(crash: boolean): ScenarioSpec {
  const token = `agent:handoff${crash ? ':crash' : ''}`;
  return {
    id: crash
      ? 'start-hook-force-claim-handoff-crash'
      : 'start-hook-force-claim-handoff',
    name: crash
      ? "start Hook: force-claim handoff, the successor's delivery dying mid-handoff"
      : 'start Hook: force-claim handoff of an adopted reservation (Eve)',
    description: crash
      ? 'The forced hook_created commits and its delivery dies before waking ' +
        'the source. The redelivery republishes the wake from the log, and ' +
        'the handoff completes as if nothing happened.'
      : 'The token, its reservation and its retention follow the forced Hook ' +
        'to the successor, so the parked source cannot pin it.',
    workflow: 'handoffSourceWorkflow',
    input: [token],
    ...startHookWorld,
    script: async (sim) => {
      const adopted = sim.until(
        { eventType: 'hook_created', token },
        'the source adopts'
      );
      const source = await sim.start({ caller: 'source', hook: { token } })
        .outcome;
      const sourceId = source.kind === 'run' ? source.runId : '';
      await adopted;

      const killed = crash
        ? sim.fault.die(
            {
              eventType: 'hook_created',
              token,
              where: (ctx) => ctx.runId !== sourceId,
            },
            "the successor's delivery dies after its forced hook_created"
          )
        : undefined;
      const parked = sim.until(
        { eventType: 'hook_created', token: `${token}:release` },
        'the source parks'
      );
      const successor = await sim.start({
        caller: 'successor',
        workflow: 'handoffSuccessorWorkflow',
        input: [token],
      }).outcome;
      const successorId = successor.kind === 'run' ? successor.runId : '';
      await killed;
      await parked;

      const busy = await sim.start({ caller: 'dup', hook: { token } }).outcome;
      sim.check(
        'a duplicate is refused naming the successor',
        busy.kind === 'conflict' && busy.conflictingRunId === successorId
      );

      const successorDone = sim.until(
        { eventType: 'run_completed', runId: successorId },
        'the successor ends'
      );
      const delivered = await resumeOnceAdopted(sim, token, { note: 'handed' });
      sim.check(
        'the payload reaches the successor',
        delivered.kind === 'delivered' && delivered.runId === successorId
      );
      await successorDone;

      const pause = sim.pauseDeliveries();
      const retained = await sim.start({
        caller: 'dup/2',
        request: 'dup',
        hook: { token },
      }).outcome;
      sim.check(
        "after the successor ends, the source's retention still holds the token for it",
        retained.kind === 'conflict' &&
          retained.conflictingRunId === successorId
      );
      sim.advanceTime(DAY);
      const next = await sim.start({
        caller: 'next',
        workflow: 'unadoptedOwnerWorkflow',
        input: ['next'],
        hook: { token },
      }).outcome;
      sim.check(
        'once the retention passes, a new run is admitted',
        next.kind === 'run'
      );
      sim.check(
        'while the source is still parked',
        sim.world.run(sourceId)?.status === 'running'
      );
      pause();

      await resumeOnceAdopted(sim, `${token}:release`, { note: 'done' });
    },
    expect: { status: 'completed', output: 'source:handed-off' },
  };
}

export const scenario = handoff(false);
export const crashScenario = handoff(true);
