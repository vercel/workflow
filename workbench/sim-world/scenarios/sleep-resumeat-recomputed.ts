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
 * How long the world sits between the two passes. Any positive value shows the
 * drift; this one is chosen to stay under the runtime's 240s replay budget, so
 * the restart is the in-process one a 412 triggers and not a queue redelivery
 * after a replay timeout. Same mechanism either way, one less moving part.
 */
const RETRY_GAP_MS = 90_000;

export const scenario: ScenarioSpec = {
  id: 'sleep-resumeat-recomputed',
  name: 'sleep: a retried pass resolves the same `sleep()` against a later clock',
  description:
    '`sleep(param)` converts a duration to an instant by reading the host wall ' +
    'clock — `parseDurationToDate` in `@workflow/utils` is called from ' +
    '`createSleep`, which is a host closure installed on the VM global, so it ' +
    "reads real time and not the VM's deterministic clock. The conversion " +
    'happens where the workflow body reaches the `sleep()` call, so every pass ' +
    'that gets there without having consumed a `wait_created` for it resolves ' +
    'the duration afresh. Nothing pins the passes to each other. ' +
    'This scripts the retry the Slack thread describes, with the clock moved ' +
    'between the attempts. The orchestrator is held inside its `wait_created` ' +
    'write; a hook payload commits behind it, so the held write is working from ' +
    'a snapshot that no longer matches the log; the fence rejects it and the ' +
    'runtime restarts the replay from a corrected log. The restarted pass runs ' +
    'the body again, reaches the same `sleep()`, and reads a clock that has ' +
    "moved — and *its* value is the one that commits, because the first pass's " +
    'never landed. ' +
    'The hook is a bystander: nobody awaits it, so delivering it changes what ' +
    'is in the log without changing which branch runs. It is there to make the ' +
    'held write stale, nothing else. ' +
    'What the drift costs is the whole point: the committed `resumeAt` is later ' +
    'than the one the workflow asked for by exactly however long the retry ' +
    'took. A `sleep("30m")` behind a 30-minute outage resumes an hour in, not ' +
    'thirty minutes in. The duration is honoured from whenever the last attempt ' +
    'happened to run rather than from when the workflow asked.',
  workflow: 'sleepWithBystanderHookWorkflow',
  input: ['probe'],
  // The fence is the trigger: rejecting the held write is what forces a second
  // pass over the body, and a second reading of the clock.
  preconditionGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // Catch the first pass inside its `wait_created` write, before it commits.
    const passA = await sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    const requestedA = requestedResumeAtMs(passA.ctx);
    sim.note(`pass A asked to resume at ${new Date(requestedA).toISOString()}`);

    // Commit behind the held write so its snapshot goes stale, then let the
    // world sit — this is the retry gap, whatever caused it.
    await sim.deliverHook('bystander:probe', { ping: true });
    sim.advanceTime(RETRY_GAP_MS);

    // Arm the watch for the second pass BEFORE releasing the first. Releasing
    // first would let the restarted pass reach its write and commit while
    // nothing is watching, and the park would then wait for a third pass that
    // never comes.
    const atPassB = sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    passA.release();

    const passB = await atPassB;
    const requestedB = requestedResumeAtMs(passB.ctx);
    sim.note(`pass B asked to resume at ${new Date(requestedB).toISOString()}`);
    sim.note(`the two passes disagree by ${requestedB - requestedA}ms`);

    sim.check(
      'the first write was fenced, so a second pass ran the body again',
      sim.world.rejections().length === 1
    );

    // The assertion is the property that should hold, not the drift that does:
    // one `sleep()` in one run names one instant, however many passes compute
    // it. It fails today by exactly the retry gap. Resolving the duration
    // against the VM clock — which is a function of the log, so every pass
    // reads the same value — is what makes it pass.
    sim.check(
      'both passes resolved the same sleep() to the same instant',
      requestedB === requestedA
    );

    passB.release();
    await wf.release();
  },
  // FAILS TODAY, and it fails on a check rather than on an outcome: the run
  // completes and its log replays clean. That is the finding as much as the
  // drift is. `verifyReplay` compares event shape and output, and the wait
  // invariants (`wait.resume-at-stable`) compare the log against itself — the
  // committed `resumeAt` is self-consistent and reproduces faithfully on
  // replay. Nothing in the log records what the workflow originally asked for,
  // so no oracle over the log can see that the answer moved. Only a scenario
  // holding both attempts side by side can.
  expect: {
    status: 'completed',
  },
};
