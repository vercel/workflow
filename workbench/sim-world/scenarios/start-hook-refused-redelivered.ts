import type { ScenarioSpec } from '@workflow/world-sim';
import {
  fenced,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

const token = 'order:refused-redelivered';

export const scenario: ScenarioSpec = {
  id: 'start-hook-refused-redelivered',
  name: "start Hook: a refused candidate's delivery dies after its refusal and is redelivered",
  description:
    "The duplicate's queued copy is refused, and its delivery dies before " +
    'acking. The queue redelivers it (attempt 2); the World replays the same ' +
    'refusal naming the same owner, and this time the delivery is acked.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const first = await sim.start({ caller: 'owner', hook: { token } }).outcome;
    const owner = first.kind === 'run' ? first.runId : '';

    const dup = sim.writer.caller('dup');
    const beforeCreate = dup.runToEventProduced('run_created');
    const crash = sim.fault.die(
      { eventType: 'run_started', failed: true },
      "the duplicate's delivery dies after its refusal"
    );
    const call = sim.start({ caller: 'dup', hook: { token } });
    const candidate = (await beforeCreate).ctx.args[0] as string;
    await crash;

    const again = await sim.until(
      { eventType: 'run_started', runId: candidate },
      'the redelivery decides again'
    );
    sim.check(
      'the redelivery is refused naming the same owner',
      (again.error as { conflictingRunId?: string } | undefined)
        ?.conflictingRunId === owner
    );
    sim.check(
      'two deliveries of the duplicate were refused',
      sim.world
        .rejections()
        .filter(
          (r) =>
            r.eventType === 'run_started' && r.errorName === 'HookConflictError'
        ).length === 2
    );

    await dup.release();
    const outcome = await call.outcome;
    sim.check(
      'the direct write is refused naming the owner',
      outcome.kind === 'conflict' && outcome.conflictingRunId === owner
    );
    await resumeOnceAdopted(sim, token, { note: 'paid' });
  },
  expect: { status: 'completed', output: 'paid' },
};

export const fencedScenario = fenced(scenario);
