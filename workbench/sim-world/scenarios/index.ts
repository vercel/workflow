/**
 * The scenario book.
 *
 * Each entry is one workflow plus a script saying how the run's writers
 * interleave and when external input arrives. Pairs of scenarios that differ
 * only in *when* a hook is delivered are the interesting ones — same workflow,
 * same input, same result, different event log — because that difference is
 * exactly what a real deployment leaves to chance.
 *
 * Every script is written in the same three moves:
 *
 * ```ts
 * const wf = sim.writer.orchestrator();
 * await wf.runToEventCommitted('step_started', 'reserveInventory');
 * await sim.deliverHook('approval:doc-1', { approved: true });
 * await wf.release();
 * ```
 *
 * Stop a writer at a named point, act while it is stopped, let it go. The
 * writer matters: `step_started` is committed by the orchestrator, while
 * `step_completed` is committed by the step body itself, so the second is
 * `sim.writer.step('reserveInventory')`. Naming the wrong writer is a wait that
 * times out rather than a silent mismatch.
 *
 * Two rules of thumb, both learned the hard way:
 *
 *  - `runTo` is level-triggered: a point that has already gone by is an error,
 *    not a wait. When two writers must be stopped at once, start both waits
 *    before awaiting either.
 *  - When advancing writer B after holding writer A, arm B's wait *before*
 *    releasing A. A released writer can reach the next point within the same
 *    turn, and a wait armed afterwards has missed it.
 */

import type { ScenarioSpec } from '@workflow/world-sim';

export const scenarios: ScenarioSpec[] = [
  // -------------------------------------------------------------------------
  // Smoke: the smallest logs there are. If the replay check cannot agree with
  // itself here, the problem is the check, not the workflow.
  // -------------------------------------------------------------------------

  {
    name: 'smoke: a workflow with no steps at all',
    workflow: 'emptyWorkflow',
    expect: { status: 'completed', output: 'done' },
  },

  {
    name: 'smoke: a workflow with one null step',
    workflow: 'oneStepWorkflow',
    expect: { status: 'completed', output: null },
  },

  // -------------------------------------------------------------------------
  // The three placements of one hook, relative to one step.
  // -------------------------------------------------------------------------

  {
    name: 'hook arrives inside the step_started commit',
    description:
      'The hook payload is written after step_started is durable and before ' +
      'the workflow is resumed, so hook_received precedes step_completed in the log.',
    workflow: 'approvalWorkflow',
    input: ['doc-1'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('step_started', 'reserveInventory');
      await sim.deliverHook('approval:doc-1', {
        approved: true,
        reviewer: 'ada',
      });
      await wf.release();
    },
    expect: {
      status: 'completed',
      output: { status: 'settled:reserved:doc-1', reviewer: 'ada' },
    },
  },

  {
    name: 'hook arrives inside the step_completed commit',
    description:
      'Same workflow and same result, but hook_received now lands after ' +
      'step_completed. Diff this event stream against the previous scenario. ' +
      'Note the writer: the result is committed by the step body, not by the ' +
      'orchestrator.',
    workflow: 'approvalWorkflow',
    input: ['doc-1'],
    script: async (sim) => {
      const reserve = sim.writer.step('reserveInventory');
      await reserve.runToEventCommitted('step_completed');
      await sim.deliverHook('approval:doc-1', {
        approved: true,
        reviewer: 'ada',
      });
      await reserve.release();
    },
    expect: {
      status: 'completed',
      output: { status: 'settled:reserved:doc-1', reviewer: 'ada' },
    },
  },

  {
    name: 'hook arrives the instant it is registered',
    description:
      'Delivered inside the hook_created commit, before the workflow has even ' +
      'been resumed to schedule the step it runs in parallel with.',
    workflow: 'approvalWorkflow',
    input: ['doc-1'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('hook_created', {
        token: 'approval:doc-1',
      });
      await sim.deliverHook('approval:doc-1', {
        approved: false,
        reviewer: 'grace',
      });
      await wf.release();
    },
    expect: {
      status: 'completed',
      output: { status: 'released:reserved:doc-1', reviewer: 'grace' },
    },
  },

  // -------------------------------------------------------------------------
  // Racing a hook against a timer — both branches, on demand.
  // -------------------------------------------------------------------------

  {
    name: 'hook beats its deadline',
    workflow: 'approvalWithDeadlineWorkflow',
    input: ['doc-2', '1h'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      // Hold the orchestrator the moment the deadline timer becomes durable.
      await wf.runToEventCommitted('wait_created');
      await sim.deliverHook('approval:doc-2', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed', output: 'approved' },
  },

  {
    name: 'deadline expires with no hook',
    description:
      'Nothing delivers the hook, so the run finishes on the timer. One hour ' +
      'of virtual time, no wall-clock wait.',
    workflow: 'approvalWithDeadlineWorkflow',
    input: ['doc-3', '1h'],
    expect: { status: 'completed', output: 'timed-out' },
  },

  // -------------------------------------------------------------------------
  // Termination properties.
  // -------------------------------------------------------------------------

  {
    name: 'a thirty-day sleep costs nothing',
    workflow: 'longSleepWorkflow',
    input: ['payload'],
    expect: { status: 'completed', output: 'finalized:prepared:payload' },
  },

  {
    name: 'a hook that never arrives stalls instead of hanging',
    description:
      'The expected outcome is a stall: the queue drains, the run is still ' +
      'running, and the report names the hook nobody delivered.',
    workflow: 'blockedOnHookWorkflow',
    input: ['doc-4'],
    expect: { status: 'stalled' },
  },

  // -------------------------------------------------------------------------
  // Step lifecycle.
  // -------------------------------------------------------------------------

  {
    name: 'a step retries twice and then succeeds',
    workflow: 'retryingWorkflow',
    input: ['charge'],
    expect: { status: 'completed', output: 'charge:ok-on-attempt-3' },
  },

  {
    name: 'two steps suspend together',
    workflow: 'parallelStepsWorkflow',
    input: ['x'],
    expect: { status: 'completed', output: 'prepared:x|finalized:x' },
  },

  {
    name: 'hook is delivered once execution state says both steps are done',
    description:
      'The wait is on world state rather than on one named point: stop ' +
      'whichever step body commits the completion that takes the count to two, ' +
      'then deliver. The payload is buffered before the workflow ever awaits ' +
      'the hook. A `where` predicate cannot be re-checked against history, so ' +
      'this one wait is edge-triggered and leans on its own timeout.',
    workflow: 'stagedApprovalWorkflow',
    input: ['doc-6'],
    script: async (sim) => {
      const anyStep = sim.writer.anyStep();
      await anyStep.runToEventCommitted('step_completed', {
        where: (world) =>
          world.steps().filter((s) => s.status === 'completed').length === 2,
      });
      await sim.deliverHook('approval:doc-6', { approved: true });
      await anyStep.release();
    },
    expect: {
      status: 'completed',
      output: 'settled:reserved:doc-6/confirmed',
    },
  },

  // -------------------------------------------------------------------------
  // A hook peek: branching on *when* a payload arrived.
  //
  // Same workflow, same input, two deliveries one world call apart. The only
  // difference is whether hook_received lands before or after the branch's own
  // events — which is exactly the thing a replay cannot re-derive.
  // -------------------------------------------------------------------------

  {
    name: 'peek: hook lands just BEFORE the branch step commits',
    description:
      'The first execution peeks, sees nothing, and ships unapproved — then ' +
      'the payload is committed ahead of that branch in the log. A replay ' +
      'reaching the peek now sees the hook and wants the other fork.',
    workflow: 'hookPeekWorkflow',
    input: ['doc-8'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('step_started', 'shipWithoutApproval');
      await sim.deliverHook('peek:doc-8', { approved: true });
      await wf.release();
    },
    // What the first execution actually decided. Anything else is the bug.
    expect: {
      status: 'completed',
      output: 'shipped-unapproved:reserved:doc-8',
    },
  },

  {
    name: 'peek: hook lands just AFTER the branch step commits',
    description:
      'The control. One world call later, so hook_received sits after the ' +
      'branch in the log and a replay reaching the peek still sees nothing.',
    workflow: 'hookPeekWorkflow',
    input: ['doc-9'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('step_started', 'shipWithoutApproval');
      await sim.deliverHook('peek:doc-9', { approved: true });
      await wf.release();
    },
    expect: {
      status: 'completed',
      output: 'shipped-unapproved:reserved:doc-9',
    },
  },

  {
    name: 'peek: hook lands the instant it is registered',
    description:
      'The earliest a payload can possibly arrive. Whichever fork the first ' +
      'execution takes, the replay has to agree with it.',
    workflow: 'hookPeekWorkflow',
    input: ['doc-10'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('hook_created', { token: 'peek:doc-10' });
      await sim.deliverHook('peek:doc-10', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'race: hook lands just BEFORE the probe step completes',
    description:
      'Both branches of the race are event-log deliveries now, so the winner ' +
      'is decided by delivery-barrier ordering — and the script puts ' +
      'hook_received ahead of the step result in the log by holding the step ' +
      'body at the point where it has decided to write and has not yet.',
    workflow: 'hookRaceStepWorkflow',
    input: ['doc-11'],
    script: async (sim) => {
      const probe = sim.writer.step('probe');
      await probe.runToEventProduced('step_completed');
      await sim.deliverHook('race:doc-11', { approved: true });
      await probe.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'race: hook lands just AFTER the probe step completes',
    workflow: 'hookRaceStepWorkflow',
    input: ['doc-12'],
    script: async (sim) => {
      const probe = sim.writer.step('probe');
      await probe.runToEventCommitted('step_completed');
      await sim.deliverHook('race:doc-12', { approved: true });
      await probe.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'race: a webhook receiver delivers the same payload twice',
    description:
      'Two hook_received events for one hookId, straddling the step result. ' +
      'The consumer is subscribed once; the second payload has nobody to go to. ' +
      "Note the arming order: the step body's wait is armed while the " +
      'orchestrator is still held, because releasing first would let the ' +
      'completion slip past.',
    workflow: 'hookRaceStepWorkflow',
    input: ['doc-13'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      const probe = sim.writer.step('probe');

      await wf.runToEventCommitted('step_started', 'probe');
      await sim.deliverHook('race:doc-13', { approved: true });

      const completion = probe.runToEventCommitted('step_completed');
      await wf.release();
      await completion;

      await sim.deliverHook('race:doc-13', { approved: true });
      await probe.release();
    },
    expect: { status: 'completed' },
  },

  // -------------------------------------------------------------------------
  // Concurrent branches: a hook-gated attribute write racing a step.
  // -------------------------------------------------------------------------

  {
    name: 'attr: hook lands BEFORE the concurrent step completes',
    description:
      'The hook-gated branch writes its attr_set ahead of the other branch ' +
      "step's result in the log.",
    workflow: 'concurrentAttributeWorkflow',
    input: ['doc-14'],
    script: async (sim) => {
      const probe = sim.writer.step('probe');
      await probe.runToEventProduced('step_completed');
      await sim.deliverHook('attr:doc-14', { approved: true });
      await probe.release();
    },
    expect: {
      status: 'completed',
      output: 'probed:doc-14/approved',
    },
  },

  {
    name: 'attr: hook lands AFTER the concurrent step completes',
    workflow: 'concurrentAttributeWorkflow',
    input: ['doc-15'],
    script: async (sim) => {
      const probe = sim.writer.step('probe');
      await probe.runToEventCommitted('step_completed');
      await sim.deliverHook('attr:doc-15', { approved: false });
      await probe.release();
    },
    expect: {
      status: 'completed',
      output: 'probed:doc-15/rejected',
    },
  },

  {
    name: 'attr: a step writes run state while a hook lands mid-flight',
    description:
      'The attr_set comes from step context (writer type "step", committed ' +
      'inline, no correlationId dedupe), so unlike the orchestrator path its ' +
      'log position is decided by step timing rather than by suspension. The ' +
      'writer column in the trace names the step body that wrote it.',
    workflow: 'stepAttributeWorkflow',
    input: ['doc-16'],
    script: async (sim) => {
      const recorder = sim.writer.step('probeAndRecord');
      await recorder.runToEventCommitted('attr_set');
      await sim.deliverHook('stepattr:doc-16', { approved: true });
      await recorder.release();
    },
    expect: {
      status: 'completed',
      output: 'recorded:doc-16|probed:doc-16|yes',
    },
  },

  // -------------------------------------------------------------------------
  // step 1 -> hook-with-timeout -> fork. The payload lands in the window
  // between the timeout firing and the chosen branch being committed.
  // -------------------------------------------------------------------------

  {
    name: 'fork: hook arrives just AFTER the timeout, before the branch commits',
    description:
      'The timeout wins the race, so the first execution takes step 3 — but ' +
      'the payload is committed before that branch reaches the log. A replay ' +
      'reaching the race sees both competitors resolvable.',
    workflow: 'hookTimeoutForkWorkflow',
    input: ['doc-17'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('wait_completed');
      await sim.deliverHook('fork:doc-17', { approved: true });
      await wf.release();
    },
    // Deliberately unpinned: which branch the first execution takes is the
    // question. The replay check is the judge of whether it is reproducible.
    expect: { status: 'completed' },
  },

  {
    name: 'fork: hook arrives just BEFORE the timeout commits',
    description:
      'The mirror of the case above, one world call earlier: hook_received now ' +
      'precedes wait_completed in the log, so log position should hand the race ' +
      'to the hook and fork the other way.',
    workflow: 'hookTimeoutForkWorkflow',
    input: ['doc-20'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      await sim.deliverHook('fork:doc-20', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'count: hook lands AFTER the timeout, branches differ by step count',
    description:
      'The shape PR #3147 identified as the amplifier: settle emits one step, ' +
      'recovery emits two, so flipping the branch on replay renames every ' +
      'correlation ID after the fork.',
    workflow: 'stepCountForkWorkflow',
    input: ['doc-21'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('wait_completed');
      await sim.deliverHook('count:doc-21', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'count: hook lands BEFORE the timeout, branches differ by step count',
    workflow: 'stepCountForkWorkflow',
    input: ['doc-22'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      await sim.deliverHook('count:doc-22', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'corrupt: stale event load + step-count fork',
    description:
      'All three preconditions from PR #3147 at once. The hook is committed ' +
      'ahead of wait_completed in the log, but withheld from the read the live ' +
      'pass uses — so the live pass decides the fork without it, while the ' +
      'durable log says the hook came first. The branches differ by step count, ' +
      'so flipping the fork on replay renames every entity after it.',
    workflow: 'stepCountForkWorkflow',
    input: ['doc-23'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      // Arm the window, then write behind it: the hook takes log position 7,
      // ahead of wait_completed at 8, but the read that decides the fork does
      // not see it.
      sim.withholdNextEvent(1);
      await sim.deliverHook('count:doc-23', { approved: true });
      await wf.release();
    },
    // FAILS TODAY. The log puts the hook ahead of the timeout, so the run that
    // agrees with its own log takes the recovery branch. It takes `settle`
    // instead and then cannot replay what it wrote.
    expect: {
      status: 'completed',
      output: 'reconciled(recovered:doc-23+second)',
    },
  },

  {
    name: 'corrupt: stale event load with EQUAL step counts (is the amplifier needed?)',
    description:
      'Identical fault to the scenario above, but on the fork whose branches ' +
      'each emit exactly one step. If this corrupts too then step-count ' +
      'divergence raises the rate rather than being required.',
    workflow: 'hookTimeoutForkWorkflow',
    input: ['doc-25'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      sim.withholdNextEvent(1);
      await sim.deliverHook('fork:doc-25', { approved: true });
      await wf.release();
    },
    // FAILS TODAY, which answers the question in the name: the amplifier is not
    // required for corruption — it is required for the *rate* under concurrent
    // load, and for divergence deep in a long log. What corruption needs is
    // that the flipped branch claim an ordinal the log already gave to a
    // differently-named step.
    expect: { status: 'completed', output: 'step2:doc-25' },
  },

  {
    name: 'corrupt: two racing STEPS, no hook anywhere',
    description:
      'Answers "does this need an out-of-band event type?" — no. The fork is ' +
      "decided by two of the run's own step_completed events, and withholding " +
      'one of them from the deciding read is enough. Two inline step bodies in ' +
      'ONE invocation are already two concurrent writers to the same log; no ' +
      'second invocation is required. ' +
      'Both writers are held so the ordering is stated rather than observed: ' +
      'stop `fast` and `slow` at their produced points, arm the withhold, then ' +
      "release `slow` first, so the log's earliest completion is the one hidden " +
      'from the read that decides the fork. Hiding the *later* completion ' +
      'instead is harmless — the live pass then agrees with the log by ' +
      'accident — which is why the choice has to be made on purpose. ' +
      'Note that both waits are started before either is awaited: awaiting the ' +
      'first would let the second writer sail past its point.',
    workflow: 'stepVsStepForkWorkflow',
    input: ['doc-26'],
    script: async (sim) => {
      const fast = sim.writer.step('fast');
      const slow = sim.writer.step('slow');

      const atFast = fast.runToEventProduced('step_completed');
      const atSlow = slow.runToEventProduced('step_completed');
      await atFast;
      await atSlow;

      sim.check(
        'neither completion is in the log while both writers are held',
        sim.world.events().filter((e) => e.eventType === 'step_completed')
          .length === 0
      );

      sim.withholdNextEvent(1);
      await slow.release();
      await fast.release();
    },
    // FAILS TODAY. `slow` commits first, so the log says `slow` won the race
    // and the run should end on `afterSlow`. The live pass sees only `fast`.
    expect: { status: 'completed', output: 'afterSlow:doc-26' },
  },

  {
    name: 'corrupt: two racing STEPS, WITH the precondition fence on',
    description:
      "Tests the fence's predicate. WorldCapabilities.preconditionGuard is " +
      'documented as rejecting a stale write when a newer OUT-OF-BAND event ' +
      '(e.g. a received hook) was recorded. So does it fence a write made ' +
      "stale by one of the run's OWN step_completed events? Same fault as the " +
      'scenario above, fence enabled. Verified answer: NO — zero ' +
      'PreconditionFailedError rejections, and it corrupts identically. The ' +
      'reason is the shape of the predicate, not the event type: the fence ' +
      'compares the snapshot against a HIGH-WATER MARK of the newest ' +
      'out-of-band write, and rejects only `stateUpdatedAt < marker`. Here the ' +
      'newest such write is the one the reader CAN see (`fast`); the withheld ' +
      "one is older, a hole in the middle of the log, so the reader's snapshot " +
      'is never strictly older than the mark. Separating the two completions ' +
      'in virtual time does not change it — the miss is structural, not a ' +
      'millisecond-granularity tie. Contrast the hook/wait variant above, ' +
      'where the withheld hook IS the newest out-of-band write and the ' +
      'orchestrator carries a pre-sleep snapshot: strictly older, so the same ' +
      'fence rejects twice and the run self-corrects — those rejections show ' +
      'up in the trace as `!!` lines, unasked for. ' +
      'To be precise about which fence: `preconditionGuard` is only the ' +
      'watermark half, which is all a client sends today. The count half ' +
      '(`countGuard`) is aimed at exactly this hole and does catch it — see the ' +
      'in-flight trio below, where the two halves are separated and tested one ' +
      'flag apart.',
    workflow: 'stepVsStepForkWorkflow',
    input: ['doc-27'],
    preconditionGuard: true,
    script: async (sim) => {
      const fast = sim.writer.step('fast');
      const slow = sim.writer.step('slow');
      const atFast = fast.runToEventProduced('step_completed');
      const atSlow = slow.runToEventProduced('step_completed');
      await atFast;
      await atSlow;
      sim.withholdNextEvent(1);
      await slow.release();
      await fast.release();
    },
    // FAILS TODAY, identically to the unfenced scenario above — which is the
    // finding. Turning the watermark on changes nothing here.
    expect: { status: 'completed', output: 'afterSlow:doc-27' },
  },

  {
    name: 'fence: the guard catches the harmless direction, not the harmful one',
    description:
      'The control that shows the fence is not merely weak here — it is aimed ' +
      'the wrong way. Same two racing steps, fence on, completions 5ms apart so ' +
      'no millisecond tie is in play. This time the withheld completion is the ' +
      'log-LATER one (`fast`), so the reader is behind the tail rather than ' +
      'holding a hole: snapshot(t=0) < marker(t=5), and the inline `step_started` ' +
      'claim for the branch step IS rejected — twice — forcing a reload that ' +
      're-decides on the full log. Exactly the self-correction one would expect ' +
      'the guard to provide. But this direction never needed it: a reader that ' +
      'sees only `slow` — the log-FIRST completion — already agrees with the ' +
      'log about who won. Flip which one is hidden (the scenario ' +
      'above) and the fence goes silent on the case that actually corrupts. The ' +
      'watermark covers the benign half of the race and misses the dangerous ' +
      'half — a hole in the middle of the log moves no high-water mark. That ' +
      'asymmetry is the whole argument for the second half of the fence, the ' +
      'count, which asks a question the mark cannot: not "how new is your ' +
      'newest?" but "how many do you hold below it?".',
    workflow: 'stepVsStepForkWorkflow',
    input: ['doc-28'],
    preconditionGuard: true,
    script: async (sim) => {
      const fast = sim.writer.step('fast');
      const slow = sim.writer.step('slow');
      const atFast = fast.runToEventProduced('step_completed');
      const atSlow = slow.runToEventProduced('step_completed');
      await atFast;
      await atSlow;
      // `slow` commits visibly at t=0; the hole is armed against `fast`, which
      // commits at t=5 and is therefore the newest out-of-band write.
      await slow.release();
      sim.advanceTime(5);
      sim.withholdNextEvent(1);
      await fast.release();
    },
    // No violation: the fence fires, the run reloads and takes `afterSlow`,
    // which is what the log says. Contrast the scenario above, same fence.
    expect: { status: 'completed', output: 'afterSlow:doc-28' },
  },

  // -------------------------------------------------------------------------
  // The same fork as the doc-23 pair, but with no stale read anywhere. The
  // log's earlier event is simply still IN FLIGHT: its id — the log's sort
  // key — was minted at the handler boundary (workflow-server calls
  // `EventId.make()` before it attempts the write, because DynamoDB does not
  // generate ids), and the write has not landed. Every reader gets a complete,
  // strongly-consistent view of the log; that log just does not contain the
  // event yet, and when it finally does the event appears *behind* a position
  // readers have already passed.
  //
  // This is the shape production actually has, now that event-log reads are
  // strongly consistent: there is no read to be stale, so `withholdNextEvent`
  // models a fault that no longer exists. What differs between the three
  // scenarios below is only *when* the in-flight write lands relative to the
  // decision it invalidates, and that timing alone decides which guard, if
  // any, can see it.
  //
  // The in-flight writer has to be the out-of-band one. Holding an inline
  // step's `step_completed` between mint and commit stalls the orchestrator
  // too — the runtime awaits every inline step promise before it can decide
  // anything — so the reader that should misread the log never gets to read
  // it. That is not a limitation of the simulator; it is why the hazard needs
  // a writer that is not part of the run's own await graph.
  // -------------------------------------------------------------------------

  {
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
      'the doc-23 pair, reached without a stale read.',
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
      sim.check(
        'the hook owns a log position but is nowhere in the log',
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
    // FAILS TODAY, like the stale-read scenarios above. The difference is that
    // this one needs no stale read to happen — and, unlike them, the fix is
    // already known and sitting one flag away: see the scenario below, which is
    // this one with the count guard on and green.
    expect: {
      status: 'completed',
      output: 'reconciled(recovered:doc-29+second)',
    },
  },

  {
    name: 'in-flight: same tempo, count guard ON — the write is fenced',
    description:
      'Identical to the scenario above with the count half of the fence armed: ' +
      'the caller sends how many events it had loaded at or below its own ' +
      'watermark, and the world compares that against how many the log actually ' +
      'holds there. The hook committed in the meantime, so the log holds one ' +
      'more than the caller loaded and C is rejected with a 412 — even though ' +
      'the watermark comparison passes. The orchestrator reloads, sees the hook ' +
      'ahead of the timeout in log order, re-decides the fork as "arrived", and ' +
      'commits the branch the log agrees with. This is the regression test for ' +
      'the half of the fence a high-water mark cannot express: same fault, same ' +
      'tempo, one flag apart. Note it is dark in production, because no client ' +
      'sends the count today.',
    workflow: 'stepCountForkWorkflow',
    input: ['doc-30'],
    preconditionGuard: true,
    countGuard: true,
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      const hook = await sim.beginHookDelivery('count:doc-30', {
        approved: true,
      });
      await wf.runToEventProduced('step_started');
      await hook.commit();
      await wf.release();
    },
    // The rejection and the reload show up in the trace as `!!` lines. The
    // branch is the one the durable log implies, so there is nothing to diverge.
    expect: {
      status: 'completed',
      output: 'reconciled(recovered:doc-30+second)',
    },
  },

  {
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
      'slower write is more dangerous the longer it takes.',
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
    // replays — so the run dies rather than completing wrongly. Of the six
    // reds, this is the one with no known fix: both guards are on, and closing
    // it needs the append-tail fence that does not exist yet.
    expect: {
      status: 'completed',
      output: 'reconciled(recovered:doc-31+second)',
    },
  },

  {
    name: 'corrupt: same shape, with the optimistic-concurrency fence armed',
    description:
      'Identical to the count: fork scenario but with preconditionGuard on, so ' +
      'the World rejects a replay-context write whose stateUpdatedAt snapshot ' +
      'predates the newest out-of-band event. Does the 412 fence stop it? It ' +
      'does: every rejected write is traced as a `!!` line, and the run ' +
      'reconciles instead of diverging.',
    workflow: 'stepCountForkWorkflow',
    input: ['doc-24'],
    preconditionGuard: true,
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventProduced('wait_completed');
      sim.withholdNextEvent(1);
      await sim.deliverHook('count:doc-24', { approved: true });
      await wf.release();
    },
    expect: {
      status: 'completed',
      output: 'reconciled(recovered:doc-24+second)',
    },
  },

  {
    name: 'fork: hook arrives before the timeout',
    workflow: 'hookTimeoutForkWorkflow',
    input: ['doc-18'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('wait_created');
      await sim.deliverHook('fork:doc-18', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed', output: 'step2:doc-18' },
  },

  {
    name: 'fork: hook never arrives, timeout decides',
    workflow: 'hookTimeoutForkWorkflow',
    input: ['doc-19'],
    expect: { status: 'completed', output: 'step3:doc-19' },
  },

  // -------------------------------------------------------------------------
  // What the writer vocabulary buys, stated as scenarios.
  // -------------------------------------------------------------------------

  {
    name: 'writers: two step bodies advance independently',
    description:
      'The claim the whole writer API rests on: two inline step bodies in one ' +
      "delivery are separately advanceable. Hold slow's step_completed at its " +
      "produced (pre-commit) point; while it is held, fast's step_completed " +
      'still commits. Per-writer scheduling needs no new concurrency, only a ' +
      'way to name and steer what is already there. ' +
      'Note the assertion is level-triggered (read the log) rather than ' +
      'edge-triggered (await the event): fast commits during the hold itself, ' +
      "because arming yields and fast's create was already in flight. An " +
      '`until()` here waits for an edge that has already passed and deadlocks.',
    workflow: 'stepVsStepForkWorkflow',
    input: ['doc-28'],
    script: async (sim) => {
      const slow = sim.writer.step('slow');
      const held = await slow.runToEventProduced('step_completed');

      const committed = sim.world
        .events()
        .filter((e) => e.eventType === 'step_completed');
      sim.check(
        'fast committed while slow was held pre-commit',
        committed.some((e) =>
          String((e.eventData as { stepName?: string })?.stepName).endsWith(
            '//fast'
          )
        )
      );
      sim.check(
        'slow has NOT committed — it is the one being held',
        !committed.some((e) =>
          String((e.eventData as { stepName?: string })?.stepName).endsWith(
            '//slow'
          )
        )
      );

      await held.release();
    },
    expect: { status: 'completed' },
  },

  {
    name: 'writers: the script names the tempo top to bottom',
    description:
      'Every ordering in this scenario is a statement: hold the orchestrator ' +
      'at the call that commits step_started, assert what the log does and does ' +
      'not contain, deliver, release, then wait for the run to finish and ' +
      'assert the committed order. `until` is the read-only counterpart to a ' +
      'hold — it waits for a point without stopping anything.',
    workflow: 'approvalWorkflow',
    input: ['doc-7'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      // Nothing else in the world can advance this writer while it is held.
      await wf.runToEventCommitted('step_started', 'reserveInventory');

      sim.check(
        'the hook is registered but nothing has been received yet',
        sim.world.events().some((e) => e.eventType === 'hook_created') &&
          !sim.world.events().some((e) => e.eventType === 'hook_received')
      );

      await sim.deliverHook('approval:doc-7', {
        approved: true,
        reviewer: 'hopper',
      });
      await wf.release();

      await sim.until({ eventType: 'run_completed', phase: 'after' });
      const order = sim.world.events().map((e) => e.eventType);
      sim.check(
        'hook_received precedes step_completed',
        order.indexOf('hook_received') < order.indexOf('step_completed')
      );
    },
    expect: {
      status: 'completed',
      output: { status: 'settled:reserved:doc-7', reviewer: 'hopper' },
    },
  },

  {
    name: 'cancellation lands mid-step',
    description:
      'The run is cancelled inside the step_started commit, so the step body ' +
      'runs against an already-terminal run and its step_completed is the only ' +
      'write the world still accepts.',
    workflow: 'approvalWorkflow',
    input: ['doc-5'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('step_started', 'reserveInventory');
      await sim.cancelRun('operator pulled the plug');
      await wf.release();
    },
    expect: { status: 'cancelled' },
  },
];
