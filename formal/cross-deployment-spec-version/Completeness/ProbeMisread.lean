/-
ProbeMisread: two client-side changes that landed on workflow main after the
stack (#4327, #4366) was modelled.

1. #4916 (42077f2b9): the cross-deployment capability probe sent
   `{ __healthCheck, correlationId, runId }` since #3099. 4.x deployments
   parse a queue payload with a union that tries `WorkflowInvokePayloadSchema`
   first, and `runId` is that schema's only required field, so a 4.x
   responder read the probe as "replay this run" and never answered it.
   Since #4916 the probe carries `probeRunId` instead (packages/core/src/
   runtime/helpers.ts, packages/world/src/queue.ts:520-560); 5.x responders
   accept both spellings.

   StartStamping and Combined treat the stable (4.x) target's probe outcome
   as a free choice (fast, slow, miss, no channel). This file shows that,
   for every #4327 caller released before #4916, the only reachable outcome
   against a 4.x target was a miss: the run was stamped with the miss floor
   (6) on EVERY cross-deployment start into a 4.x deployment, not only on a
   slow probe, and a 4.x target can never run a spec-6 run (C2, always).
   With #4916 the 4.x responder answers 3 and the stamp is runnable.

2. #4415 (20aa6562f): events a process writes to a run it may not execute
   (`hook_received`, `run_cancelled`, the DEPLOYMENT_MISMATCH `run_failed`,
   `wait_completed`, re-enqueues) are stamped
   `specVersionForRunWrite(run.specVersion, whenUnknown)
      = min(SPEC_VERSION_CURRENT, run.specVersion ?? whenUnknown)`
   (packages/core/src/runtime/run-spec-version.ts). The run read is not
   fenced against the workflow-server#1044 raise, so it may be stale.
   Because the raise only goes up, a stale read only lowers the stamp, and
   the stamp never exceeds the run's current version or the writer's own
   version: any reader that can read the run can read the event. (The event
   id scheme is chosen by the server from the run it holds, not from this
   field; that part is ServerRaiseProtocol's P3.)

   For a run with no recorded version the two cancel paths still disagree:
   `Run.cancel()` passes no `whenUnknown` (SPEC_VERSION_CURRENT), and
   `cancelRun()` passes SPEC_VERSION_LEGACY. world-postgres stores
   `spec_version` as a nullable column, so a legacy run there reads back
   undefined. Minor, pre-existing in shape, not a brick.
-/

/-! ## 1. #4916: the probe payload and a responder's union -/

/-- The keys a probe payload carries. -/
structure Payload where
  healthCheck : Bool
  runId : Bool        -- the legacy key, also `WorkflowInvokePayloadSchema`'s only required one
  probeRunId : Bool
  deriving DecidableEq, Repr

inductive Parsed | invoke | health | reject
  deriving DecidableEq, Repr

/-- 4.x responders: invoke member first (cannot be fixed on their side). -/
def parse4x (p : Payload) : Parsed :=
  if p.runId then .invoke else if p.healthCheck then .health else .reject

/-- 5.x responders since #3099: health member first. -/
def parse5x (p : Payload) : Parsed :=
  if p.healthCheck then .health else if p.runId then .invoke else .reject

inductive Responder | v4x | v5x
  deriving DecidableEq, Repr

def parse : Responder → Payload → Parsed
  | .v4x => parse4x
  | .v5x => parse5x

/-- The payload a caller sends: before #4916 the run id rode as `runId`. -/
def probePayload (has4916 : Bool) : Payload :=
  if has4916 then ⟨true, false, true⟩ else ⟨true, true, false⟩

/-- The value a target's health responder reports (stable mints 3). -/
def respValue : Responder → Nat
  | .v4x => 3
  | .v5x => 8

/-- Reader capability of the target's code. -/
def targetMax : Responder → Nat
  | .v4x => 3
  | .v5x => 8

/-- #4327's stamp for a cross-deployment start that did not pass an explicit
version: `min(probed, caller)` on an answer, the miss floor 6 otherwise. -/
def stamp (has4916 : Bool) (r : Responder) (caller : Nat) : Nat :=
  if parse r (probePayload has4916) == .health then min (respValue r) caller else 6

def runnable (r : Responder) (s : Nat) : Bool := decide (s ≤ targetMax r)

def callers : List Nat := [6, 7, 8]

/-- Before #4916 a 4.x responder never answers the probe: it reads it as an invoke. -/
theorem pre4916_v4x_reads_invoke : parse .v4x (probePayload false) = .invoke := by decide

/-- ... so every #4327 caller stamps the miss floor into a 4.x target and the
run can never run there, on every start, not only on a slow probe. -/
theorem pre4916_v4x_always_bricks :
    callers.all (fun c => stamp false .v4x c == 6 && !runnable .v4x (stamp false .v4x c)) = true := by
  decide

/-- With #4916 the 4.x responder answers, and the stamp is its own version. -/
theorem post4916_v4x_answers :
    callers.all (fun c => stamp true .v4x c == 3 && runnable .v4x (stamp true .v4x c)) = true := by
  decide

/-- 5.x responders answer both spellings: #4916 is backward compatible. -/
theorem v5x_answers_both :
    [false, true].all (fun h => parse .v5x (probePayload h) == .health) = true := by decide

/-- And a 5.x target is never bricked by the stamp, with or without #4916. -/
theorem v5x_runnable_both :
    [false, true].all (fun h => callers.all fun c => runnable .v5x (stamp h .v5x c)) = true := by
  decide

/-! ## 2. #4415: `specVersionForRunWrite` against a concurrent raise -/

def SPEC_VERSION_LEGACY : Nat := 1

/-- `specVersionForRunWrite(runSpecVersion, whenUnknown)` for a writer whose
SPEC_VERSION_CURRENT is `cur`. -/
def writeVer (cur : Nat) (runSpec : Option Nat) (whenUnknown : Nat) : Nat :=
  min cur (runSpec.getD whenUnknown)

theorem writeVer_le_cur (cur : Nat) (rs : Option Nat) (w : Nat) : writeVer cur rs w ≤ cur :=
  Nat.min_le_left _ _

theorem writeVer_le_run (cur s w : Nat) : writeVer cur (some s) w ≤ s :=
  Nat.min_le_right _ _

/-- A stale read under a never-lowering raise: the writer read `sRead`, the
run is now at `sNow ≥ sRead`, and a reader that can read the run (its max is
at least `sNow`) can read an event stamped at or below that. -/
theorem stale_read_event_readable (cur sRead sNow readerMax w : Nat)
    (hmono : sRead ≤ sNow) (hread : sNow ≤ readerMax) :
    writeVer cur (some sRead) w ≤ readerMax :=
  Nat.le_trans (writeVer_le_run cur sRead w) (Nat.le_trans hmono hread)

/-- Without the cap (the pre-#4415 `SPEC_VERSION_CURRENT` stamp), a main
writer (8) puts an event the run's own executor (Python SDK: 7; a spec-7
deployment) rejects into a run stamped 7. -/
theorem pre4415_overstamps : (8 : Nat) > 7 ∧ writeVer 8 (some 7) 8 = 7 := by decide

/-- `Run.cancel()` (whenUnknown = CURRENT) and `cancelRun()` (whenUnknown =
LEGACY) disagree on a run with no recorded version (world-postgres's nullable
`spec_version`). -/
theorem cancel_paths_disagree_unknown :
    writeVer 8 none 8 = 8 ∧ writeVer 8 none SPEC_VERSION_LEGACY = 1 := by decide

/-- They agree whenever the run records its version. -/
theorem cancel_paths_agree_known (cur s : Nat) :
    writeVer cur (some s) cur = writeVer cur (some s) SPEC_VERSION_LEGACY := rfl

#eval [false, true].flatMap fun h => [Responder.v4x, .v5x].flatMap fun r => callers.map fun c =>
  s!"has4916={h} target={repr r} caller={c}: parsed={repr (parse r (probePayload h))} stamp={stamp h r c} runnable={runnable r (stamp h r c)}"
