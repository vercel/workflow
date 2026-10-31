---------------------------- MODULE RolloutSkew ----------------------------
(***************************************************************************)
(* Server rollout skew for workflow-server#1044 (and its proposed fixes).  *)
(*                                                                         *)
(* No other model has two SERVER code versions serving one run at once.   *)
(* workflow-server is itself a Vercel deployment: during promotion (and    *)
(* rollback) requests already in flight on the previous deployment finish  *)
(* there, and before the alias switch some regions/instances can still be  *)
(* on the old build. A run_started or run_cancelled that started on the   *)
(* old build runs the OLD code path to completion.                         *)
(*                                                                         *)
(*  old  = workflow-server origin/main (pre-#1044): no upgrade call, id    *)
(*         mode from the run it read (events.ts resolveEventId(run.spec)), *)
(*         unconditional run_started patch (events.ts:2376-2415), ULID-mode *)
(*         run_cancelled patch guarded only on non-terminal (2588-2650).    *)
(*         Unknown frame-meta keys (executorSpecVersion) are ignored by     *)
(*         parseV4EventMeta (origin/main lib/handlers/v4/headers.ts:514+,   *)
(*         no unknown-key check), so #4366 is safe to ship first.           *)
(*  new  = #1044 (d0575db): upgrade on run_started (check+head+tx, skips    *)
(*         return the input run), same patch/insert code as old.            *)
(*  new+Fixes = #1044 + P4 (CAS run_started patch, re-resolve id on         *)
(*         failure) + P3 (terminal ULID patch conditioned on spec==held).   *)
(*                                                                         *)
(* One run, stamped 3 by a stable caller (ULID run_created), executor      *)
(* attests 8 (#4366 on main). Two run_started requests and one            *)
(* run_cancelled. Each request is bound to the server build it landed on  *)
(* for its whole life. Reads may be eventually consistent (any committed   *)
(* row version since the last Settle).                                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Fixes,         \* new build carries P3+P4 (+re-resolve)
  Gate,          \* "none": raise live as soon as a request lands on new;
                 \* "flag": raise behind a server flag an operator turns on
  InitPhase,     \* "old" | "mixed" | "new"
  AllowRollback, \* deploy may go new -> mixed -> old
  RollbackNeedsSettle, \* rollback only after flag off AND EC reads converged
  StaleReads

Stamp == 3
Exec  == 8
Kind(sp) == IF sp >= 6 THEN "S" ELSE "U"
Terminal == {"cancelled"}
Starters == {"s1", "s2"}
Reqs == Starters \cup {"k"}

VARIABLES row, hist, log, phase, flag, req
vars == <<row, hist, log, phase, flag, req>>

Row(st, sp) == [st |-> st, sp |-> sp]
Ev(t, k) == [t |-> t, k |-> k]

Init ==
  /\ row = Row("pending", Stamp)
  /\ hist = {Row("pending", Stamp)}
  /\ log = << Ev("rc", "U") >>
  /\ phase = InitPhase
  /\ flag = (Gate = "flag" /\ InitPhase = "new")
  /\ req = [r \in Reqs |-> [pc |-> "idle", ver |-> "none",
                            held |-> Row("pending", Stamp), kind |-> "U"]]

\* A committed row write, recorded for later stale reads.
Commit(r2) == /\ row' = r2 /\ hist' = hist \cup {r2}

Readable == IF StaleReads THEN hist \cup {row} ELSE {row}
RaiseLive(v) == v = "new" /\ (Gate = "none" \/ flag)
Fixed(v) == v = "new" /\ Fixes
InFlightOld == \E r \in Reqs : req[r].ver = "old" /\ req[r].pc \notin {"idle", "done"}

-------------------------------------------------------------------------
(* Deploy / operator actions *)
Forward ==
  /\ \/ phase = "old" /\ phase' = "mixed"
     \/ phase = "mixed" /\ phase' = "new"
  /\ UNCHANGED <<row, hist, log, flag, req>>

Rollback ==
  /\ AllowRollback
  /\ ~flag
  /\ RollbackNeedsSettle => hist = {row}
  /\ \/ phase = "new" /\ phase' = "mixed"
     \/ phase = "mixed" /\ phase' = "old"
  /\ UNCHANGED <<row, hist, log, flag, req>>

FlagOn ==
  /\ Gate = "flag" /\ ~flag /\ phase = "new" /\ ~InFlightOld
  /\ flag' = TRUE
  /\ UNCHANGED <<row, hist, log, phase, req>>

FlagOff ==
  /\ flag /\ flag' = FALSE
  /\ UNCHANGED <<row, hist, log, phase, req>>

\* Eventually consistent reads converge.
Settle ==
  /\ hist # {row} /\ hist' = {row}
  /\ UNCHANGED <<row, log, phase, flag, req>>

-------------------------------------------------------------------------
(* Request begins on whichever build serves it, and reads the run. *)
Begin(r) ==
  /\ req[r].pc = "idle"
  /\ \E v \in (CASE phase = "old" -> {"old"}
               [] phase = "new" -> {"new"}
               [] OTHER -> {"old", "new"}) :
     \E h \in Readable :
       req' = [req EXCEPT ![r] = [pc |-> IF h.st \in Terminal THEN "done"
                                         ELSE IF r = "k" THEN "kpatch" ELSE "upg",
                                  ver |-> v, held |-> h, kind |-> "U"]]
  /\ UNCHANGED <<row, hist, log, phase, flag>>

Set(r, f) == req' = [req EXCEPT ![r] = f]

(* #1044 upgrade: pre-read checks on the held run, consistent head read,  *)
(* conditional tx; skips hand back the held (possibly stale) run.          *)
Upg(r) ==
  LET q == req[r] IN
  /\ r \in Starters /\ q.pc = "upg"
  /\ IF RaiseLive(q.ver) /\ Exec > q.held.sp /\ q.held.st = "pending"
        /\ Len(log) = 1 /\ log[1].t = "rc" /\ log[1].k = "U"   \* fresh head
     THEN IF row.sp = q.held.sp /\ row.st = "pending"          \* tx condition
          THEN /\ Commit(Row("pending", Exec))
               /\ log' = << Ev("rc", "S") >>                      \* rekey rc -> slot 1
               /\ Set(r, [q EXCEPT !.pc = "patch", !.held = Row("pending", Exec)])
          ELSE /\ Set(r, [q EXCEPT !.pc = "patch", !.held = row]) \* lost race: reread
               /\ UNCHANGED <<row, hist, log>>
     ELSE /\ Set(r, [q EXCEPT !.pc = "patch"])                  \* skip: stale held
          /\ UNCHANGED <<row, hist, log>>
  /\ UNCHANGED <<phase, flag>>

(* handleRunStateTransition(run_started). *)
Patch(r) ==
  LET q == req[r] IN
  /\ r \in Starters /\ q.pc = "patch"
  /\ IF q.held.st = "running"
     THEN /\ Set(r, [q EXCEPT !.pc = "done"])                    \* alreadyRunning
          /\ UNCHANGED <<row, hist>>
     ELSE IF ~Fixed(q.ver)
          THEN /\ Commit(Row("running", row.sp))                  \* unconditional
               /\ Set(r, [q EXCEPT !.pc = "ins", !.kind = Kind(q.held.sp)])
          ELSE IF row.st = "pending" /\ row.sp = q.held.sp        \* P4 CAS
               THEN /\ Commit(Row("running", row.sp))
                    /\ Set(r, [q EXCEPT !.pc = "ins", !.kind = Kind(q.held.sp)])
               ELSE /\ UNCHANGED <<row, hist>>                     \* reread, re-resolve
                    /\ Set(r, [q EXCEPT !.held = row,
                                  !.pc = IF row.st \in Terminal \/ row.st = "running"
                                         THEN "done" ELSE "patch"])
  /\ UNCHANGED <<log, phase, flag>>

Ins(r) ==
  LET q == req[r] IN
  /\ q.pc = "ins"
  /\ log' = Append(log, Ev(IF r = "k" THEN "rx" ELSE "rs", q.kind))
  /\ Set(r, [q EXCEPT !.pc = "done"])
  /\ UNCHANGED <<row, hist, phase, flag>>

(* run_cancelled: slot mode is one tx (commitRunPatchWithEvent); ULID     *)
(* mode is a guarded patch then a separate insert.                         *)
KPatch ==
  LET q == req["k"] IN
  /\ q.pc = "kpatch"
  /\ IF row.st \in Terminal
     THEN /\ Set("k", [q EXCEPT !.pc = "done"]) /\ UNCHANGED <<row, hist, log>>
     ELSE IF Fixed(q.ver) /\ row.sp # q.held.sp                   \* P3: reread, retry
          THEN /\ Set("k", [q EXCEPT !.held = row]) /\ UNCHANGED <<row, hist, log>>
          ELSE /\ Commit(Row("cancelled", row.sp))
               /\ IF Kind(q.held.sp) = "S"
                  THEN /\ log' = Append(log, Ev("rx", "S"))
                       /\ Set("k", [q EXCEPT !.pc = "done"])
                  ELSE /\ UNCHANGED log
                       /\ Set("k", [q EXCEPT !.pc = "ins", !.kind = "U"])
  /\ UNCHANGED <<phase, flag>>

Next ==
  \/ Forward \/ Rollback \/ FlagOn \/ FlagOff \/ Settle
  \/ \E r \in Reqs : Begin(r) \/ Upg(r) \/ Patch(r) \/ Ins(r)
  \/ KPatch

Spec == Init /\ [][Next]_vars

-------------------------------------------------------------------------
TypeOK ==
  /\ row.st \in {"pending", "running", "cancelled"}
  /\ row.sp \in {Stamp, Exec}
  /\ phase \in {"old", "mixed", "new"}

\* A run persisted at >= 6 must carry only slot ids (probeMaxSlot 500s and
\* the v5 replay's requireEventSlot throws otherwise).
NoMixedIdentityLog == row.sp >= 6 => \A i \in 1..Len(log) : log[i].k = "S"

TerminalAbsorbing == [][row.st \in Terminal => row'.st \in Terminal]_vars

\* Reachability witness: the run does get raised (so passes are not vacuous).
NeverRaised == row.sp = Stamp
=============================================================================
