import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'sleep-wait-continuation-stranded',
  name: 'sleep: a pass that cannot see its own wait_created strands the timer',
  description:
    'The same wall-clock recompute as `sleep-resumeat-recomputed`, reached from ' +
    'the other side — and it costs the run rather than shifting it. ' +
    'A wait continuation is delivered with an idempotency key derived from the ' +
    'wait, and the key stays held for as long as that delivery is in flight ' +
    '(`getWaitContinuationDispatch`, and the in-flight key map in the queue). ' +
    'The delivery is supposed to consume its `wait_created`, find the wait due, ' +
    'and write `wait_completed`. ' +
    'Here the read it starts from is missing that `wait_created` — the event is ' +
    'committed, but withheld from this one read, which is the same stale-read ' +
    'precondition the rest of the book is built on. So the pass does not know ' +
    'the wait exists. It replays the body, reaches `sleep()` again, resolves the ' +
    'duration against the host wall clock a second time, and tries to create the ' +
    'wait: the store rejects it as a duplicate and the suspension writer swallows ' +
    'the conflict, which is the 409 prevention the Slack thread was counting on. ' +
    'Then it dispatches a continuation for its freshly computed deadline — under ' +
    'the same idempotency key as the delivery it is currently running inside. ' +
    'The queue dedupes it against that in-flight key and returns the existing ' +
    'message id. That message then settles. Nothing is queued, the wait stays ' +
    'open, and the run never wakes up. ' +
    'Two things worth separating. The 409 guard does protect the *log* — one ' +
    '`wait_created`, one `resumeAt`, and the log replays clean. It does not ' +
    'protect the *run*: swallowing the conflict and carrying on is what walks ' +
    'into the deduped re-dispatch. And the recompute is load-bearing, not ' +
    'incidental — it is what makes this pass believe there is a fresh deadline ' +
    'to arm at all.',
  workflow: 'sleepWithBystanderHookWorkflow',
  input: ['probe'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // Arm the window BEFORE `wait_created` appends, so the withhold binds to
    // that event: `withholdNextEvent` attaches to the next event committed by
    // any writer, and the orchestrator's own create is the next one here.
    const held = await sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    sim.withholdNextEvent(1);
    held.release();

    await wf.release();
  },
  // FAILS TODAY, and the failure is the run, not the log: outcome `stalled`,
  // with the wait still open and no continuation queued. The sim names this
  // shape a runtime bug on its own — a pending wait should always have a queued
  // continuation.
  //
  // Note what is NOT reachable from here, because it was the failure this
  // scenario was written to find. `sleep.ts` compares the `resumeAt` on a
  // `wait_completed` against the queue item's, and falls back to the freshly
  // computed wall-clock value when the pass has not consumed a `wait_created` —
  // so a pass that saw `wait_completed` without its `wait_created` would raise
  // `ReplayDivergenceError`. It cannot get there. The continuation reads the log
  // before anything writes `wait_completed`, so the pass that cannot see its
  // `wait_created` always re-creates it and is always rejected first. The 409
  // guard stands between that fallback and every path that reaches it, which is
  // why the fallback is unreachable and this stall is what happens instead.
  expect: {
    status: 'completed',
  },
};
