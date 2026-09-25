----------------------------- MODULE SharedPool -----------------------------
(***************************************************************************)
(* world-postgres (and a shared world-local data dir) during a rolling     *)
(* upgrade or rollback of a self-hosted app: several app builds share ONE  *)
(* database and ONE queue.                                                 *)
(*                                                                         *)
(* Facts this model rests on (workflow @ 764eafd1a / origin/main):         *)
(*  * getDeploymentId() is the constant 'postgres' (world-postgres         *)
(*    queue.ts:369-371); the queue ignores deploymentId, so ANY worker of   *)
(*    the pool consumes any message, including the health-check probe.     *)
(*    A start() with deploymentId other than 'postgres' takes #4327's      *)
(*    cross-deployment path and probes whichever worker answers.           *)
(*  * world.specVersion = mintedSpecVersion() (world-postgres index.ts:77): *)
(*    6 with WORKFLOW_SEALED_LOG=0, else the World package's CURRENT.       *)
(*  * core accepts a World iff 6 <= world.specVersion <= core MAX          *)
(*    (runtime/world-compatibility.ts:37-56).                              *)
(*  * Every event that fetches the run is refused with RunNotSupportedError *)
(*    iff run.specVersion > SPEC_VERSION_MAX_SUPPORTED of the WORLD         *)
(*    package's copy of @workflow/world (spec-version.ts:192-195, storage.ts *)
(*    :1175) - not core's MAX. The error is not classified specially, so    *)
(*    the message is redelivered (attempt+1) up to MAX_DELIVERIES, then the *)
(*    runtime writes run_failed MAX_DELIVERIES_EXCEEDED (runtime.ts:817-875).*)
(*  * Each new wake (step done, hook, sleep) is a new message: attempt = 1. *)
(*                                                                         *)
(* A worker profile is [core |-> reader MAX, wpkg |-> World package MAX,   *)
(* ks |-> kill switch on]. "Unsafe execution" = a worker replays a run     *)
(* whose spec exceeds its core MAX (it cannot read e.g. forceClaimedBy).   *)
(*                                                                         *)
(* ProbeCache (#4327 @ 29197a10f start.ts:250-320): the caller process     *)
(* keeps a probe answer for 10 min per (World, namespace, deploymentId);   *)
(* the code comment says the bound exists for Worlds whose deployment id  *)
(* can be reused by a restarted process with different code, which is    *)
(* this pool ('postgres'). With ProbeCache the Start may use an answer    *)
(* from a worker live in ANY phase visited before it (rollouts within the *)
(* TTL), not only the current one. That needs a caller process that       *)
(* outlives the phase change (a separate service on the new World: a new- *)
(* build caller inside the pool dies with the rollback, taking its cache   *)
(* with it; an old-build caller caps the answer at its own version).       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS OldCore, OldWpkg, OldKs, NewCore, NewWpkg, NewKs,
          CallerIsNew,   \* the caller (a web route or a step) runs the new build
          Kind,          \* "same" (deploymentId unset / 'postgres') | "cross"
          StampRule,     \* "pre4327" (world.specVersion) | "4327" (min(probe, caller))
          MaxDel, Segments,
          AllowRollback,
          FastRollout,   \* refusals never exhaust MAX_DELIVERIES (rollout < ~9h)
          ProbeCache     \* #4327 @ 29197a10f probe cache (see header)

OldP == [core |-> OldCore, wpkg |-> OldWpkg, ks |-> OldKs]
NewP == [core |-> NewCore, wpkg |-> NewWpkg, ks |-> NewKs]
CallerP == IF CallerIsNew THEN NewP ELSE OldP

Declared(p) == IF p.ks THEN 6 ELSE p.wpkg
Compat(p)   == 6 <= Declared(p) /\ Declared(p) <= p.core
Gate(p, s)  == s <= p.wpkg
Min(a, b)   == IF a < b THEN a ELSE b

Pool(ph) == CASE ph = "old" -> {OldP} [] ph = "new" -> {NewP} [] OTHER -> {OldP, NewP}
Live(ph) == {p \in Pool(ph) : Compat(p)}   \* incompatible builds crash at boot

VARIABLES phase, status, stamp, seg, att, bad,
          seen,     \* phases visited before Start (whose workers may have answered a cached probe)
          rolled,   \* a rollback happened before Start
          sph       \* phase at Start
vars == <<phase, status, stamp, seg, att, bad, seen, rolled, sph>>

Init == /\ phase \in {"old", "mixed", "new"}
        /\ status = "init" /\ stamp = 0 /\ seg = 0 /\ att = 0 /\ bad = FALSE
        /\ seen = {phase} /\ rolled = FALSE /\ sph = "none"

Answerers == IF ProbeCache THEN UNION {Live(ph) : ph \in seen} ELSE Live(phase)

Stamps ==
  IF Kind = "same" \/ StampRule = "pre4327" THEN {Declared(CallerP)}
  ELSE {Min(Declared(w), Declared(CallerP)) : w \in Answerers}    \* probe answered (or cached)
       \cup {Min(6, Declared(CallerP))}                            \* probe miss

Start == /\ status = "init" /\ Compat(CallerP)
         /\ \E s \in Stamps : stamp' = s
         /\ status' = "running" /\ att' = 1 /\ sph' = phase
         /\ UNCHANGED <<phase, seg, bad, seen, rolled>>

Deliver ==
  /\ status = "running"
  /\ IF att > MaxDel
     THEN /\ status' = "failed" /\ UNCHANGED <<stamp, seg, att, bad>>   \* MAX_DELIVERIES
     ELSE \E w \in Live(phase) :
            IF ~Gate(w, stamp)
            THEN /\ ~FastRollout \/ att + 1 <= MaxDel
                 /\ att' = att + 1 /\ UNCHANGED <<status, stamp, seg, bad>>
            ELSE /\ bad' = (bad \/ stamp > w.core)
                 /\ seg' = seg + 1 /\ att' = 1
                 /\ status' = IF seg + 1 = Segments THEN "done" ELSE "running"
                 /\ UNCHANGED stamp
  /\ UNCHANGED <<phase, seen, rolled, sph>>

Track == /\ seen' = IF status = "init" THEN seen \cup {phase'} ELSE seen
         /\ UNCHANGED sph
Forward  == /\ \/ phase = "old" /\ phase' = "mixed"
               \/ phase = "mixed" /\ phase' = "new"
            /\ Track /\ UNCHANGED rolled
            /\ UNCHANGED <<status, stamp, seg, att, bad>>
Rollback == /\ AllowRollback
            /\ \/ phase = "new" /\ phase' = "mixed"
               \/ phase = "mixed" /\ phase' = "old"
            /\ Track /\ rolled' = (rolled \/ status = "init")
            /\ UNCHANGED <<status, stamp, seg, att, bad>>

Next == Start \/ Deliver \/ Forward \/ Rollback
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Deliver) /\ WF_vars(Forward)

SafeExec == ~bad
EventuallyDone == <>(status = "done")
EventuallyFinal == <>(status \in {"done", "failed"})
\* A run stamped at or below the old build's gate survives any rollback.
LowStampCompletes == [](status = "running" /\ stamp <= OldWpkg => <>(status = "done"))
\* A start made after a rollback back to the old build is stamped for a
\* version the old build's World can gate in (what the probe would answer now).
PostRollbackStampFits == (status # "init" /\ rolled /\ sph = "old") => stamp <= OldWpkg
=============================================================================
