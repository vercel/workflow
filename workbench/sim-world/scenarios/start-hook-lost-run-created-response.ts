import type { ScenarioSpec } from '@workflow/world-sim';
import { resumeOnceAdopted, startHookWorld } from './start-hook-helpers.ts';

const token = 'order:lost-response';

export const scenario: ScenarioSpec = {
  id: 'start-hook-lost-run-created-response',
  name: 'start Hook: run_created commits and its response is lost',
  description:
    'The first candidate is admitted, but the client sees a transport error, ' +
    'so start() throws WorkflowStartError(admission). The retry is a new ' +
    'candidate, refused naming the first: exactly one run, and the client ' +
    'learns it.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const lost = sim.fault.loseResponse({
      writer: 'caller:c1',
      eventType: 'run_created',
    });
    const answer = await sim.startUntilResolved({
      caller: 'c1',
      hook: { token },
    });
    const first = (await lost).runId ?? '';

    const [attempts] = sim.requests().map((r) => r.attempts);
    sim.check(
      'the first attempt was uncertain',
      attempts[0]?.outcome?.kind === 'uncertain' &&
        attempts[0].outcome.stage === 'admission'
    );
    sim.check(
      'the retry is refused naming the first candidate',
      answer.kind === 'conflict' && answer.conflictingRunId === first
    );
    sim.check('exactly one run', sim.world.runs().length === 1);

    const delivered = await resumeOnceAdopted(sim, token, { note: 'paid' });
    sim.check(
      'the payload reaches the first candidate',
      delivered.kind === 'delivered' && delivered.runId === first
    );
  },
  expect: { status: 'completed', output: 'paid' },
};
