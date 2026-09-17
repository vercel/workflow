/**
 * The scenario book: one file per scenario, and this index.
 *
 * Each entry is one workflow plus a script saying how the run's writers
 * interleave and when external input arrives. Pairs of scenarios that differ
 * only in *when* a hook is delivered are the interesting ones — same workflow,
 * same input, same result, different event log — because that difference is
 * exactly what a real deployment leaves to chance.
 *
 * How to write one — the three moves, which writer commits which event, what
 * to assert and what not to — is in the workbench README. Start by copying the
 * file next door.
 *
 * @see ../README.md#adding-a-scenario
 */

import type { ScenarioSpec } from '@workflow/world-sim';
import { scenario as attrFromStepBody } from './attr-from-step-body.ts';
import { scenario as attrHookAfterStep } from './attr-hook-after-step.ts';
import { scenario as attrHookBeforeStep } from './attr-hook-before-step.ts';
import { scenario as cancelMidStep } from './cancel-mid-step.ts';
import { scenario as claimedPayloadUnderFork } from './claimed-payload-under-fork.ts';
import { scenario as clockAfterRace } from './clock-after-race.ts';
import { scenario as countHookAfterTimeout } from './count-hook-after-timeout.ts';
import { scenario as countHookBeforeTimeout } from './count-hook-before-timeout.ts';
import { scenario as deadlineExpires } from './deadline-expires.ts';
import { scenario as deadlineHookWins } from './deadline-hook-wins.ts';
import { scenario as fenceCatchesBenignDirection } from './fence-catches-benign-direction.ts';
import { scenario as forkHookAfterTimeout } from './fork-hook-after-timeout.ts';
import { scenario as forkHookBeforeTimeout } from './fork-hook-before-timeout.ts';
import { scenario as forkHookWins } from './fork-hook-wins.ts';
import { scenario as forkTimeoutWins } from './fork-timeout-wins.ts';
import { scenario as hookAtHookCreated } from './hook-at-hook-created.ts';
import { scenario as hookAtStepCompleted } from './hook-at-step-completed.ts';
import { scenario as hookAtStepStarted } from './hook-at-step-started.ts';
import { scenario as hookNeverArrives } from './hook-never-arrives.ts';
import { scenario as hookOnExecutionState } from './hook-on-execution-state.ts';
import { scenario as inFlightAfterDecision } from './in-flight-after-decision.ts';
import { scenario as inFlightBeforeDecision } from './in-flight-before-decision.ts';
import { scenario as inFlightBeforeDecisionCounted } from './in-flight-before-decision-counted.ts';
import { scenario as longSleep } from './long-sleep.ts';
import { scenario as parallelSteps } from './parallel-steps.ts';
import { scenario as peekHookAfterBranch } from './peek-hook-after-branch.ts';
import { scenario as peekHookAtRegistration } from './peek-hook-at-registration.ts';
import { scenario as peekHookBeforeBranch } from './peek-hook-before-branch.ts';
import { scenario as raceDuplicateDelivery } from './race-duplicate-delivery.ts';
import { scenario as raceHookAfterProbe } from './race-hook-after-probe.ts';
import { scenario as raceHookBeforeProbe } from './race-hook-before-probe.ts';
import { scenario as smokeNoSteps } from './smoke-no-steps.ts';
import { scenario as smokeOneStep } from './smoke-one-step.ts';
import { scenario as staleReadEqualStepCounts } from './stale-read-equal-step-counts.ts';
import { scenario as staleReadStepCountFork } from './stale-read-step-count-fork.ts';
import { scenario as staleReadStepCountForkFenced } from './stale-read-step-count-fork-fenced.ts';
import { scenario as stepRetriesTwice } from './step-retries-twice.ts';
import { scenario as stepVsStepFork } from './step-vs-step-fork.ts';
import { scenario as stepVsStepForkFenced } from './step-vs-step-fork-fenced.ts';
import { scenario as unclaimedPayloadUnderFork } from './unclaimed-payload-under-fork.ts';
import { scenario as writersIndependentStepBodies } from './writers-independent-step-bodies.ts';
import { scenario as writersScriptedTempo } from './writers-scripted-tempo.ts';

/**
 * The book, in reading order. Order is the only thing this file decides:
 * simplest first, then each pair of near-identical scenarios adjacent, so a
 * reader meets a distinction right after the thing it is a distinction from.
 */
export const scenarios: ScenarioSpec[] = [
  // -------------------------------------------------------------------------
  // Smoke: the smallest logs there are. If the replay check cannot agree with
  // itself here, the problem is the check, not the workflow.
  // -------------------------------------------------------------------------
  smokeNoSteps,
  smokeOneStep,

  // -------------------------------------------------------------------------
  // The three placements of one hook, relative to one step.
  // -------------------------------------------------------------------------
  hookAtStepStarted,
  hookAtStepCompleted,
  hookAtHookCreated,

  // -------------------------------------------------------------------------
  // Racing a hook against a timer — both branches, on demand.
  // -------------------------------------------------------------------------
  deadlineHookWins,
  deadlineExpires,

  // -------------------------------------------------------------------------
  // Termination properties.
  // -------------------------------------------------------------------------
  longSleep,
  hookNeverArrives,

  // -------------------------------------------------------------------------
  // Step lifecycle.
  // -------------------------------------------------------------------------
  stepRetriesTwice,
  parallelSteps,
  hookOnExecutionState,

  // -------------------------------------------------------------------------
  // A hook peek: branching on *when* a payload arrived.
  //
  // Same workflow, same input, two deliveries one world call apart. The only
  // difference is whether hook_received lands before or after the branch's own
  // events — which is exactly the thing a replay cannot re-derive.
  // -------------------------------------------------------------------------
  peekHookBeforeBranch,
  peekHookAfterBranch,
  peekHookAtRegistration,
  raceHookBeforeProbe,
  raceHookAfterProbe,
  raceDuplicateDelivery,

  // -------------------------------------------------------------------------
  // Concurrent branches: a hook-gated attribute write racing a step.
  // -------------------------------------------------------------------------
  attrHookBeforeStep,
  attrHookAfterStep,
  attrFromStepBody,

  // -------------------------------------------------------------------------
  // step 1 -> hook-with-timeout -> fork. The payload lands in the window
  // between the timeout firing and the chosen branch being committed.
  // -------------------------------------------------------------------------
  forkHookAfterTimeout,
  forkHookBeforeTimeout,
  countHookAfterTimeout,
  countHookBeforeTimeout,
  staleReadStepCountFork,
  staleReadEqualStepCounts,
  stepVsStepFork,
  stepVsStepForkFenced,
  clockAfterRace,
  fenceCatchesBenignDirection,

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
  inFlightBeforeDecision,
  inFlightBeforeDecisionCounted,
  inFlightAfterDecision,
  staleReadStepCountForkFenced,
  forkHookWins,
  forkTimeoutWins,

  // -------------------------------------------------------------------------
  // An unclaimed hook payload under the fork.
  //
  // The three scenarios above all turn on *when* an event lands. These two
  // turn on something the log alone does not show: whether anything in the
  // workflow is waiting for it. A payload nobody reads registers a delivery
  // barrier that only the runtime's idle net can retire, and every later
  // delivery that defers behind hooks parks on it — so it changes the order
  // other events are delivered in without appearing to do anything at all.
  //
  // The pair is a controlled comparison: identical steps, identical tempo,
  // identical log order, differing only in whether a branch claims the
  // payload.
  // -------------------------------------------------------------------------
  unclaimedPayloadUnderFork,
  claimedPayloadUnderFork,

  // -------------------------------------------------------------------------
  // What the writer vocabulary buys, stated as scenarios.
  // -------------------------------------------------------------------------
  writersIndependentStepBodies,
  writersScriptedTempo,
  cancelMidStep,
];
