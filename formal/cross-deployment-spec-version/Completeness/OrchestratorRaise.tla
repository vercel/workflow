-------------------------- MODULE OrchestratorRaise --------------------------
(***************************************************************************)
(* The #1044 raise against spec 9 (single orchestrator, API v5).           *)
(*                                                                         *)
(* workflow-server main (192fd8a) defines SPEC_VERSION_SINGLE_ORCHESTRATOR *)
(* = 9 (lib/version-utils.ts:123) and lists it as structural (:153). A    *)
(* spec-9 run is writable only through apiVersion 5; a v2-v4 write to one *)
(* gets 400 'spec-version-requires-api-v5' (lib/data/events.ts:2187-2194, *)
(* batch :11840-11846). The upgrade (run-spec-version-upgrade.ts, the same *)
(* code #1044 shipped) treats a structural crossing as "needs pending and  *)
(* a log of exactly run_created": 8 -> 9 on a fresh log is ALLOWED. The    *)
(* comment "a run never crosses into it" (version-utils.ts:120) is not     *)
(* enforced on the server. Nothing caps executorSpecVersion either        *)
(* (v4/headers.ts:643 accepts up to 1000).                                 *)
(*                                                                         *)
(* On the client, vercel/workflow#4661 (open, peter/single-orchestrator)   *)
(* picks the orchestrator from the run's version as start() stamped it    *)
(* (core runtime.ts orchestratorForSpecVersion; the first delivery, which  *)
(* carries runInput, is never handed on, delivery.ts:115-160) and caps the *)
(* attestation: executorSpecVersionFor(run_started.specVersion, world) =   *)
(* world if that is >= 9, else min(world, 8) (world-vercel events.ts).     *)
(* The spec-8 orchestrator writes run_started with runInput.specVersion    *)
(* ?? 8, so a run below 9 attests at most 8.                               *)
(*                                                                         *)
(* This model checks what happens to ONE run when an executor attests 9   *)
(* for a run stamped below 9, and when an explicit stamp of 9 reaches a   *)
(* deployment without the single orchestrator.                             *)
(*                                                                         *)
(*  Caller   run_created at the stamp: below 9 over v4 (row + run_created  *)
(*           atomic, #1061); 9 only from a #4661 caller, over v5 (its      *)
(*           start() asserts the in-band fence). A v4 run_created stamped  *)
(*           9 is refused (events.ts:2156-2158) and is not modelled.       *)
(*           It may fail before writing (resilient start).                 *)
(*  Exec[d]  deliveries of the first message. Orchestrator = 9 iff the     *)
(*           stamp is >= 9 AND the target has the single orchestrator;     *)
(*           api = 5 iff orchestrator 9. Attestation per CapAttest.        *)
(*           run_started: missing row -> resilient start at                *)
(*           max(stamp, attest) (events.ts:9346-9352); a created spec-9    *)
(*           run is handed to the v5 path (:9590-9595), which answers a v4  *)
(*           request 400 'v5-missing-in-band' (v5/events.ts:224-231) after *)
(*           the row and run_created have committed. Existing row: routed  *)
(*           by its persisted version (events.ts:2141-2194), then the       *)
(*           upgrade, then run_started on the path chosen BEFORE the raise. *)
(*           Then one step write and run_completed, over the orchestrator's *)
(*           api.                                                          *)
(*                                                                         *)
(* Fix toggles                                                              *)
(*   CapAttest          #4661's executorSpecVersionFor (c34918395).          *)
(*   ServerCaps9        proposed: the upgrade never raises a run into 9     *)
(*                      (min(attest, 8) for a run below 9), in the upgrade *)
(*                      and in resilient start.                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Stamps,          \* caller stamps, e.g. {3, 6, 8, 9}
  WorldMints,      \* executor World's minted version, e.g. {8, 9}
  TargetHasSO,     \* the target deployment runs #4661 (single orchestrator)
  CapAttest,       \* #4661 executorSpecVersionFor
  ServerCaps9,     \* proposed server hardening
  CallerMayFail,   \* run_created may fail before writing, or land after a
                   \* delivery (resilient start); FALSE: it always lands first
  D,               \* delivery ids
  MaxAttempts

SO == 9
Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b
Structural == {2, 6, 7, 9}
Crosses(a, b) == \E v \in Structural : a < v /\ v <= b

VARIABLES
  stamp, mint,  \* chosen in Init
  row,          \* [ex, st, sp]
  log,          \* set of [t, path] (path: "v4" = pre-v5 write, "v5")
  cpc,          \* caller pc
  epc, eatt,    \* deliveries
  refused,      \* some write was answered 400 (an api/version mismatch)
  mismatch      \* some write came from the orchestrator of another version
vars == <<stamp, mint, row, log, cpc, epc, eatt, refused, mismatch>>

\* The orchestrator, api and attestation are fixed by the first message.
Orch == IF stamp >= SO /\ TargetHasSO THEN 9 ELSE 8
Api == IF Orch = 9 THEN 5 ELSE 4
\* run_started.specVersion = runInput.specVersion (the stamp) on the first
\* message; executorSpecVersionFor caps a run below 9 at 8.
Attest == IF CapAttest /\ stamp < SO THEN Min(mint, 8) ELSE mint
\* The version the server takes from the attestation for a run at `sp`.
Eff(sp) == IF ServerCaps9 /\ sp < SO THEN Min(Attest, 8) ELSE Attest

Init ==
  /\ stamp \in Stamps
  /\ mint \in WorldMints
  \* a World that mints 9 is a #4661 World; a main World mints at most 8
  /\ (mint >= SO) => TargetHasSO
  /\ row = [ex |-> FALSE, st |-> "none", sp |-> 0]
  /\ log = {}
  /\ cpc = "create"
  /\ epc = [d \in D |-> "start"]
  /\ eatt = [d \in D |-> 1]
  /\ refused = FALSE
  /\ mismatch = FALSE

CallerCreate ==
  /\ cpc = "create"
  /\ \/ /\ CallerMayFail /\ UNCHANGED <<row, log>>
     \/ /\ row.ex /\ UNCHANGED <<row, log>>             \* 409
     \/ /\ ~row.ex
        /\ row' = [ex |-> TRUE, st |-> "pending", sp |-> stamp]
        /\ log' = {[t |-> "run_created", path |-> IF stamp >= SO THEN "v5" ELSE "v4"]}
  /\ cpc' = "done"
  /\ UNCHANGED <<stamp, mint, epc, eatt, refused, mismatch>>

Retry(d) ==   \* the queue redelivers the first message, or gives up
  /\ IF eatt[d] < MaxAttempts
     THEN /\ epc' = [epc EXCEPT ![d] = "start"]
          /\ eatt' = [eatt EXCEPT ![d] = eatt[d] + 1]
     ELSE /\ epc' = [epc EXCEPT ![d] = "gaveup"]
          /\ UNCHANGED eatt

\* A write over `Api` to a run whose persisted version is `sp`.
ApiOK(sp) == (sp >= SO) => Api = 5
NoteWrite(sp) ==
  /\ refused' = (refused \/ ~ApiOK(sp))
  /\ mismatch' = (mismatch \/ ((Orch = 9) # (sp >= SO)))

ExStart(d) ==
  /\ epc[d] = "start"
  \* without CallerMayFail the caller's run_created always lands first
  /\ row.ex \/ CallerMayFail
  /\ IF ~row.ex
     THEN \* resilient start
          LET cs == Max(stamp, Eff(stamp)) IN
          IF cs >= SO /\ Api # 5
          THEN \* row + run_created committed; the v5 hand-off answers 400
               /\ row' = [ex |-> TRUE, st |-> "pending", sp |-> cs]
               /\ log' = {[t |-> "run_created", path |-> "v4"]}
               /\ refused' = TRUE /\ mismatch' = TRUE
               /\ Retry(d)
          ELSE /\ row' = [ex |-> TRUE, st |-> "running", sp |-> cs]
               /\ log' = {[t |-> "run_created", path |-> "v4"],
                          [t |-> "run_started", path |-> IF cs >= SO THEN "v5" ELSE "v4"]}
               /\ epc' = [epc EXCEPT ![d] = "started"]
               /\ NoteWrite(cs)
               /\ UNCHANGED eatt
     ELSE IF row.st \in {"completed"}
     THEN /\ epc' = [epc EXCEPT ![d] = "done"]          \* 410
          /\ UNCHANGED <<row, log, eatt, refused, mismatch>>
     ELSE IF row.sp >= SO
     THEN \* routed to v5 by the persisted version
          IF Api # 5
          THEN /\ refused' = TRUE /\ mismatch' = TRUE
               /\ Retry(d) /\ UNCHANGED <<row, log>>
          ELSE /\ IF row.st = "pending"
                  THEN /\ row' = [row EXCEPT !.st = "running"]
                       /\ log' = log \cup {[t |-> "run_started", path |-> "v5"]}
                  ELSE UNCHANGED <<row, log>>          \* alreadyRunning
               /\ epc' = [epc EXCEPT ![d] = "started"]
               /\ NoteWrite(row.sp)
               /\ UNCHANGED eatt
     ELSE \* pre-v5 path; the #1044 upgrade, then run_started on THIS path
          LET a == Eff(row.sp)
              fresh == row.st = "pending" /\ log \subseteq {[t |-> "run_created", path |-> "v4"]}
              raise == a > row.sp /\ (Crosses(row.sp, a) => fresh)
              sp2 == IF raise THEN a ELSE row.sp
          IN /\ IF row.st = "pending"
                THEN /\ row' = [row EXCEPT !.sp = sp2, !.st = "running"]
                     /\ log' = log \cup {[t |-> "run_started", path |-> "v4"]}
                ELSE /\ row' = [row EXCEPT !.sp = sp2]
                     /\ UNCHANGED log
             /\ epc' = [epc EXCEPT ![d] = "started"]
             \* run_started itself went through the pre-v5 path, which takes
             \* any api: the version check falls on the writes after it
             /\ mismatch' = (mismatch \/ ((Orch = 9) # (sp2 >= SO)))
             /\ UNCHANGED <<eatt, refused>>
  /\ UNCHANGED <<stamp, mint, cpc>>

\* The workflow body: one step write, then run_completed.
ExStep(d) ==
  /\ epc[d] = "started"
  /\ row.st = "running"
  /\ IF ApiOK(row.sp)
     THEN /\ row' = [row EXCEPT !.st = "completed"]
          /\ log' = log \cup {[t |-> "run_completed", path |-> IF Api = 5 THEN "v5" ELSE "v4"]}
          /\ epc' = [epc EXCEPT ![d] = "done"]
          /\ NoteWrite(row.sp)
          /\ UNCHANGED eatt
     ELSE /\ refused' = TRUE /\ mismatch' = TRUE
          /\ Retry(d) /\ UNCHANGED <<row, log>>
  /\ UNCHANGED <<stamp, mint, cpc>>

ExIdle(d) ==   \* another delivery finished the run
  /\ epc[d] = "started" /\ row.st = "completed"
  /\ epc' = [epc EXCEPT ![d] = "done"]
  /\ UNCHANGED <<stamp, mint, row, log, cpc, eatt, refused, mismatch>>

AllDone == cpc = "done" /\ \A d \in D : epc[d] \in {"done", "gaveup"}

Next ==
  \/ CallerCreate
  \/ \E d \in D : ExStart(d) \/ ExStep(d) \/ ExIdle(d)
  \/ (AllDone /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                              *)
\* No write is answered 400 for its api version: such a run never progresses.
NoApiRefusal == ~refused
\* Every write comes from the orchestrator of the run's own version.
OrchestratorMatchesRun == ~mismatch
\* Once every delivery is done the run has completed.
RunCompletes == AllDone => row.st = "completed"
\* Informational: a spec-9 run's run_started went through the v5 path.
Spec9StartedOnV5 ==
  (row.ex /\ row.sp >= SO) =>
    \A e \in log : e.t = "run_started" => e.path = "v5"
=============================================================================
