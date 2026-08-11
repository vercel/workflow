/**
 * Every workflow the scenario book runs, in one file.
 *
 * They are here together because they are read together: a scenario names a
 * workflow and a tempo, and checking whether the tempo is the interesting one
 * means looking at the branch it steers. Splitting them across modules made
 * that a two-file hop for no benefit — the bundle compiles the whole directory
 * either way, and no workflow here imports another.
 *
 * Grouped by what the workflow is *for*, simplest first:
 *
 *   1. Smoke        — the smallest logs a run can leave.
 *   2. Timing       — sleeps and retries, to prove virtual time costs nothing.
 *   3. Approval     — a hook and a step suspended together.
 *   4. Peek         — branching on whether a hook has *already* fired.
 *   5. Attributes   — the only mutable run state, written from two contexts.
 *   6. Forks        — a hook racing a timeout, which is where corruption lives.
 *   7. Step-vs-step — the same fork with no out-of-band event at all.
 *   8. Unclaimed    — a hook payload nobody reads, parked under a fork.
 *
 * Step functions are module-private and sit directly above the first workflow
 * that uses them. Names are unique across the whole file, so a scenario can
 * steer a writer by short step name (`sim.writer.step('slow')`) without
 * ambiguity.
 */

import {
  createHook,
  getStepMetadata,
  RetryableError,
  setAttributes,
  sleep,
} from 'workflow';

// ---------------------------------------------------------------------------
// 1. Smoke
// ---------------------------------------------------------------------------

/** Nothing but a return value: the smallest log a completed run can have. */
export async function emptyWorkflow() {
  'use workflow';
  return 'done';
}

async function noopStep() {
  'use step';
  return null;
}

/** One step that does nothing. The smallest log that exercises the step path. */
export async function oneStepWorkflow() {
  'use workflow';
  return await noopStep();
}

// ---------------------------------------------------------------------------
// 2. Timing
// ---------------------------------------------------------------------------

async function prepare(input: string) {
  'use step';
  return `prepared:${input}`;
}

async function finalize(input: string) {
  'use step';
  return `finalized:${input}`;
}

/**
 * A month-long sleep between two steps.
 *
 * Under virtual time this costs nothing: the wait continuation is a queue
 * message dated 30 days out, and delivering it is a clock assignment. The
 * scenario for this workflow is the proof that "all scenarios terminate"
 * survives contact with realistic durations.
 */
export async function longSleepWorkflow(input: string) {
  'use workflow';

  const prepared = await prepare(input);
  await sleep('30d');
  return await finalize(prepared);
}

/**
 * Fails deterministically for its first two attempts, then succeeds.
 *
 * Retry backoff is `delaySeconds` on a queue message, so the retry schedule
 * is virtual too — the scenario observes three `step_started` events and the
 * growing gaps between them without waiting for any of them.
 */
async function flakyStep(label: string) {
  'use step';
  const { attempt } = getStepMetadata();
  if (attempt < 3) {
    throw new RetryableError(`${label} failed on attempt ${attempt}`);
  }
  return `${label}:ok-on-attempt-${attempt}`;
}

export async function retryingWorkflow(label: string) {
  'use workflow';
  return await flakyStep(label);
}

/**
 * Two steps that suspend together, so the world sees interleaved
 * `step_started` / `step_completed` pairs for distinct correlation IDs.
 */
export async function parallelStepsWorkflow(input: string) {
  'use workflow';
  const [a, b] = await Promise.all([prepare(input), finalize(input)]);
  return `${a}|${b}`;
}

// ---------------------------------------------------------------------------
// 3. Approval — a hook and a step suspended together
// ---------------------------------------------------------------------------

async function reserveInventory(documentId: string) {
  'use step';
  return `reserved:${documentId}`;
}

async function settleOrder(reservation: string, approved: boolean) {
  'use step';
  return approved ? `settled:${reservation}` : `released:${reservation}`;
}

/**
 * A step and a hook suspend together.
 *
 * This is the shape the timing control exists for: the run has an in-flight
 * step *and* an open hook at the same moment, so where the `hook_received`
 * event lands relative to `step_started` / `step_completed` is a real
 * ordering choice rather than an artifact of whoever won the race. A
 * scenario pins that choice with a cue on the exact world call that commits
 * the step event.
 */
export async function approvalWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean; reviewer: string }>({
    token: `approval:${documentId}`,
  });

  const [reservation, decision] = await Promise.all([
    reserveInventory(documentId),
    hook,
  ]);

  const status = await settleOrder(reservation, decision.approved);
  return { status, reviewer: decision.reviewer };
}

/**
 * Approval with a deadline: whichever of the hook and the timer resolves
 * first decides the outcome.
 *
 * Under a real world this is genuinely racy and therefore untestable; here
 * the hook only arrives if a cue delivers it, and the timer only fires when
 * the scheduler jumps the clock to it, so both branches are reachable on
 * demand.
 */
export async function approvalWithDeadlineWorkflow(
  documentId: string,
  deadline: string
) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const decision = await Promise.race([
    hook.then((payload) => (payload.approved ? 'approved' : 'rejected')),
    sleep(deadline as never).then(() => 'timed-out' as const),
  ]);

  return decision;
}

/**
 * Waits on a hook with nothing else to wake it. Used to pin down what the
 * simulator does when external input never arrives: report a stall with the
 * open hook named, rather than hang.
 */
export async function blockedOnHookWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const decision = await hook;
  return decision.approved;
}

/**
 * Two sequential steps, then the hook is awaited.
 *
 * Useful for cues keyed on *execution state* rather than on a single event:
 * "deliver once both steps have completed" is a predicate over the world, and
 * it lands the payload before the workflow ever awaits the hook.
 */
export async function stagedApprovalWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `approval:${documentId}`,
  });

  const reservation = await reserveInventory(documentId);
  const settled = await settleOrder(reservation, true);
  const decision = await hook;

  return `${settled}/${decision.approved ? 'confirmed' : 'reverted'}`;
}

// ---------------------------------------------------------------------------
// 4. Peek — branching on whether a hook has *already* fired
// ---------------------------------------------------------------------------

async function reserve(documentId: string) {
  'use step';
  return `reserved:${documentId}`;
}

async function shipWithoutApproval(reservation: string) {
  'use step';
  return `shipped-unapproved:${reservation}`;
}

async function shipWithApproval(reservation: string) {
  'use step';
  return `shipped-approved:${reservation}`;
}

/**
 * Branches on whether a hook has *already* fired, without waiting for it.
 *
 * There is no peek API on `Hook`, so the way a user writes "has the approval
 * landed yet?" is to race it against an already-resolved promise. That makes
 * the branch a function of *when* the payload arrived rather than of the
 * payload itself — and "when" is the one thing a replay does not reproduce,
 * because on replay the whole log is already there.
 *
 * The hazard: if `hook_received` is committed at a log position before the
 * branch's own events, then a replay reaching this race has the payload
 * buffered and takes the other fork. The first execution shipped without
 * approval; the replay wants to ship with it, and the log says otherwise.
 */
export async function hookPeekWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `peek:${documentId}`,
  });

  const reservation = await reserve(documentId);

  const peeked = await Promise.race([
    hook.then(() => 'arrived' as const),
    Promise.resolve('not-yet' as const),
  ]);

  return peeked === 'arrived'
    ? await shipWithApproval(reservation)
    : await shipWithoutApproval(reservation);
}

async function probe(documentId: string) {
  'use step';
  return `probed:${documentId}`;
}

/**
 * The same branch, but racing the hook against a *step* rather than against an
 * already-resolved promise.
 *
 * This is the harder version. A resolved promise wins on a microtask and the
 * hook payload is deliberately deferred behind a macrotask, so the peek above
 * always reads "not yet". Here both competitors are event-log deliveries, so
 * which one wins is decided by the runtime's delivery-barrier ordering — and
 * that ordering is keyed on log position, which the cue controls.
 */
export async function hookRaceStepWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `race:${documentId}`,
  });

  const winner = await Promise.race([
    hook.then(() => 'hook' as const),
    probe(documentId).then(() => 'step' as const),
  ]);

  return winner === 'hook'
    ? await shipWithApproval(`race:${documentId}`)
    : await shipWithoutApproval(`race:${documentId}`);
}

// ---------------------------------------------------------------------------
// 5. Attributes — the only mutable run state, written from two contexts
// ---------------------------------------------------------------------------

/**
 * Two concurrent branches: one gated on a hook that then records the decision
 * as run state, one an ordinary step.
 *
 * Three delivery types land in one log here — a step result, a hook payload,
 * and an `attr_set` — and the hook's arrival time decides the order of the last
 * two relative to the first. Attributes are the only *mutable* run state a
 * workflow can write, and the world materializes them by folding the log, so
 * this is where an ordering bug would show up as a wrong final value rather
 * than as a divergence.
 */
export async function concurrentAttributeWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `attr:${documentId}`,
  });

  const [approved, probed] = await Promise.all([
    (async () => {
      const payload = await hook;
      await setAttributes({ approval: payload.approved ? 'yes' : 'no' });
      return payload.approved;
    })(),
    probe(documentId),
  ]);

  await setAttributes({ phase: 'settled' });
  return `${probed}/${approved ? 'approved' : 'rejected'}`;
}

/** Writes run state from inside a step body, not from the orchestrator. */
async function probeAndRecord(documentId: string) {
  'use step';
  await setAttributes({ probedBy: 'step', document: documentId });
  return `recorded:${documentId}`;
}

/**
 * Two concurrent steps plus a hook, where the attribute is written from *step*
 * context rather than from the orchestrator.
 *
 * A different path than `concurrentAttributeWorkflow`: an `attr_set` from a step
 * carries `writer: { type: 'step', stepId, attempt }`, is committed inline while
 * the body runs rather than batched at the next suspension, and gets no
 * correlationId dedupe — so its log position really is decided by step timing.
 */
export async function stepAttributeWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `stepattr:${documentId}`,
  });

  const [payload, recorded, probed] = await Promise.all([
    hook,
    probeAndRecord(documentId),
    probe(documentId),
  ]);

  return `${recorded}|${probed}|${payload.approved ? 'yes' : 'no'}`;
}

// ---------------------------------------------------------------------------
// 6. Forks — a hook racing a timeout
// ---------------------------------------------------------------------------

/** Step 1. Does nothing; it exists to put a step boundary before the race. */
async function stepOne() {
  'use step';
  return null;
}

/** Step 2 — the "hook arrived" branch. */
async function stepTwo(documentId: string) {
  'use step';
  return `step2:${documentId}`;
}

/** Step 3 — the "timed out, no hook" branch. */
async function stepThree(documentId: string) {
  'use step';
  return `step3:${documentId}`;
}

/**
 * step 1 → wait for the hook with a timeout → branch on which won.
 *
 * The dangerous window is between `wait_completed` (the timeout firing) and the
 * commit of whichever branch step gets chosen. A payload delivered there is
 * durably *ahead* of the branch in the log while the first execution decided
 * the branch without it — so a replay reaching the race sees both competitors
 * resolvable and has to pick the same one, on log position alone.
 */
export async function hookTimeoutForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `fork:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  return arrived ? await stepTwo(documentId) : await stepThree(documentId);
}

async function settle(documentId: string) {
  'use step';
  return `settled:${documentId}`;
}

async function recoverFirst(documentId: string) {
  'use step';
  return `recovered:${documentId}`;
}

async function recoverSecond(previous: string) {
  'use step';
  return `${previous}+second`;
}

async function reconcile(tail: string) {
  'use step';
  return `reconciled(${tail})`;
}

/**
 * The same fork, but the two paths emit a *different number of steps*.
 *
 * This is the amplifier the shape above was missing. Correlation IDs are
 * positional ordinals of one seeded sequence, so when the settle path emits one
 * step and the recovery path emits two, a replay that flips the branch renames
 * every entity after the fork. The log then contains a `step_created` nobody
 * asks for, which is an unrecoverable divergence rather than a benign retry
 * that happens to mint the same ids.
 *
 * `reconcile` exists to carry the shift past the fork: its ordinal differs by
 * one between the two paths.
 */
export async function stepCountForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `count:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  let tail: string;
  if (arrived) {
    tail = await recoverSecond(await recoverFirst(documentId));
  } else {
    tail = await settle(documentId);
  }

  return await reconcile(tail);
}

/**
 * The same fork again, with one addition: the run suspends *after* the branch.
 *
 * Every check a write can meet happens inside the write itself — the fence is
 * a conditional append, evaluated against the log as it stands at that
 * instant. So the only moment at which a late-committing event can land
 * without meeting any check at all is one where the run is making no writes:
 * the gap between one delivery ending and the next beginning. This workflow
 * creates such a gap in the middle of a run, which is where the third
 * in-flight scenario lands its hook.
 *
 * Suspending after the branch (rather than letting the run finish) also keeps
 * the hook alive. A run that has completed has disposed its hooks and gone
 * terminal, and a `hook_received` arriving then is refused for reasons that
 * have nothing to do with concurrency — which would hide the hazard rather
 * than test it.
 */
export async function lateAppendForkWorkflow(documentId: string) {
  'use workflow';

  using hook = createHook<{ approved: boolean }>({
    token: `count:${documentId}`,
  });

  await stepOne();

  const arrived = await Promise.race([
    hook.then(() => true),
    sleep('1m').then(() => false),
  ]);

  const tail = arrived
    ? await recoverSecond(await recoverFirst(documentId))
    : await settle(documentId);

  // The quiescent window. `wait_created` is the last write this delivery
  // makes; nothing of this run is checked again until the timer fires.
  await sleep('1m');

  return await reconcile(tail);
}

// ---------------------------------------------------------------------------
// 7. Step-vs-step — the same fork with no out-of-band event at all
// ---------------------------------------------------------------------------

/**
 * A fork decided entirely by events the run writes itself — no hook, no
 * external writer, no timer.
 *
 * Two steps suspend together and race. The winner is whichever `step_completed`
 * sits earlier in the log, so the branch is a function of log order exactly as
 * the hook races were. The point of this shape is to show that "the log and the
 * execution disagree" does not require an out-of-band event type: it requires
 * only two events whose relative order decides a branch, plus a reader that
 * missed one of them.
 */

async function fast(documentId: string) {
  'use step';
  return `fast:${documentId}`;
}

async function slow(documentId: string) {
  'use step';
  return `slow:${documentId}`;
}

async function afterFast(documentId: string) {
  'use step';
  return `afterFast:${documentId}`;
}

async function afterSlow(documentId: string) {
  'use step';
  return `afterSlow:${documentId}`;
}

export async function stepVsStepForkWorkflow(documentId: string) {
  'use workflow';

  const winner = await Promise.race([
    fast(documentId).then(() => 'fast' as const),
    slow(documentId).then(() => 'slow' as const),
  ]);

  return winner === 'fast'
    ? await afterFast(documentId)
    : await afterSlow(documentId);
}

// ---------------------------------------------------------------------------
// 8. Unclaimed payload — a hook nobody reads, sitting under the fork
// ---------------------------------------------------------------------------

/**
 * A hook payload registers its delivery barrier **unarmed** when no branch is
 * waiting on it (`workflow/hook.ts`, `armed: promises.length > 0`), because
 * nothing in the workflow will ever resolve it — only the barrier registry's
 * idle safety net retires it. Every other delivery that defers behind hooks
 * therefore parks behind that payload, waits included.
 *
 * A step result may skip an unclaimed payload, or it would stall until that
 * net fires. The hazard is that the skip can be *transitive*: the step also
 * skips a `wait_completed` that is merely parked behind the payload, even
 * though the wait sits earlier in the log and would otherwise gate it. The two
 * branches then draw each other's correlation ids, and the log stops replaying
 * into the run that wrote it.
 *
 * The shape below is the smallest thing that has all three barriers pending in
 * one delivery: an unclaimed payload, an armed wait, and a step result, in
 * that log order. It is written as `Promise.all` rather than `Promise.race`
 * because the fault is not which branch *wins* — both branches run either way,
 * and the output is the same — it is which branch resumes first and therefore
 * which `step_created` id each one draws. That is invisible in the output and
 * visible only to a replay.
 */

async function pokedWork(documentId: string) {
  'use step';
  return `worked:${documentId}`;
}

async function afterPokedStep(documentId: string) {
  'use step';
  return `afterStep:${documentId}`;
}

async function afterPokedSleep(documentId: string) {
  'use step';
  return `afterSleep:${documentId}`;
}

export async function unclaimedPayloadForkWorkflow(documentId: string) {
  'use workflow';

  // Created and never read. Everything about this scenario follows from that.
  using _poke = createHook<{ kind: string }>({ token: `poke:${documentId}` });

  const branchStep = (async () => {
    await pokedWork(documentId);
    return await afterPokedStep(documentId);
  })();

  const branchSleep = (async () => {
    await sleep('1m');
    return await afterPokedSleep(documentId);
  })();

  const [stepTail, sleepTail] = await Promise.all([branchStep, branchSleep]);
  return `${stepTail}|${sleepTail}`;
}

/**
 * The control: the same three events in the same log order, with one branch
 * awaiting the payload.
 *
 * Claiming it arms the hook barrier, so the wait no longer parks behind an
 * entry that cannot resolve itself, and the step result gates on the wait the
 * ordinary way. Everything else — the steps, the sleep, the tempo the scenario
 * scripts — is identical, which is what makes the pair a controlled
 * comparison rather than two unrelated runs.
 */
export async function claimedPayloadForkWorkflow(documentId: string) {
  'use workflow';

  using poke = createHook<{ kind: string }>({ token: `poke:${documentId}` });

  const branchStep = (async () => {
    await pokedWork(documentId);
    return await afterPokedStep(documentId);
  })();

  const branchSleep = (async () => {
    await sleep('1m');
    return await afterPokedSleep(documentId);
  })();

  // Draws no correlation id of its own, so both workflows leave the same log
  // shape; the only difference is that this one has a consumer attached when
  // the payload lands.
  const branchPoke = (async () => {
    await poke;
  })();

  const [stepTail, sleepTail] = await Promise.all([
    branchStep,
    branchSleep,
    branchPoke,
  ]);
  return `${stepTail}|${sleepTail}`;
}
