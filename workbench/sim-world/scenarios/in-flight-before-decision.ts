import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-before-decision',
  name: 'in-flight: A commits BEFORE the decision is written — count guard off',
  description:
    'Log order is (A=hook_received, B=wait_completed); visibility is ' +
    '(B, A, C). The webhook receiver has entered its handler and minted the ' +
    "hook's event id, so position A is spoken for, but the write has not " +
    'landed. The orchestrator then commits the timeout at B — behind a ' +
    'position it cannot see — reads a log that genuinely does not contain the ' +
    'hook, and takes the settle branch. Nothing is withheld from any read. ' +
    'The receiver commits while the orchestrator is held at the produced ' +
    'point of C, so by the time C is checked the hole has closed and the log ' +
    'holds an event the writer never loaded. The watermark guard is on and ' +
    'passes anyway, by construction: the marker moves to the ULID time of the ' +
    "hook, which sorts at or below the writer's own snapshot, so " +
    '`stateUpdatedAt < marker` is false. It corrupts — the same corruption as ' +
    'the doc-23 pair, reached without a stale read. ' +
    'Under an append-only log there is no position to be spoken for: the hook ' +
    'commits after the timeout and therefore sorts after it, the log says the ' +
    'timeout won, and the settle branch the run took is the one the log ' +
    'describes. Same tempo, same expectation, no corruption. Which branch the ' +
    'run ends on is decided by what its reads returned, and what a read ' +
    'returns is the one thing the flag changes — so the branch is reported, ' +
    'not asserted. What is asserted holds in both worlds: the run completes, ' +
    'and the log it wrote replays back into the run that wrote it.',
  workflow: 'stepCountForkWorkflow',
  input: ['doc-29'],
  preconditionGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // Stop the orchestrator before it submits the timeout, so the receiver
    // gets the earlier position. `produced` is the pre-submit point: nothing
    // has been minted for `wait_completed` yet.
    await wf.runToEventProduced('wait_completed');

    const hook = await sim.beginHookDelivery('count:doc-29', {
      approved: true,
    });
    // The condition is the same in both worlds — the hook is not in the log —
    // but what that *means* is not, and the trace should not claim otherwise.
    // Mint-ordered, the reserved position is binding and the hook already owns
    // a slot ahead of everything the orchestrator is about to write; under an
    // append-only log the reservation decides nothing, and the hook is simply
    // absent until it lands.
    sim.check(
      sim.appendOnlyLog
        ? 'the hook has not landed; where it lands is not decided yet'
        : 'the hook owns a log position but is nowhere in the log',
      sim.world.events().every((e) => e.eventType !== 'hook_received')
    );

    // B commits behind A, then the orchestrator decides the fork on a log
    // that has a hole in it. Hold it before that decision is submitted. The
    // claim for a branch step is one `events.create` carrying `step_started`
    // — the `step_created` ahead of it is appended by the same write — so
    // `step_started` is the call point the decision passes through.
    const decision = await wf.runToEventProduced('step_started');
    sim.check(
      'the live pass decided the fork without the hook',
      JSON.stringify(decision.ctx.request?.eventData).includes('settle')
    );

    // A lands, behind the snapshot C was decided on.
    await hook.commit();
    await wf.release();
  },
  // FAILS TODAY, like the stale-read scenarios above, and needs no stale read
  // to do it. Note what is *not* here: the settle/recover branch. The run
  // settles in both worlds — that part is not the bug. The bug is that
  // mint-ordered, the log it left behind says the hook came first, so a cold
  // replay of that log takes `recoverFirst` and diverges from the run that
  // wrote it. That divergence is the failure, it is what `verifyReplay`
  // catches, and it is stated the same way in both worlds. The fix is known
  // and one flag away — see the scenario below, this one with the count guard
  // on and green.
  expect: {
    status: 'completed',
  },
};
