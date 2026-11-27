----------------------------- MODULE ForceClaimGate -----------------------------
(***************************************************************************)
(* The #4193 hook force-claim victim gate against a concurrent mid-run     *)
(* spec-version raise of the victim (workflow-server #1044).               *)
(*                                                                         *)
(* A claimer that finds a hook token held by a victim run reads the        *)
(* victim's PERSISTED spec version and takes the token (writing            *)
(* hook_disposed{forceClaimedBy} into the victim's log) only if the victim *)
(* is terminal/missing or its spec is >= 8; otherwise it gets hook_conflict *)
(* with forceRefusedReason 'victim-spec-version'.  The victim's executor   *)
(* code must understand forceClaimedBy, else its `await hook` stays        *)
(* pending forever ("stranded").                                           *)
(*                                                                         *)
(* Code mapping (action/definition -> code):                               *)
(*  Stamps / Init        start() stamp, #4327 core start.ts:117-138:       *)
(*        versioned probe -> min(probe.specVersion, caller world.spec);    *)
(*        probe miss / no channel -> min(6, caller); explicit              *)
(*        opts.specVersion wins UNCAPPED (start.ts:587-588).  The probe    *)
(*        reply is the target World's specVersion = mintedSpecVersion()    *)
(*        (helpers.ts:154-210, world-vercel index.ts:42).  Caller World in *)
(*        [6, MAX] (world-compatibility.ts:36-56).                         *)
(*  Minted               mintedSpecVersion(): main 8, or 6 with            *)
(*        WORKFLOW_SEALED_LOG=0 (spec-version.ts:170-176 on main); #4327    *)
(*        head 7 or 6.  Always <= that code's MAX_SUPPORTED.               *)
(*  VictimCode / Understands  the victim deployment's code: main (MAX 8)   *)
(*        reads forceClaimedBy (core workflow/hook.ts:533,                 *)
(*        quickjs-runtime.ts:2557); #4327 head 764eafd1a (MAX 7) has no     *)
(*        occurrence of forceClaimedBy in packages/core/src.  v5 core does  *)
(*        NOT refuse a run stamped above its MAX on world-vercel            *)
(*        (requiresNewerWorld only in world-local/postgres storage).       *)
(*  RunStarted(m)        #4366 executorSpecVersion = m (world-vercel        *)
(*        events.ts:765-770); #1044 raise run-spec-version-upgrade.ts:96-182*)
(*        with requiresFreshLog = crosses 6 or 7 (99-109); a 7->8 raise is  *)
(*        allowed at any time before terminal, including while the victim  *)
(*        holds a hook.  Status pending->running events.ts:2376-2415.       *)
(*  CreateHook           hook_created on the running victim.                *)
(*  ClaimRead            forceClaimHook.victimRun: plain ConsistentRead get *)
(*        in the victim's region, events.ts:6060-6076 (NOT in a            *)
(*        transaction with the disposal write).                            *)
(*  ClaimDecide          gate events.ts:6077-6097: victimTerminal ||        *)
(*        understandsForcedHookDisposal(spec ?? 1) (version-utils.ts:166,  *)
(*        v >= 8) -> take; else conflict 'victim-spec-version'.  world-local*)
(*        events-storage.ts:2389-2431 and world-postgres storage.ts:        *)
(*        2305-2402 implement the same decision (postgres under FOR UPDATE)*)
(*  ClaimRetry           the claimer's SDK retrying after a conflict.       *)
(*  VictimTerminate      run_completed/failed/cancelled.                    *)
(*                                                                         *)
(*  SRead/SApply (StaleStart) a second run_started request whose fetch     *)
(*        (SRead, events.ts:8019-8055, EC / preloaded) snapshots the run   *)
(*        and whose state patch (SApply, events.ts:2376-2415) has no       *)
(*        .where: a snapshot 'pending' patches running even over a         *)
(*        terminal run. FixGuardStart = the proposed status == pending     *)
(*        guard.                                                           *)
(*  disposed             a take from a LIVE victim writes                  *)
(*        hook_disposed{forceClaimedBy} into the victim's log              *)
(*        (journalForcedDisposal, events.ts:6286-6303); a take from a      *)
(*        terminal victim writes nothing there ('A finished victim has no  *)
(*        reader to strand', events.ts:6082-6090).                         *)
(*  CliReuse             the stamp may also be a persisted version of an   *)
(*        earlier run of the same deployment: CLI wf inspect replay on a   *)
(*        probe miss / plain-text reply (cli inspect/run.ts:87-109) and    *)
(*        recreateRunFromExisting same-deployment (core runtime/runs.ts:   *)
(*        83-130) reuse run.specVersion uncapped. Reachable persisted      *)
(*        versions = Stamps \cup Minted (a raise only reaches a minted     *)
(*        value).                                                          *)
(*                                                                         *)
(* Revision 2: terminal is no longer assumed absorbing (StaleStart), the   *)
(* stable-victim x explicit-stamp combination and the CLI-reuse stamps are *)
(* configured, and NoStrandedVictim also covers a take from a terminal     *)
(* victim that is later resurrected (no disposal row in its log).          *)
(***************************************************************************)
EXTENDS Integers, TLC

CONSTANTS
  VictimCode,      \* MAX_SUPPORTED of the victim deployment's code
  Minted,          \* versions that deployment's processes may mint
  CallerWorlds,    \* declared specVersion of callers' Worlds
  ExplicitStamps,  \* explicit opts.specVersion values ({} = none)
  GateThreshold,   \* 8 = SPEC_VERSION_HOOK_FORCE_CLAIM; any other value is a MUTANT
  CliReuse,        \* BOOLEAN: stamps may reuse a persisted version (see above)
  StaleStart,      \* BOOLEAN: a second, stale run_started request exists
  FixGuardStart    \* BOOLEAN: run_started patch guarded on status == pending

ASSUME \A m \in Minted : m <= VictimCode

Min(a, b) == IF a < b THEN a ELSE b

ProbeStamps ==
  {Min(m, cw) : m \in Minted, cw \in CallerWorlds}   \* versioned probe reply
  \cup {Min(6, cw) : cw \in CallerWorlds}             \* probe miss / no channel

Stamps0 == ProbeStamps \cup ExplicitStamps
Stamps == IF CliReuse THEN Stamps0 \cup Minted ELSE Stamps0

Understands == VictimCode >= 8

\* #1044 run-spec-version-upgrade.ts:99-104
RequiresFresh(from, to) ==
  (from < 6 /\ 6 <= to) \/ (from < 7 /\ 7 <= to)

VARIABLES vStatus, vSpec, token, claim, snap, outcome, stamp, raisedLive,
          disposed, sPc, sSnap, sM
vars == <<vStatus, vSpec, token, claim, snap, outcome, stamp, raisedLive,
          disposed, sPc, sSnap, sM>>
SVars == <<disposed, sPc, sSnap, sM>>

TypeOK ==
  /\ vStatus \in {"pending", "running", "terminal"}
  /\ vSpec \in Int
  /\ token \in {"none", "victim", "claimer"}
  /\ claim \in {"idle", "read", "done"}
  /\ snap \in [status : {"none", "pending", "running", "terminal"}, spec : Int]
  /\ outcome \in {"none", "taken", "conflict"}
  /\ raisedLive \in BOOLEAN
  /\ disposed \in BOOLEAN
  /\ sPc \in {"idle", "read", "done"}

Init ==
  /\ vStatus = "pending"
  /\ vSpec \in Stamps
  /\ stamp = vSpec
  /\ token = "none"
  /\ claim = "idle"
  /\ snap = [status |-> "none", spec |-> 0]
  /\ outcome = "none"
  /\ raisedLive = FALSE
  /\ disposed = FALSE
  /\ sPc = IF StaleStart THEN "idle" ELSE "done"
  /\ sSnap = [status |-> "none", spec |-> 0]
  /\ sM = 0

RunStarted(m) ==
  /\ vStatus /= "terminal"
  /\ LET raise == /\ vSpec >= 2               \* legacy routed away, events.ts:8033
                  /\ m > vSpec                \* 'not-newer'
                  /\ (~RequiresFresh(vSpec, m) \/ vStatus = "pending")
     IN /\ vSpec' = IF raise THEN m ELSE vSpec
        /\ raisedLive' = (raisedLive \/ (raise /\ vStatus = "running"))
  /\ vStatus' = "running"
  /\ UNCHANGED <<token, claim, snap, outcome, stamp>>
  /\ UNCHANGED SVars

\* StaleStart: the second request's fetch ...
SRead(m) ==
  /\ sPc = "idle"
  /\ sSnap' = [status |-> vStatus, spec |-> vSpec]
  /\ sM' = m
  /\ sPc' = "read"
  /\ UNCHANGED <<vStatus, vSpec, token, claim, snap, outcome, stamp,
                 raisedLive, disposed>>

\* ... and, later, its upgrade (conditions on the CURRENT row, upgrade.ts:
\* 124-182, entered only if the snapshot passed the pre-checks 96-109) and
\* its state transition (decided on the SNAPSHOT status, no .where).
SApply ==
  /\ sPc = "read"
  /\ LET s == sSnap
         tryRaise == /\ s.status /= "terminal" /\ s.spec >= 2 /\ sM > s.spec
                     /\ (~RequiresFresh(s.spec, sM) \/ s.status = "pending")
         raise == /\ tryRaise /\ vSpec = s.spec /\ vStatus /= "terminal"
                  /\ (~RequiresFresh(vSpec, sM) \/ vStatus = "pending")
         patch == /\ s.status = "pending"
                  /\ (FixGuardStart => vStatus = "pending")
     IN /\ vSpec' = IF raise THEN sM ELSE vSpec
        /\ raisedLive' = (raisedLive \/ (raise /\ vStatus = "running"))
        /\ vStatus' = IF patch THEN "running" ELSE vStatus
  /\ sPc' = "done"
  /\ UNCHANGED <<token, claim, snap, outcome, stamp, disposed, sSnap, sM>>

CreateHook ==
  /\ vStatus = "running"
  /\ token = "none"
  /\ token' = "victim"
  /\ UNCHANGED <<vStatus, vSpec, claim, snap, outcome, stamp, raisedLive>>
  /\ UNCHANGED SVars

VictimTerminate ==
  /\ vStatus /= "terminal"
  /\ vStatus' = "terminal"
  /\ UNCHANGED <<vSpec, token, claim, snap, outcome, stamp, raisedLive>>
  /\ UNCHANGED SVars

ClaimRead ==
  /\ claim = "idle"
  /\ token = "victim"
  /\ snap' = [status |-> vStatus, spec |-> vSpec]
  /\ claim' = "read"
  /\ UNCHANGED <<vStatus, vSpec, token, outcome, stamp, raisedLive>>
  /\ UNCHANGED SVars

ClaimDecide ==
  /\ claim = "read"
  /\ IF snap.status = "terminal" \/ snap.spec >= GateThreshold
       THEN /\ token' = "claimer"
            /\ outcome' = "taken"
            /\ disposed' = (snap.status /= "terminal")  \* row only for a live victim
       ELSE /\ token' = token
            /\ outcome' = "conflict"
            /\ UNCHANGED disposed
  /\ claim' = "done"
  /\ UNCHANGED <<vStatus, vSpec, snap, stamp, raisedLive, sPc, sSnap, sM>>

ClaimRetry ==
  /\ claim = "done"
  /\ outcome = "conflict"
  /\ claim' = "idle"
  /\ outcome' = "none"
  /\ UNCHANGED <<vStatus, vSpec, token, snap, stamp, raisedLive>>
  /\ UNCHANGED SVars

Next ==
  \/ \E m \in Minted : RunStarted(m)
  \/ \E m \in Minted : SRead(m)
  \/ SApply
  \/ CreateHook \/ VictimTerminate
  \/ ClaimRead \/ ClaimDecide \/ ClaimRetry
  \/ UNCHANGED vars      \* quiescence is not a deadlock

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* A token is never held by the claimer while the victim is live and its  *)
(* reader cannot learn that: the victim's code cannot interpret            *)
(* hook_disposed{forceClaimedBy}, or no such row was written because the   *)
(* take happened while the victim was terminal (then resurrected).         *)
NoStrandedVictim ==
  ~(token = "claimer" /\ vStatus /= "terminal" /\ (~Understands \/ ~disposed))

TerminalAbsorbing == [][vStatus = "terminal" => vStatus' = "terminal"]_vars

(* The premise the gate relies on: a live run's persisted spec >= 8 implies *)
(* its executor code understands forceClaimedBy.                           *)
GateSound == (vStatus /= "terminal" /\ vSpec >= 8) => Understands

Monotone == [][vSpec' >= vSpec]_vars

(* Reachability witnesses (EXPECTED to be violated; a violation shows the  *)
(* interleaving exists and the other invariants still hold on it).         *)
\* claimer read spec 7, the victim was raised 7->8 while running, the claim
\* was refused: conservative outcome.
W_ReadThenRaise_Refused ==
  ~(outcome = "conflict" /\ snap.spec = 7 /\ vSpec = 8 /\ vStatus = "running")
\* the victim was raised while running and then its token was taken.
W_RaiseThenTake ==
  ~(outcome = "taken" /\ raisedLive /\ vStatus = "running")
=============================================================================
