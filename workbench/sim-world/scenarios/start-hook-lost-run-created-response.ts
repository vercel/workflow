import type { ScenarioSpec } from '@workflow/world-sim';
import {
  loseResponses,
  resumeOnceAdopted,
  startHookWorld,
} from './start-hook-helpers.ts';

const token = 'order:lost-response';

export const scenario: ScenarioSpec = {
  id: 'start-hook-lost-run-created-response',
  name: 'start Hook: run_created commits and every response to it is lost',
  description:
    'The first candidate is admitted, but the client sees a transport error ' +
    'on the post and on each in-place confirmation, so start() throws ' +
    'WorkflowStartError(admission). The retry is a new candidate, refused ' +
    'naming the first: exactly one run, and the client learns it.',
  workflow: 'reservedOwnerWorkflow',
  input: [token],
  ...startHookWorld,
  script: async (sim) => {
    const lost = loseResponses(sim, {
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

const onceToken = 'order:lost-response-once';

export const confirmedInPlace: ScenarioSpec = {
  id: 'start-hook-lost-run-created-response-confirmed',
  name: 'start Hook: run_created commits, its response is lost once, and start() confirms it in place',
  description:
    'The re-post of the same candidate answers with its decision: start() ' +
    'returns the admitted run on its first attempt, with no retry.',
  workflow: 'reservedOwnerWorkflow',
  input: [onceToken],
  ...startHookWorld,
  script: async (sim) => {
    const lost = sim.fault.loseResponse({
      writer: 'caller:c1',
      eventType: 'run_created',
    });
    const answer = await sim.startUntilResolved({
      caller: 'c1',
      hook: { token: onceToken },
    });
    const first = (await lost).runId ?? '';

    const [attempts] = sim.requests().map((r) => r.attempts);
    sim.check(
      'the first attempt returned the admitted run',
      attempts.length === 1 && answer.kind === 'run' && answer.runId === first
    );
    sim.check('exactly one run', sim.world.runs().length === 1);

    const delivered = await resumeOnceAdopted(sim, onceToken, { note: 'paid' });
    sim.check(
      'the payload reaches it',
      delivered.kind === 'delivered' && delivered.runId === first
    );
  },
  expect: { status: 'completed', output: 'paid' },
};
