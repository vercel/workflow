import type { ScenarioSpec } from '@workflow/world-sim';
import { startHookWorld } from './start-hook-helpers.ts';

const token = 'order:unadopted';

export const scenario: ScenarioSpec = {
  id: 'start-hook-owner-ends-unadopted',
  name: 'start Hook: the owner ends without ever adopting its token',
  description:
    'While the owner runs, a resume is HookReservedError. Once it has ended ' +
    'without a createHook, the same resume is HookNotFoundError: a caller ' +
    'retrying HookReservedError stops, rather than waiting forever.',
  workflow: 'unadoptedOwnerWorkflow',
  input: ['owner'],
  ...startHookWorld,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    const atStep = wf.runToEventCommitted('step_started');
    await sim.start({ caller: 'c1', hook: { token } }).outcome;
    await atStep;

    const during = await sim.resume(token, {});
    sim.check(
      'while the owner runs: HookReservedError',
      during.kind === 'reserved' && during.runId === sim.runId
    );

    const ended = sim.until({ eventType: 'run_completed' }, 'the owner ends');
    await wf.release();
    await ended;
    const after = await sim.resume(token, {});
    sim.check(
      'once it has ended: HookNotFoundError',
      after.kind === 'not-found'
    );
  },
  expect: { status: 'completed', output: 'unadopted:owner' },
};
