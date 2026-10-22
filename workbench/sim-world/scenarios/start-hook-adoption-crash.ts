import type { ScenarioSpec } from '@workflow/world-sim';
import { resumeOnceAdopted, startHookWorld } from './start-hook-helpers.ts';

/**
 * The body's `createHook()` adopting the reservation is interrupted: the
 * delivery dies either before the `hook_created` reaches the World, or just
 * after it commits. The redelivery adopts once, and the payload is delivered
 * once.
 */
function adoptionCrash(when: 'before' | 'after'): ScenarioSpec {
  const token = `order:adoption-crash:${when}`;
  return {
    id:
      when === 'after'
        ? 'start-hook-adoption-crash'
        : 'start-hook-adoption-crash-before-commit',
    name:
      when === 'after'
        ? "start Hook: the owner's delivery dies just after its adopting hook_created commits"
        : "start Hook: the owner's delivery dies just before its adopting hook_created",
    description:
      when === 'after'
        ? 'The adoption is durable but the delivery never learns it. The ' +
          'replay finds it in the log: one hook_created, one hook_received.'
        : 'Nothing was adopted. Until the redelivery adopts, resumes are ' +
          'HookReservedError; then one hook_created, one hook_received.',
    workflow: 'reservedOwnerWorkflow',
    input: [token],
    ...startHookWorld,
    script: async (sim) => {
      const died = sim.fault.die(
        { eventType: 'hook_created', token, phase: when },
        `the owner's delivery dies ${when} its hook_created`
      );
      await sim.start({ caller: 'c1', hook: { token } }).outcome;
      await died;
      const finished = sim.until(
        { eventType: 'run_completed' },
        'the owner finishes'
      );
      const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
      sim.check('the payload is delivered', delivered.kind === 'delivered');
      await finished;
      const log = sim.world.events(sim.runId);
      const count = (type: string) =>
        log.filter((e) => e.eventType === type).length;
      sim.check('adopted once', count('hook_created') === 1);
      sim.check('delivered once', count('hook_received') === 1);
    },
    expect: { status: 'completed', output: 'paid' },
  };
}

export const afterCommit = adoptionCrash('after');
export const beforeCommit = adoptionCrash('before');
