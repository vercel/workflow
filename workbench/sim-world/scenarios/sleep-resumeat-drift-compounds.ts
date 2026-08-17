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
 * How long each fence restart takes. Two of them, so the total stays under the
 * runtime's 240s replay budget and each rejection is the in-process restart a
 * 412 triggers rather than a queue redelivery after a replay timeout.
 */
const RESTART_MS = 45_000;

export const scenario: ScenarioSpec = {
  id: 'sleep-resumeat-drift-compounds',
  name: 'sleep: each concurrent writer moves the deadline again',
  description:
    'The companion to `sleep-resumeat-recomputed`, answering the question that ' +
    'scenario invites: is this only a story about an outage? It is not, and ' +
    'nothing here is down. ' +
    'The trigger for re-reading the clock is the optimistic-concurrency fence, ' +
    'and the fence fires whenever something commits behind a suspension write ' +
    'that is already in flight — an out-of-band hook payload, another ' +
    "branch's step result, an attribute write. That is not a failure mode, it " +
    'is what a busy run looks like. The runtime handles it correctly by its own ' +
    'lights: it rejects the stale write and restarts the replay in process. ' +
    'What it cannot do is carry the deadline across the restart, because the ' +
    'deadline was never written down anywhere the restart can read. ' +
    'So this scripts two of them. Two bystander payloads, each landing behind a ' +
    'held `wait_created` write, produce two fence rejections and therefore three ' +
    'passes over the body — and three independent resolutions of one ' +
    '`sleep("30m")`. The committed deadline is the third. ' +
    'The finding is that they accumulate. The drift is not a one-off ' +
    'rounding error that a retry settles; it is the sum of every restart the ' +
    'suspension took, so it scales with how much concurrency the run is under. ' +
    'A run with several out-of-band writers pays for each of them, and the ' +
    'workflow author has no way to see it or bound it. ' +
    'Magnitude in production is the restart latency rather than the 45s used ' +
    'here — the gaps are inflated to make the arithmetic legible, not to claim ' +
    'a size. What matters is the ratio: the same absolute drift that is noise ' +
    'against `sleep("30m")` is the whole interval for the short sleeps used as ' +
    'poll intervals and race timeouts.',
  workflow: 'sleepWithTwoBystanderHooksWorkflow',
  input: ['probe'],
  // The fence is the mechanism under test, not an incidental detail.
  preconditionGuard: true,
  script: async (sim) => {
    const wf = sim.writer.orchestrator();

    // ---- pass A -----------------------------------------------------------
    const passA = await sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    const requestedA = requestedResumeAtMs(passA.ctx);
    sim.note(`pass A asked to resume at ${new Date(requestedA).toISOString()}`);

    // First bystander commits behind the held write, staling its snapshot.
    await sim.deliverHook('bystander-a:probe', { ping: true });
    sim.advanceTime(RESTART_MS);

    // Arm before releasing: the restarted pass would otherwise reach its write
    // with nothing watching, and the park would wait for a pass that never comes.
    const atPassB = sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    passA.release();

    // ---- pass B, after one fence restart ----------------------------------
    const passB = await atPassB;
    const requestedB = requestedResumeAtMs(passB.ctx);
    sim.note(`pass B asked to resume at ${new Date(requestedB).toISOString()}`);

    // Second bystander, same move. Nothing has failed at any point.
    await sim.deliverHook('bystander-b:probe', { ping: true });
    sim.advanceTime(RESTART_MS);

    const atPassC = sim.park({
      call: 'events.create',
      eventType: 'wait_created',
      phase: 'before',
    });
    passB.release();

    // ---- pass C, which is the one that commits ----------------------------
    const passC = await atPassC;
    const requestedC = requestedResumeAtMs(passC.ctx);
    sim.note(`pass C asked to resume at ${new Date(requestedC).toISOString()}`);
    sim.note(
      `drift A->B ${requestedB - requestedA}ms, ` +
        `B->C ${requestedC - requestedB}ms, ` +
        `total ${requestedC - requestedA}ms — the restarts add up`
    );

    sim.check(
      'two concurrent writes fenced the suspension, so the body ran three times',
      sim.world.rejections().length === 2
    );

    // The property, stated so it greens on the fix: one `sleep()` in one run
    // names one instant, however many passes compute it and however much
    // concurrency the run is under. It fails today by the sum of the restarts.
    sim.check(
      'all three passes resolved the same sleep() to the same instant',
      requestedC === requestedA && requestedB === requestedA
    );

    passC.release();
    await wf.release();
  },
  // FAILS TODAY, on the check rather than the outcome — same as its sibling. The
  // run completes, the log replays clean, and the committed deadline is
  // self-consistent. Nothing in the log records what passes A or B asked for.
  expect: {
    status: 'completed',
    output: 'finalized:prepared:probe',
  },
};
