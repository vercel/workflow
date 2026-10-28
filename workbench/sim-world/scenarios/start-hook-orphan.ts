import type { ScenarioSpec } from '@workflow/world-sim';
import { messageFor, startHookWorld } from './start-hook-helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const ACCEPTED = 'start-hook:accepted';

/**
 * An orphan: a candidate accepted and never created. The client dies between
 * its decision and its run row (the cross-region window), and its queued copy
 * does not come back until late. Inside its 24h window it holds the token;
 * after it, a contender takes the token and fences it.
 *
 * - `late`: the queued copy comes back after the window, and is refused.
 * - `in-flight`: the queued copy comes back just inside the window and
 *   stalls between its age check and its run row. A contender fences the
 *   orphan meanwhile, and the stalled write is refused by the fence.
 */
function orphan(variant: 'late' | 'in-flight'): ScenarioSpec {
  const token = `order:orphan:${variant}`;
  return {
    id: `start-hook-orphan-${variant}`,
    name:
      variant === 'late'
        ? 'start Hook: an orphaned candidate holds its token for 24h, then loses it'
        : 'start Hook: the fence refuses an orphan write already past its age check',
    description:
      variant === 'late'
        ? "Inside the window a contender is refused naming the orphan; after it a contender is admitted, and the orphan's late queued copy is refused."
        : 'The redelivery passes the 24h age check a second early and stalls; the window closes, a contender fences the orphan, and the stalled write is refused.',
    workflow: 'unadoptedOwnerWorkflow',
    input: ['contender'],
    ...startHookWorld,
    script: async (sim) => {
      const pause = sim.pauseDeliveries();
      const died = sim.fault.die(
        { writer: 'caller:c1', phase: 'inside', checkpoint: ACCEPTED },
        'c1 dies between its decision and its run'
      );
      sim.start({ caller: 'c1', hook: { token } });
      const orphanId = (await died).runId ?? '';
      // The queue holds the dead candidate's copy back (redelivery backoff).
      sim.delayQueued(
        messageFor(orphanId),
        variant === 'late' ? DAY + 60_000 : DAY - 1_000
      );

      const early = await sim.start({ caller: 'c2', hook: { token } }).outcome;
      sim.check(
        'inside the window, a contender is refused naming the orphan',
        early.kind === 'conflict' && early.conflictingRunId === orphanId
      );
      const lookup = await sim.resume(token, {});
      sim.check(
        'and a resume is HookReservedError naming it',
        lookup.kind === 'reserved' && lookup.runId === orphanId
      );

      if (variant === 'in-flight') {
        const stalled = sim.park(
          { runId: orphanId, phase: 'inside', checkpoint: ACCEPTED },
          "the orphan's redelivery stalls before its run row"
        );
        pause();
        const held = await stalled;
        sim.advanceTime(2_000);
        const contender = await sim.start({ caller: 'c3', hook: { token } })
          .outcome;
        sim.check(
          'after the window, a contender is admitted',
          contender.kind === 'run'
        );
        const refused = sim.until(
          { runId: orphanId, eventType: 'run_started', failed: true },
          'the stalled orphan write is refused'
        );
        held.release();
        const answer = await refused;
        sim.check(
          'by the fence',
          (answer.error as { code?: string } | undefined)?.code ===
            'START_HOOK_ADMISSION_REJECTED' &&
            String((answer.error as Error).message).includes('fenced')
        );
      } else {
        sim.advanceTime(DAY + 1);
        const contender = await sim.start({ caller: 'c3', hook: { token } })
          .outcome;
        sim.check(
          'after the window, a contender is admitted',
          contender.kind === 'run'
        );
        const late = sim.until(
          { runId: orphanId, eventType: 'run_started', failed: true },
          "the orphan's late queued copy is refused"
        );
        pause();
        const answer = await late;
        sim.check(
          'as permanently rejected',
          (answer.error as { code?: string } | undefined)?.code ===
            'START_HOOK_ADMISSION_REJECTED'
        );
      }
      sim.check(
        'the orphan never became a run',
        sim.world.run(orphanId) === undefined
      );
      // What the contract gives c2: a refusal naming an owner that never
      // became a run. Its only way to learn more is to resume the token, which
      // now answers not-found (the orphan is fenced), and starting again is
      // what would have admitted it.
      const named = await sim.resume(token, {});
      sim.check(
        "c2's named owner never existed; resuming the token now reaches the contender, not it",
        named.kind !== 'delivered' || named.runId !== orphanId
      );
    },
    expect: { status: 'completed', output: 'unadopted:contender' },
  };
}

export const late = orphan('late');
export const inFlight = orphan('in-flight');
