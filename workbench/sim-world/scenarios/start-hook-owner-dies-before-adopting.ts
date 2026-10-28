import type { ScenarioSpec } from '@workflow/world-sim';
import { resumeOnceAdopted, startHookWorld } from './start-hook-helpers.ts';

const token = 'order:owner-dies';

export const scenario: ScenarioSpec = {
  id: 'start-hook-owner-dies-before-adopting',
  name: "start Hook: the owner's first delivery dies before it adopts the token",
  description:
    'The owner is admitted and dies before its createHook. A caller resuming ' +
    'the token gets HookReservedError naming the owner, not HookNotFoundError, ' +
    'and keeps retrying; the redelivery adopts and the payload is delivered.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const died = sim.fault.die(
      { eventType: 'step_completed' },
      "the owner's delivery dies after its first step, before it adopts"
    );
    const started = await sim.start({ caller: 'c1', hook: { token } }).outcome;
    const owner = started.kind === 'run' ? started.runId : '';
    await died;

    const early = await sim.resume(token, { note: 'early' });
    sim.check(
      'a resume before adoption is HookReservedError naming the owner',
      early.kind === 'reserved' && early.runId === owner
    );
    const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
    sim.check(
      'it is delivered once the redelivery adopts',
      delivered.kind === 'delivered' && delivered.runId === owner
    );
  },
  expect: { status: 'completed', output: 'paid' },
};
