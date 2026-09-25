---------------------------- MODULE MidRunRaiseGates ----------------------------
(***************************************************************************)
(* Mid-run spec-version raises (workflow-server #1044 @ d0575db, driven by *)
(* the #4366 executorSpecVersion attestation and the #4327 start() stamp)  *)
(* checked against the code that READS the run: the target deployment's   *)
(* executor (ReaderCode) and the caller deployment that polls the result  *)
(* (CallerCode), over the whole version lattice 1..MaxV.                   *)
(*                                                                         *)
(* Revision 2 closes the fidelity gaps of revision 1, which checked only   *)
(* ReplayConsistent (consistency against the run's OWN persisted version)  *)
(* and made the raise, the fresh check and each terminal write single      *)
(* atomic steps:                                                           *)
(*  G1 reader code: ExecutorCanReplay uses ReaderCode. A v5 executor calls *)
(*     requireEventSlot on EVERY row whatever run.specVersion says         *)
(*     (wf world/src/slot-identity.ts:116-124, core runtime/helpers.ts:    *)
(*     878-960, runtime.ts:3278). run_created-not-committed windows        *)
(*     (CallerSplit) and resilient start at the caller's meta stamp        *)
(*     (ResilientStart; ws events.ts:8056-8238) are modelled.              *)
(*  G2 terminal writes are split: KRead (snapshot) / KPatch (guard: not    *)
(*     terminal) / KInsert (row tagged with the SNAPSHOT regime) in ULID   *)
(*     mode; one transaction in slot mode (ws events.ts:2417-2650,         *)
(*     8277-8300). run_started skips ('log-not-fresh', 'run-created-not-   *)
(*     committed', 'not-newer', 'terminal') hand back the stale input run  *)
(*     (ws run-spec-version-upgrade.ts:83-122).                            *)
(*  G3 CallerCanDecode: the output is compressed iff the executor's        *)
(*     in-memory run.specVersion >= 5 (wf core workflow.ts:1254,           *)
(*     runtime.ts:430); v4 stable decodeFormatPrefix knows only            *)
(*     'devl'/'encr' (stable core serialization-format.ts:15-20,58-87).    *)
(*  G4 the head read (upgrade.ts:111-122) and the transaction (upgrade.ts: *)
(*     124-182) are separate steps; the transaction conditions only on the *)
(*     run row (specVersion == from, status) and the run_created row.      *)
(*  G5 Recover: the v4 missing-run-event recovery deletes only the run     *)
(*     entity (ws handlers/v4/events.ts:1650-1830); the retried            *)
(*     run_started rebuilds it via resilient start, keeping the old rows.  *)
(*  G6 the run_started state patch has no .where guard (ws events.ts:      *)
(*     2376-2415): a starter holding a stale 'pending' (or a lost-race     *)
(*     reread that is terminal) patches running, even over a terminal run. *)
(*                                                                         *)
(* The row-level concurrency of one concrete (stamp, exec) pair is also    *)
(* modelled, at a finer grain, by ../ServerRaiseProtocol (ids, ULID sort   *)
(* order, probeMaxSlot, sequencer). This model trades that detail for the  *)
(* whole version lattice and the reader/caller code dimension.             *)
(*                                                                         *)
(* Each row is tagged with the STRUCTURAL REGIME it was written under:     *)
(* Regime(v) = {s \in StructuralSet : s <= v} for the spec version the     *)
(* WRITING request held (6 = slot identity, 7 = sealed log; a hypothetical *)
(* 9 may be added). A row is slot-numbered iff 6 \in tag.                  *)
(*                                                                         *)
(* CODE MAP (ws = workflow-server @ d0575db, wf = workflow)                *)
(*  CallerRow/CallerEvt  ws events.ts:1979-2133 handleRunCreated: run row  *)
(*     create (409 if it exists); the run_created event is inserted        *)
(*     separately later (events.ts:8277-8300, 9562-9600). The stamp comes  *)
(*     from wf core start.ts:117-138,587-588 (#4327), including an explicit*)
(*     opts.specVersion, CLI reuse (cli inspect/run.ts:87-109) and stable  *)
(*     callers (stamp 3, stable start.ts:248-252). CallerRow's no-write    *)
(*     branch = retryable run_created failure -> resilientStart (wf        *)
(*     start.ts:813-900).                                                  *)
(*  SFetch               ws events.ts:8019-8055 fetchAndValidateRun with   *)
(*     options.preloadedRun / fetchRunByIdForTenant (EC first); terminal   *)
(*     -> 410 (events.ts:2159-2220). Stale reads = any committed version.  *)
(*  SRsCreate/SRsEvt/SRsRefetch  resilient start ws events.ts:8056-8238:   *)
(*     row + synthetic run_created at input.specVersion (the caller stamp, *)
(*     ws handlers/v4/headers.ts:163-170); slot 1 adopted if present;      *)
(*     EntityConflict -> refetch; NO upgrade call on either path.          *)
(*     Needs runInput (stamp >= 3, wf start.ts:749-761).                   *)
(*  SCheck               upgrade.ts:96-109 ('not-newer', 'terminal',        *)
(*     pre-read 'log-not-fresh' when held status != pending).              *)
(*  SHead                upgrade.ts:111-122 consistent head read           *)
(*     (events.ts:1627-1634): not-committed / not-first / log-not-fresh.   *)
(*  STx                  upgrade.ts:124-182 transactWrite.                  *)
(*  SReread              upgrade.ts:184-208 (always rereads after the tx). *)
(*  STrans               ws events.ts:2376-2415 handleRunStateTransition.  *)
(*  SIns                 run_started row, id mode = held spec              *)
(*     (event-slot-identity.ts:143-160); allocatorFor events.ts:1814-1857: *)
(*     sealed -> sequencer (never probes), else probeMaxSlot, which 500s   *)
(*     on a ULID at the top of the log (event-slot-identity.ts:171-193).   *)
(*  SReplay              the executor code loads the log; ReaderCode >= 6  *)
(*     requires slot ids on every row (see G1). A failure becomes a        *)
(*     terminal run_failed (wf runtime.ts:817-875). In-memory               *)
(*     run.specVersion: turbo first delivery = runInput.specVersion = the  *)
(*     stamp (wf runtime.ts:1268-1273,2506-2600); otherwise the            *)
(*     run_created row's spec from the preload (world-vercel events.ts:    *)
(*     771-795), which #1044 rewrites inside the raise transaction.        *)
(*  SWork                a step/hook row on a running run, id mode from    *)
(*     the server's (possibly stale) read (events.ts:7080-7160).           *)
(*  SComplete            run_completed with the output, compressed iff the *)
(*     in-memory run.specVersion >= 5 (wf workflow.ts:1254).               *)
(*  KRead/KPatch/KInsert run_cancelled / external run_failed               *)
(*     (ws events.ts:2417-2650; slot mode commitRunPatchWithEvent).        *)
(*  Recover              G5.                                               *)
(*                                                                         *)
(* PROPOSED FIXES (BOOLEAN knobs)                                          *)
(*  FixResilient   resilient start (and its conflict refetch) creates /    *)
(*                 upgrades the run at Max(stamp, executorSpecVersion).    *)
(*  FixRetrySkips  the post-read transient skips (run-created-not-         *)
(*                 committed, log-not-fresh) throw retryable instead of    *)
(*                 continuing with the stale input run.                    *)
(*  FixCancelGuard the terminal patch also conditions on specVersion ==    *)
(*                 held spec (reread and retry on failure): in ULID mode   *)
(*                 the guarded patch, in slot mode the transaction.        *)
(*  FixGuardStart  the run_started patch conditions on status == pending   *)
(*                 AND specVersion == held spec (reread on failure).       *)
(*  FixRecovery    the recovery rebuild keeps the orphaned run_created    *)
(*                 (no second one) and its (raised) version instead of the *)
(*                 caller's meta stamp, then runs the upgrade path.        *)
(*  CompressGate   "run" (current): the executor compresses iff its        *)
(*                 in-memory run.specVersion >= 5; "stamp" (proposed): iff *)
(*                 the caller's stamp >= 5, so the payload format stays    *)
(*                 bound to what the caller declared it can decode.        *)
(*                                                                         *)
(* Serial = TRUE (lattice configs A) serializes the requests of different  *)
(* deliveries, i.e. the revision-1 atomic-request abstraction, so those    *)
(* configs compare raise RULES; every other config interleaves freely.     *)
(* Abstractions: the executor's own run_completed is one step (guarded     *)
(* patch + row); the external writer K exercises the split ULID path. One  *)
(* step row per delivery. Legacy (<= 1) runs are routed away (out of       *)
(* scope). MaxLog bounds the log; a full log disables appends.             *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  MaxV,            \* versions are 1..MaxV
  StructuralSet,   \* versions that change how existing rows are read
  CapabilitySet,   \* versions the allow-list lets cross on a non-fresh log
  Rule,            \* "default" (#1044), "allowlist" (proposed), "none" (mutant)
  InitVersions,    \* possible caller stamps (probe, explicit, CLI reuse, stable)
  ExecVersions,    \* executorSpecVersion per delivery (0 = not sent: pre-#4366
                   \*   v5 world-vercel, or a v4 stable executor)
  D,               \* run_started deliveries (duplicates / redeliveries)
  ReaderCode,      \* MAX_SUPPORTED of the target deployment's code
  CallerCode,      \* MAX_SUPPORTED of the caller deployment's code
  MaxLog,          \* bound on log length
  MaxAttempts,     \* attempts per delivery
  StaleReads,      \* BOOLEAN: EC / preloaded run reads may be stale
  CallerSplit,     \* BOOLEAN: run row and run_created row are separate writes
  ResilientStart,  \* BOOLEAN: run_created may fail retryably (run missing)
  CancelEnabled,   \* BOOLEAN: an external run_cancelled / run_failed writer
  Turbo,           \* BOOLEAN: the first delivery may run in turbo mode
  Recovery,        \* BOOLEAN: the v4 missing-run-event recovery may fire
  InsertMayFail,   \* BOOLEAN: the run_started insert may fail after the patch
  Serial,          \* BOOLEAN: requests of different deliveries never overlap
                   \*   (the revision-1 atomic abstraction; lattice configs)
  FixResilient, FixRetrySkips, FixCancelGuard, FixGuardStart, FixRecovery,
  CompressGate     \* "run" | "stamp"

ASSUME Rule \in {"default", "allowlist", "none"}
ASSUME CompressGate \in {"run", "stamp"}
ASSUME 6 \in StructuralSet
ASSUME StructuralSet \subseteq 1..MaxV /\ CapabilitySet \subseteq 1..MaxV
ASSUME InitVersions \subseteq 1..MaxV /\ ExecVersions \subseteq 0..MaxV
ASSUME \A e \in ExecVersions : e <= ReaderCode   \* minted <= own MAX

Max(a, b) == IF a >= b THEN a ELSE b
Regime(v) == {s \in StructuralSet : s <= v}
SlotTag(g) == 6 \in g
Sealed(v) == v >= 7                        \* usesSealedLog, version-utils.ts
IsLegacy(v) == v <= 1                      \* isPreEventSourcing
Crosses(from, to, x) == from < x /\ x <= to
Rekey(from, to) == from < 6 /\ 6 <= to

\* #1044, run-spec-version-upgrade.ts:99-104
DefaultRequiresFresh(from, to) == Crosses(from, to, 6) \/ Crosses(from, to, 7)
\* proposed allow-list rule
AllowListRequiresFresh(from, to) ==
  \E x \in (from + 1)..to : x \notin CapabilitySet
RequiresFresh(from, to) ==
  CASE Rule = "default"   -> DefaultRequiresFresh(from, to)
    [] Rule = "allowlist" -> AllowListRequiresFresh(from, to)
    [] Rule = "none"      -> FALSE           \* MUTATION: no freshness check

VARIABLES
  stamp,      \* caller stamp (chosen once)
  exe,        \* [D -> executorSpecVersion]
  rowEx, st, rv,  \* run row: exists, status, persisted specVersion
  hist,       \* every committed row version [st, v] (for stale reads)
  log,        \* Seq([t, g]): t \in {rc, rs, w, tm}, g = regime tag
  cpc,        \* caller pc
  pc, held, hidx, hfresh, att, turbo, gvv,   \* deliveries
  kpc, kheld, \* external terminal writer
  replayFail, \* some executor replay met a row its code cannot read
  outComp,    \* the caller-read output was written compressed
  recovered,  \* the recovery fired
  refused     \* raises blocked on a non-fresh log (cost metric)

vars == <<stamp, exe, rowEx, st, rv, hist, log, cpc, pc, held, hidx, hfresh,
          att, turbo, gvv, kpc, kheld, replayFail, outComp, recovered, refused>>

Cur == [st |-> st, v |-> rv]
Reads == IF StaleReads THEN hist ELSE {Cur}
Rows == 1..Len(log)
HasUlid == \E i \in Rows : ~SlotTag(log[i].g)
SlotIdx == {i \in Rows : SlotTag(log[i].g)}
HasSlotRC == \E i \in SlotIdx : log[i].t = "rc"
MinOf(S) == CHOOSE i \in S : \A j \in S : i <= j
\* sort order: slot ids first (slot 1 = run_created), ULIDs above every slot
FirstIdx == IF SlotIdx = {} THEN 1
            ELSE IF HasSlotRC THEN CHOOSE i \in SlotIdx : log[i].t = "rc"
            ELSE MinOf(SlotIdx)
\* allocatorFor: sealed -> the sequencer never probes; otherwise probeMaxSlot
\* 500s on a ULID at the top of the log.  ULID inserts always succeed.
CanAllocate(v) == ~SlotTag(Regime(v)) \/ Sealed(v) \/ ~HasUlid
Room == Len(log) < MaxLog
Row(t, v) == [t |-> t, g |-> Regime(v)]
Commit(s, v) == /\ st' = s /\ rv' = v
                /\ hist' = hist \cup {[st |-> s, v |-> v]}
RsV(d) == IF FixResilient THEN Max(stamp, exe[d]) ELSE stamp

-----------------------------------------------------------------------------
Init ==
  /\ stamp \in InitVersions
  /\ exe \in [D -> ExecVersions]
  /\ rowEx = FALSE /\ st = "none" /\ rv = 0 /\ hist = {}
  /\ log = << >>
  /\ cpc = "row"
  /\ pc = [d \in D |-> "fetch"]
  /\ held = [d \in D |-> [st |-> "none", v |-> 0]]
  /\ hidx = [d \in D |-> 0]
  /\ hfresh = [d \in D |-> FALSE]
  /\ att = [d \in D |-> 1]
  /\ turbo \in [D -> IF Turbo THEN BOOLEAN ELSE {FALSE}]
  /\ gvv = [d \in D |-> 0]
  /\ kpc = IF CancelEnabled THEN "read" ELSE "done"
  /\ kheld = [st |-> "none", v |-> 0]
  /\ replayFail = FALSE /\ outComp = FALSE /\ recovered = FALSE
  /\ refused = {}

-----------------------------------------------------------------------------
(* Caller: run_created                                                     *)
CUnch == <<stamp, exe, pc, held, hidx, hfresh, att, turbo, gvv, kpc, kheld,
           replayFail, outComp, recovered, refused>>

CallerRow ==
  /\ cpc = "row"
  /\ \/ /\ ResilientStart                   \* retryable failure, no write
        /\ cpc' = "done" /\ UNCHANGED <<rowEx, st, rv, hist, log>>
     \/ /\ rowEx                            \* 409, run already exists
        /\ cpc' = "done" /\ UNCHANGED <<rowEx, st, rv, hist, log>>
     \/ /\ ~rowEx
        /\ rowEx' = TRUE /\ Commit("pending", stamp)
        /\ IF CallerSplit
             THEN cpc' = "evt" /\ UNCHANGED log
             ELSE cpc' = "done" /\ log' = << Row("rc", stamp) >>
  /\ UNCHANGED CUnch

CallerEvt ==
  /\ cpc = "evt" /\ Room
  /\ log' = Append(log, Row("rc", stamp))   \* id mode from the row it created
  /\ cpc' = "done"
  /\ UNCHANGED <<rowEx, st, rv, hist>>
  /\ UNCHANGED CUnch

-----------------------------------------------------------------------------
(* Deliveries: the run_started request, then the executor                 *)
SUnch == <<stamp, exe, cpc, kpc, kheld, recovered>>
Go(d, p) == pc' = [pc EXCEPT ![d] = p]
Hold(d, r) == held' = [held EXCEPT ![d] = r]

\* request-internal pcs: between these steps another request may interleave
\* unless Serial
ReqPcs == {"rs_create", "rs_evt", "rs_refetch", "check", "head", "tx",
           "reread", "trans", "ins"}
Free(d) == Serial => \A d2 \in D \ {d} : pc[d2] \notin ReqPcs

Fail(d) ==
  IF att[d] < MaxAttempts
  THEN /\ Go(d, "fetch")
       /\ att' = [att EXCEPT ![d] = @ + 1]
       /\ turbo' = [turbo EXCEPT ![d] = FALSE]     \* redelivery: attempt >= 2
  ELSE /\ Go(d, "err") /\ UNCHANGED <<att, turbo>>

SFetch(d) ==
  /\ pc[d] = "fetch" /\ Free(d)
  /\ (rowEx \/ ResilientStart)
  /\ IF ~rowEx
     THEN IF stamp >= 3                     \* runInput present
            THEN Go(d, "rs_create") /\ UNCHANGED <<held, att, turbo>>
            ELSE Fail(d) /\ UNCHANGED held  \* WorkflowRunNotFoundError
     ELSE \E r \in Reads :
            IF r.st = "terminal" THEN Go(d, "gone") /\ UNCHANGED <<held, att, turbo>>
            ELSE IF IsLegacy(r.v) THEN Go(d, "done") /\ UNCHANGED <<held, att, turbo>>
            ELSE Hold(d, r) /\ Go(d, "check") /\ UNCHANGED <<att, turbo>>
  /\ UNCHANGED <<rowEx, st, rv, hist, log, hidx, hfresh, gvv, replayFail,
                 outComp, refused>>
  /\ UNCHANGED SUnch

SRsCreate(d) ==
  /\ pc[d] = "rs_create"
  /\ IF rowEx
     THEN Go(d, "rs_refetch") /\ UNCHANGED <<rowEx, st, rv, hist, held>>
     ELSE /\ rowEx' = TRUE /\ Commit("pending", RsV(d))
          /\ Hold(d, [st |-> "pending", v |-> RsV(d)])
          /\ Go(d, "rs_evt")
  /\ UNCHANGED <<log, hidx, hfresh, att, turbo, gvv, replayFail, outComp, refused>>
  /\ UNCHANGED SUnch

SRsEvt(d) ==
  /\ pc[d] = "rs_evt" /\ Room
  /\ IF SlotTag(Regime(held[d].v)) /\ HasSlotRC
       THEN UNCHANGED log                        \* adopt slot-1 run_created
       ELSE log' = Append(log, Row("rc", held[d].v))
  /\ Go(d, "trans")                              \* no upgrade on this path
  /\ UNCHANGED <<rowEx, st, rv, hist, held, hidx, hfresh, att, turbo, gvv,
                 replayFail, outComp, refused>>
  /\ UNCHANGED SUnch

SRsRefetch(d) ==
  /\ pc[d] = "rs_refetch" /\ rowEx
  /\ \E r \in Reads :
       IF r.st = "terminal" THEN Go(d, "gone") /\ UNCHANGED held
       ELSE Hold(d, r) /\ Go(d, IF FixResilient THEN "check" ELSE "trans")
  /\ UNCHANGED <<rowEx, st, rv, hist, log, hidx, hfresh, att, turbo, gvv,
                 replayFail, outComp, refused>>
  /\ UNCHANGED SUnch

SCheck(d) ==
  /\ pc[d] = "check"
  /\ LET r == held[d]
         e == exe[d]
     IN IF e <= r.v \/ r.st = "terminal" \/ IsLegacy(r.v)
          THEN Go(d, "trans") /\ UNCHANGED refused       \* not-newer / terminal
        ELSE IF RequiresFresh(r.v, e) /\ r.st /= "pending"
          THEN Go(d, "trans") /\ refused' = refused \cup {<<r.v, e>>}
        ELSE Go(d, "head") /\ UNCHANGED refused
  /\ UNCHANGED <<rowEx, st, rv, hist, log, held, hidx, hfresh, att, turbo, gvv,
                 replayFail, outComp>>
  /\ UNCHANGED SUnch

SHead(d) ==
  /\ pc[d] = "head"
  /\ LET from == held[d].v
         e == exe[d]
         reason ==
           IF Len(log) = 0 THEN "not-committed"
           ELSE IF log[FirstIdx].t /= "rc" THEN "not-first"
           ELSE IF (RequiresFresh(from, e) /\ Len(log) > 1)
                   \/ (Rekey(from, e) /\ SlotTag(log[FirstIdx].g))
                THEN "not-fresh"
           ELSE "go"
     IN
     /\ refused' = IF reason = "not-fresh" THEN refused \cup {<<from, e>>}
                   ELSE refused
     /\ IF reason = "go"
        THEN /\ hidx' = [hidx EXCEPT ![d] = FirstIdx]
             /\ hfresh' = [hfresh EXCEPT ![d] = (Len(log) = 1)]
             /\ Go(d, "tx") /\ UNCHANGED <<att, turbo>>
        ELSE IF FixRetrySkips /\ reason \in {"not-committed", "not-fresh"}
        THEN Fail(d) /\ UNCHANGED <<hidx, hfresh>>
        ELSE Go(d, "trans") /\ UNCHANGED <<hidx, hfresh, att, turbo>>
  /\ UNCHANGED <<rowEx, st, rv, hist, log, held, gvv, replayFail, outComp>>
  /\ UNCHANGED SUnch

STx(d) ==
  /\ pc[d] = "tx"
  /\ LET from == held[d].v
         e == exe[d]
         i == hidx[d]
         cond == /\ rowEx /\ rv = from
                 /\ IF RequiresFresh(from, e) THEN st = "pending"
                    ELSE st /= "terminal"
                 /\ i \in Rows /\ log[i].t = "rc"
                 /\ (Rekey(from, e) => ~SlotTag(log[i].g))
     IN IF cond
        THEN /\ Commit(st, e)
             \* run_created rewritten (rekey delete+create at slot 1, or a
             \* specVersion patch); rows appended since the head read keep
             \* the tag they were written under.
             /\ log' = IF hfresh[d] THEN [log EXCEPT ![i].g = Regime(e)]
                       ELSE log
        ELSE UNCHANGED <<st, rv, hist, log>>          \* lost-race
  /\ Go(d, "reread")
  /\ UNCHANGED <<rowEx, held, hidx, hfresh, att, turbo, gvv, replayFail,
                 outComp, refused>>
  /\ UNCHANGED SUnch

SReread(d) ==
  /\ pc[d] = "reread"
  /\ Hold(d, Cur) /\ Go(d, "trans")
  /\ UNCHANGED <<rowEx, st, rv, hist, log, hidx, hfresh, att, turbo, gvv,
                 replayFail, outComp, refused>>
  /\ UNCHANGED SUnch

STrans(d) ==
  /\ pc[d] = "trans"
  /\ LET h == held[d] IN
     IF h.st = "running"
       THEN Go(d, "replay") /\ UNCHANGED <<st, rv, hist, held>>  \* alreadyRunning
     ELSE IF ~FixGuardStart
       THEN Commit("running", rv) /\ Go(d, "ins") /\ UNCHANGED held  \* no .where
     ELSE IF st = "pending" /\ rv = h.v
       THEN Commit("running", rv) /\ Go(d, "ins") /\ UNCHANGED held
     ELSE /\ Hold(d, Cur)                                        \* reread
          /\ Go(d, IF st = "terminal" THEN "gone" ELSE "check")
          /\ UNCHANGED <<st, rv, hist>>
  /\ UNCHANGED <<rowEx, log, hidx, hfresh, att, turbo, gvv, replayFail,
                 outComp, refused>>
  /\ UNCHANGED SUnch

SIns(d) ==
  /\ pc[d] = "ins"
  /\ \/ /\ InsertMayFail                  \* crash / 5xx after the patch
        /\ Fail(d) /\ UNCHANGED log
     \/ /\ ~CanAllocate(held[d].v)        \* 500 slot-log-mixed-identity
        /\ Fail(d) /\ UNCHANGED log
     \/ /\ CanAllocate(held[d].v) /\ Room
        /\ log' = Append(log, Row("rs", held[d].v))
        /\ Go(d, "replay") /\ UNCHANGED <<att, turbo>>
  /\ UNCHANGED <<rowEx, st, rv, hist, held, hidx, hfresh, gvv, replayFail,
                 outComp, refused>>
  /\ UNCHANGED SUnch

\* What the executor code can read.  ReaderCode >= 6 (v5): every row must be
\* slot-numbered, unconditionally.  ReaderCode < 6 (v4 stable): ULID ids;
\* slot ids unverified (modelled as unreadable, conservatively).
ReaderOK == IF ReaderCode >= 6 THEN \A i \in Rows : SlotTag(log[i].g)
            ELSE \A i \in Rows : ~SlotTag(log[i].g)

SReplay(d) ==
  /\ pc[d] = "replay"
  /\ gvv' = [gvv EXCEPT ![d] = IF turbo[d] THEN stamp ELSE rv]
  /\ IF ~ReaderOK /\ ~IsLegacy(rv)
       THEN replayFail' = TRUE /\ Go(d, "done")   \* -> terminal run_failed
       ELSE Go(d, "work") /\ UNCHANGED replayFail
  /\ UNCHANGED <<rowEx, st, rv, hist, log, held, hidx, hfresh, att, turbo,
                 outComp, refused>>
  /\ UNCHANGED SUnch

SWork(d) ==
  /\ pc[d] = "work" /\ Free(d)
  /\ \E r \in Reads :
       IF r.st /= "running" THEN Go(d, "done") /\ UNCHANGED log
       ELSE /\ CanAllocate(r.v) /\ Room
            /\ log' = Append(log, Row("w", r.v))
            /\ Go(d, "complete")
  /\ UNCHANGED <<rowEx, st, rv, hist, held, hidx, hfresh, att, turbo, gvv,
                 replayFail, outComp, refused>>
  /\ UNCHANGED SUnch

Compresses(d) == IF CompressGate = "stamp" THEN stamp >= 5 ELSE gvv[d] >= 5

\* The executor's run_completed goes through the same terminal-transition
\* code as K (guarded patch; with FixCancelGuard also spec == held).
SComplete(d) ==
  /\ pc[d] = "complete" /\ Free(d)
  /\ \E r \in Reads :
       IF r.st = "terminal" \/ st = "terminal"
         THEN Go(d, "done") /\ UNCHANGED <<st, rv, hist, log, outComp>>
       ELSE /\ CanAllocate(r.v) /\ Room
            /\ FixCancelGuard => rv = r.v
            /\ Commit("terminal", rv)
            /\ log' = Append(log, Row("tm", r.v))
            /\ outComp' = (outComp \/ Compresses(d))
            /\ Go(d, "done")
  /\ UNCHANGED <<rowEx, held, hidx, hfresh, att, turbo, gvv, replayFail, refused>>
  /\ UNCHANGED SUnch

\* G5: a retried run_started (delivery d, a redelivery) finds the run running
\* with no run_started and no progress, deletes the run entity only, and
\* rebuilds it through resilient start (atomic here: delete + create + event).
Recover(d) ==
  /\ Recovery /\ ~recovered /\ rowEx /\ st = "running" /\ stamp >= 3
  /\ Free(d)
  /\ \A i \in Rows : log[i].t = "rc"
  /\ pc[d] \in {"err", "gone", "done"}
  /\ LET HasRC == \E i \in Rows : log[i].t = "rc"
         \* current: resilient start at the meta stamp (or Max with the
         \* attestation under FixResilient); FixRecovery: keep the orphaned
         \* run_created (and its version, = the deleted row's, which #1044
         \* keeps in sync), then go through the upgrade path.
         v == IF FixRecovery THEN Max(stamp, rv) ELSE RsV(d)
     IN /\ Commit("pending", v)
        /\ IF (FixRecovery /\ HasRC) \/ (SlotTag(Regime(v)) /\ HasSlotRC)
             THEN UNCHANGED log                      \* adopt
             ELSE Room /\ log' = Append(log, Row("rc", v))
        /\ Hold(d, [st |-> "pending", v |-> v])
        /\ Go(d, IF FixRecovery /\ FixResilient THEN "check" ELSE "trans")
  /\ recovered' = TRUE
  /\ turbo' = [turbo EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<stamp, exe, rowEx, cpc, hidx, hfresh, att, gvv, kpc, kheld,
                 replayFail, outComp, refused>>

-----------------------------------------------------------------------------
(* External terminal writer (run_cancelled / run_failed POST)              *)
KUnch == <<stamp, exe, rowEx, cpc, pc, held, hidx, hfresh, att, turbo, gvv,
           replayFail, outComp, recovered, refused>>

KRead ==
  /\ kpc = "read"
  /\ IF ~rowEx THEN kpc' = "done" /\ UNCHANGED kheld            \* 404
     ELSE \E r \in Reads :
            IF r.st = "terminal" THEN kpc' = "done" /\ UNCHANGED kheld
            ELSE kheld' = r /\ kpc' = "patch"
  /\ UNCHANGED <<st, rv, hist, log>>
  /\ UNCHANGED KUnch

KPatch ==
  /\ kpc = "patch"
  /\ IF SlotTag(Regime(kheld.v))
     THEN \* commitRunPatchWithEvent: one transaction, guard non-terminal
          ( IF st /= "terminal" /\ FixCancelGuard /\ rv /= kheld.v
              THEN kheld' = Cur /\ kpc' = "patch" /\ UNCHANGED <<st, rv, hist, log>>
            ELSE /\ IF st /= "terminal" /\ CanAllocate(kheld.v) /\ Room
                      THEN Commit("terminal", rv) /\ log' = Append(log, Row("tm", kheld.v))
                      ELSE UNCHANGED <<st, rv, hist, log>>
                 /\ kpc' = "done" /\ UNCHANGED kheld )
     ELSE IF st /= "terminal" /\ (FixCancelGuard => rv = kheld.v)
       THEN Commit("terminal", rv) /\ kpc' = "insert" /\ UNCHANGED <<log, kheld>>
     ELSE IF FixCancelGuard /\ st /= "terminal"
       THEN kheld' = Cur /\ kpc' = "patch" /\ UNCHANGED <<st, rv, hist, log>>
     ELSE kpc' = "done" /\ UNCHANGED <<st, rv, hist, log, kheld>>
  /\ UNCHANGED KUnch

KInsert ==
  /\ kpc = "insert" /\ Room
  /\ log' = Append(log, Row("tm", kheld.v))      \* SNAPSHOT id mode (ULID)
  /\ kpc' = "done"
  /\ UNCHANGED <<st, rv, hist, kheld>>
  /\ UNCHANGED KUnch

-----------------------------------------------------------------------------
Next ==
  \/ CallerRow \/ CallerEvt
  \/ \E d \in D : \/ SFetch(d) \/ SRsCreate(d) \/ SRsEvt(d) \/ SRsRefetch(d)
                  \/ SCheck(d) \/ SHead(d) \/ STx(d) \/ SReread(d)
                  \/ STrans(d) \/ SIns(d) \/ SReplay(d) \/ SWork(d)
                  \/ SComplete(d) \/ Recover(d)
  \/ KRead \/ KPatch \/ KInsert
  \/ UNCHANGED vars            \* quiescence (bounded log) is not a deadlock

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ st \in {"none", "pending", "running", "terminal"}
  /\ rv \in 0..MaxV
  /\ Len(log) \in 0..MaxLog
  /\ \A i \in Rows : log[i].t \in {"rc", "rs", "w", "tm"}
  /\ refused \subseteq ((1..MaxV) \X (0..MaxV))

(* G1: the executor code can replay the run. Checked when a replay         *)
(* actually loads the log (replayFail) and as a state predicate on every   *)
(* live running run (its executor WILL load it). Legacy runs (<= 1) take   *)
(* the legacy path and are out of scope.                                   *)
ExecutorCanReplay ==
  /\ ~replayFail
  /\ (rowEx /\ st = "running" /\ ~IsLegacy(rv)) => ReaderOK

(* Revision-1 property: every row was written under the regime the run is *)
(* read under now. It measures the log against the run's persisted        *)
(* version, not against the reader code, so it is only valid together     *)
(* with ExecutorCanReplay; it is kept as the lattice (future-version)      *)
(* property.                                                               *)
ReplayConsistent == \A i \in Rows : log[i].g = Regime(rv)

(* A log never holds both slot ids and ULIDs (probeMaxSlot 500s on it).    *)
NoMixedIdentityLog ==
  (\E i \in Rows : SlotTag(log[i].g)) => (\A i \in Rows : SlotTag(log[i].g))

(* G3: the caller deployment can decode the output it polls.               *)
CallerCanDecode == outComp => CallerCode >= 5

(* Cost / precision: every refusal of a raise was needed.                  *)
NoNeedlessRefusal ==
  \A r \in refused : \E x \in (r[1] + 1)..r[2] : x \in StructuralSet

(* G5: the persisted version never decreases while the row exists.         *)
Monotone == [][(rowEx /\ rowEx') => rv' >= rv]_vars

(* G6: a terminal run stays terminal.                                      *)
TerminalAbsorbing == [][(rowEx /\ st = "terminal") => st' = "terminal"]_vars
=============================================================================
