import type { CallContext, ScenarioSpec } from '@workflow/world-sim';

/**
 * The instant a pass asked to resume at, read out of the `wait_created` write
 * it is holding — before the write commits, so a rejected pass is readable too.
 */
const requestedResumeAtMs = (ctx: CallContext): number => {
  const request = ctx.request;
  if (request?.eventType !== 'wait_created') {
    throw new Error(
      `expected a held wait_created create, got ${String(request?.eventType)}`
    );
  }
  return new Date(request.eventData.resumeAt).getTime();
};

/**
 * How far the host clock moves before the body is replayed. A fresh clock read
 * on the replay would push the deadline out by exactly this much, so it is the
 * size of the error this scenario is looking for.
 */
const REPLAY_GAP_MS = 90_000;

export const scenario: ScenarioSpec = {
  id: 'sleep-replay-inherits-resumeat',
  name: 'sleep: a replay over a committed `wait_created` does not sleep again',
  description:
    'The companion to `sleep-resumeat-recomputed`, and the bound on it. That ' +
    'scenario shows a pass resolving `sleep()` against a moved clock; the ' +
    'obvious worry is that this happens on *every* replay, so a run would ' +
    'restart its sleep each time the body is re-executed and a long-running ' +
    'workflow could never get past one. It does not, and the reason is worth ' +
    'pinning down. ' +
    'The fresh read happens — the body reaches `sleep()` on the replay and ' +
    '`parseDurationToDate` reads the host clock again, because nothing in ' +
    '`createSleep` consults the log first. But the value is then thrown away: ' +
    'the wait consumer, on consuming the logged `wait_created`, overwrites its ' +
    "queue item's `resumeAt` with the event's, and sets `hasCreatedEvent`. So " +
    'the suspension handler neither re-writes the wait nor computes its ' +
    'continuation delay from the fresh read — it counts down to the instant ' +
    'the log already committed. ' +
    'That overwrite is the whole safety property, and it is load-bearing in a ' +
    'second way: the divergence guard in the wait consumer compares the ' +
    "`wait_completed` event's `resumeAt` against the queue item's, so if the " +
    'fresh read ever survived to that point the run would fail rather than ' +
    'silently sleep twice. The guard passing is the evidence the overwrite ' +
    'happened. ' +
    'The drift in the sibling scenario is therefore narrower than the Slack ' +
    'thread implies: it is not "every replay re-reads the clock", it is "a pass ' +
    'that reaches `sleep()` without a visible `wait_created` re-reads the ' +
    'clock" — the first pass, or a pass whose predecessor\'s write never landed.',
  workflow: 'sleepWithBystanderHookWorkflow',
  input: ['probe'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // Pass A, uncontested: let the wait land the way it normally would, and
    // record the deadline it committed.
    const passA = await sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    const originalResumeAt = requestedResumeAtMs(passA.ctx);
    sim.note(
      `pass A resolved 30m against host clock ` +
        `${new Date(sim.world.nowMs()).toISOString()}, committing ` +
        `${new Date(originalResumeAt).toISOString()}`
    );
    passA.release();

    // The run is now parked on a thirty-minute wait. Arm the watch for that
    // wait firing while the world is still quiet — the same rule as the sibling
    // scenario: arm before the thing that triggers it, or wait forever.
    const atWaitCompleted = sim.park({
      call: 'events.create',
      eventType: 'wait_completed',
      phase: 'before',
    });

    // Move the host clock, then force a second full pass over the body while
    // the wait is still open. The bystander hook is the trigger: nobody awaits
    // it, so its delivery replays the body from the top without changing which
    // branch runs. The body reaches the same `sleep()` and reads a clock that
    // has moved by REPLAY_GAP_MS.
    sim.advanceTime(REPLAY_GAP_MS);
    await sim.deliverHook('bystander:probe', { ping: true });
    sim.note(
      `replayed the body ${REPLAY_GAP_MS}ms later; a surviving fresh read ` +
        `would have moved the deadline to ` +
        `${new Date(originalResumeAt + REPLAY_GAP_MS).toISOString()}`
    );

    const waitsCreated = sim.world
      .events()
      .filter((event) => event.eventType === 'wait_created');
    sim.check(
      'the replay reused the committed wait rather than writing a second one',
      waitsCreated.length === 1
    );
    sim.check(
      'the committed resumeAt is still the one pass A asked for',
      waitsCreated.length === 1 &&
        new Date(waitsCreated[0].eventData.resumeAt).getTime() ===
          originalResumeAt
    );

    // The decisive one: when does the wait actually fire? The continuation was
    // scheduled by pass A for `originalResumeAt`. If the replay's fresh read had
    // escaped into the deadline, this lands a full replay gap late.
    const fired = await atWaitCompleted;
    const firedAt = sim.world.nowMs();
    sim.note(
      `the wait fired at ${new Date(firedAt).toISOString()}, ` +
        `${firedAt - originalResumeAt}ms after the committed deadline`
    );
    sim.check(
      'the wait fired at the instant pass A asked for, not a replay gap later',
      firedAt >= originalResumeAt && firedAt - originalResumeAt < 1_000
    );

    fired.release();
    await wf.release();
  },
  // PASSES, and it is meant to. This scenario is the control: it is the reason
  // the sibling scenario's failure is a bounded drift and not a workflow that
  // can never finish a sleep. If this one ever goes red, a replay has started
  // extending its own deadline, which is the far worse bug.
  expect: {
    status: 'completed',
    output: 'finalized:prepared:probe',
  },
};
