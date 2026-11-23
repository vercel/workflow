---- MODULE StreamPurge ----
(* Stream chunk inserts against a run's finish and the deletion of its data
   (src/streamer.ts `insertDataChunks`, src/retention.ts `purgeRunUserData`),
   under Postgres row-lock and snapshot rules. The constants select the
   shipped design or a variant of it; see README.md. *)
EXTENDS FiniteSets
CONSTANTS Writers,   \* concurrent stream inserts
          LockMode,  \* "share" (shipped) | "keyshare" | "main" (before #5687)
          Isolation, \* purge transaction: "RC" | "RR"
          RunFirst   \* purge updates the run row before clearing chunks

VARIABLES status,   \* committed run status: "running" | "done"
          expired,  \* committed expired_at IS NOT NULL
          xlock,    \* uncommitted updater of the run row: "none"|"finish"|"purge"
          share,    \* writers holding FOR SHARE on the run row
          wpc, wsaw, chunk, ppc, psnap, pcleared, fpc
vars == <<status, expired, xlock, share, wpc, wsaw, chunk, ppc, psnap, pcleared, fpc>>

Live == {w \in Writers : chunk[w] = "live"}   \* committed chunks holding bytes

Init == /\ status = "running" /\ expired = FALSE /\ xlock = "none" /\ share = {}
        /\ wpc = [w \in Writers |-> "start"] /\ wsaw = [w \in Writers |-> FALSE]
        /\ chunk = [w \in Writers |-> "none"]
        /\ ppc = "idle" /\ psnap = {} /\ pcleared = {} /\ fpc = "idle"

(* The insert's subquery: read expired_at, taking the run row lock or not.
   A FOR SHARE reader waits out an uncommitted updater and then reads the
   newest committed row (READ COMMITTED re-check). FOR KEY SHARE does not
   conflict with a non-key UPDATE, and no lock is no lock: both read the
   committed row at once. "main" locks only a run it reads as finished. *)
TakesShare == LockMode = "share" \/ (LockMode = "main" /\ status = "done")
WRead(w) ==
  /\ wpc[w] = "start"
  /\ IF TakesShare THEN xlock = "none" /\ share' = share \cup {w}
                   ELSE share' = share
  /\ wsaw' = [wsaw EXCEPT ![w] = expired]
  /\ wpc' = [wpc EXCEPT ![w] = "read"]
  /\ UNCHANGED <<status, expired, xlock, chunk, ppc, psnap, pcleared, fpc>>

WInsert(w) ==
  /\ wpc[w] = "read"
  /\ IF wsaw[w]
       THEN /\ wpc' = [wpc EXCEPT ![w] = "done"]   \* refused: writes nothing
            /\ share' = share \ {w} /\ chunk' = chunk
       ELSE /\ wpc' = [wpc EXCEPT ![w] = "inserted"]
            /\ chunk' = [chunk EXCEPT ![w] = "pending"] /\ share' = share
  /\ UNCHANGED <<status, expired, xlock, wsaw, ppc, psnap, pcleared, fpc>>

WCommit(w) ==
  /\ wpc[w] = "inserted"
  /\ chunk' = [chunk EXCEPT ![w] = "live"]
  /\ share' = share \ {w}
  /\ wpc' = [wpc EXCEPT ![w] = IF LockMode = "main" THEN "scrub" ELSE "done"]
  /\ UNCHANGED <<status, expired, xlock, wsaw, ppc, psnap, pcleared, fpc>>

(* "main" only: the scrub that ran after the insert had committed. *)
WScrub(w) ==
  /\ wpc[w] = "scrub"
  /\ status = "done" => xlock = "none"
  /\ chunk' = [chunk EXCEPT ![w] = IF status = "done" /\ expired THEN "blank" ELSE @]
  /\ wpc' = [wpc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<status, expired, xlock, share, wsaw, ppc, psnap, pcleared, fpc>>

(* The run's terminal transition: an UPDATE of the run row. *)
FUpdate == /\ fpc = "idle" /\ xlock = "none" /\ share = {}
           /\ xlock' = "finish" /\ fpc' = "updating"
           /\ UNCHANGED <<status, expired, share, wpc, wsaw, chunk, ppc, psnap, pcleared>>
FCommit == /\ fpc = "updating"
           /\ status' = "done" /\ xlock' = "none" /\ fpc' = "done"
           /\ UNCHANGED <<expired, share, wpc, wsaw, chunk, ppc, psnap, pcleared>>

(* purgeRunUserData. Its first statement starts (and under REPEATABLE READ
   fixes the transaction's snapshot) before it may have to wait for a lock. *)
PStart == /\ ppc = "idle" /\ status = "done"
          /\ ppc' = "started" /\ psnap' = Live
          /\ UNCHANGED <<status, expired, xlock, share, wpc, wsaw, chunk, pcleared, fpc>>
PUpdateRun ==
  /\ ppc = (IF RunFirst THEN "started" ELSE "cleared")
  /\ xlock = "none" /\ share = {}
  /\ xlock' = "purge"
  /\ ppc' = (IF RunFirst THEN "runUpdated" ELSE "ready")
  /\ UNCHANGED <<status, expired, share, wpc, wsaw, chunk, psnap, pcleared, fpc>>
PClear ==
  /\ ppc = (IF RunFirst THEN "runUpdated" ELSE "started")
  /\ pcleared' = (IF Isolation = "RC" THEN Live ELSE psnap)
  /\ ppc' = (IF RunFirst THEN "ready" ELSE "cleared")
  /\ UNCHANGED <<status, expired, xlock, share, wpc, wsaw, chunk, psnap, fpc>>
PCommit ==
  /\ ppc = "ready"
  /\ chunk' = [w \in Writers |-> IF w \in pcleared THEN "blank" ELSE chunk[w]]
  /\ expired' = TRUE /\ xlock' = "none" /\ ppc' = "committed"
  /\ UNCHANGED <<status, share, wpc, wsaw, psnap, pcleared, fpc>>

Finished == /\ ppc = "committed" /\ fpc = "done" /\ \A w \in Writers : wpc[w] = "done"
            /\ UNCHANGED vars

Next == \/ \E w \in Writers : WRead(w) \/ WInsert(w) \/ WCommit(w) \/ WScrub(w)
        \/ FUpdate \/ FCommit \/ PStart \/ PUpdateRun \/ PClear \/ PCommit \/ Finished
Spec == Init /\ [][Next]_vars

(* Once the deletion has committed, no chunk holds bytes, not even for a
   moment. *)
NoLeak == ppc = "committed" => Live = {}
(* The weaker guarantee of "main": none once every writer has finished. *)
QuiescentNoLeak == (ppc = "committed" /\ \A w \in Writers : wpc[w] = "done") => Live = {}
====
