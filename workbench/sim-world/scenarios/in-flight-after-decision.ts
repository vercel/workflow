import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'in-flight-after-decision',
  name: 'in-flight: A commits AFTER the decision — no guard can see it',
  description:
    'The residual, and the reason the append-tail fence noted in ' +
    "workflow-server's `lib/ulid.ts` is still open. Same log order " +
    '(A=hook_received, B=wait_completed) and the same decision on a log ' +
    'missing the hook, but this time the receiver commits after C rather than ' +
    'before it: visibility is (B, C, A). Both halves of the fence are armed ' +
    'and neither fires, and neither could — a check is part of the write it ' +
    'guards, evaluated against the log as it stands at that instant, so it can ' +
    'only compare against events that already exist. At every point where a ' +
    'write of this run is checked, the hook does not exist. Then it appears, ' +
    'behind everything, and the log says the hook beat a timeout the run ' +
    'resolved the other way. ' +
    'Getting there needs the run to be quiescent when the hook lands, because ' +
    'the count guard catches this same hole on whatever the run writes NEXT — ' +
    'late, after the wrong branch has already run, which is a different and ' +
    'much worse outcome than catching it in time. So the hook is released ' +
    'while the orchestrator is held inside `wait_created`, the last write of ' +
    'the delivery: the run then sleeps, and the next delivery cold-starts on a ' +
    'log it can no longer follow. Detectability is inversely related to how ' +
    'late the write commits, which is the opposite of the intuition that a ' +
    'slower write is more dangerous the longer it takes. ' +
    'This is the one an append-only log closes outright, and it closes it by ' +
    'construction rather than by catching anything: the append-tail fence is ' +
    'unnecessary when the tail is the only place a write can land. The late ' +
    'hook sorts last, the next delivery replays a log it can follow, and no ' +
    'guard has to fire.',
  workflow: 'lateAppendForkWorkflow',
  input: ['doc-31'],
  preconditionGuard: true,
  countGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventProduced('wait_completed');
    const hook = await sim.beginHookDelivery('count:doc-31', {
      approved: true,
    });

    // Let the delivery play out on the branch the visible log implied, and
    // catch it inside the `wait_created` that ends it. That write is already
    // durable; nothing of this run will be checked again until the timer
    // fires.
    await wf.runToEventCommitted('wait_created');
    sim.check(
      'nothing was fenced — every write so far passed both guards',
      sim.world.rejections().length === 0
    );

    await hook.commit();
    await wf.release();
  },
  // FAILS TODAY, and worse than the others: the corruption is not merely
  // latent. The next delivery replays a log that says the hook won, finds
  // `settle` where `recoverFirst` belongs, and gives up after its recovery
  // replays — so the run dies rather than completing wrongly. Of the six reds,
  // this is the one with no known fix: both guards are on, and closing it needs
  // the append-tail fence that does not exist yet.
  //
  // "Completes" is the whole assertion, and here it is not a formality: this is
  // the one red where the run does not reach a terminal success at all. Under
  // the flag it does, and the log replays — same sentence, other answer.
  expect: {
    status: 'completed',
  },
};
