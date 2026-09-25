-------------------------- MODULE ServerRaiseProtocol --------------------------
(***************************************************************************)
(* Fine-grained concurrency model of the workflow-server run_started       *)
(* spec-version raise (vercel/workflow-server#1044 @ d0575db) for ONE run, *)
(* driven by a #4327 caller (stamps the run) and a #4366 executor (attests *)
(* executorSpecVersion on every run_started).                              *)
(*                                                                         *)
(* Processes                                                               *)
(*   Caller     : run_created POST, independent of the queue message.     *)
(*   Exec[d]    : concurrent run_started deliveries (queue duplicates,    *)
(*                turbo re-invocations, redelivery after a retryable     *)
(*                failure), then replay + one step event. A delivery that *)
(*                runs out of attempts writes run_failed                  *)
(*                (MAX_DELIVERIES_EXCEEDED); a replay that cannot load the *)
(*                log writes run_failed too.                               *)
(*   Canceller  : run_cancelled POST on a pending/running run.           *)
(*                                                                         *)
(* Every server request is split into the DB operations the code performs *)
(* separately (non-transactional), so any interleaving between them is    *)
(* explored. Each DB operation is one atomic TLA+ step. A server request  *)
(* may die (Lambda crash / timeout) after any of its non-final writes     *)
(* (at most MaxCrashes times), which the SDK sees as a retryable error.   *)
(*                                                                         *)
(* CODE MAP (workflow-server = ws @ d0575db, workflow = wf)                *)
(*   Slot(v), Sealed(v)   ws lib/version-utils.ts:138-159                  *)
(*                        (usesSlotIdentity v>=6, usesSealedLog v>=7)       *)
(*   Rekey/RequiresFresh  ws lib/data/run-spec-version-upgrade.ts:99-103   *)
(*   ReadRun (EC + stale) ws lib/data/events.ts:1662-1703 fetchRunById-     *)
(*                        ForTenant: eventually-consistent query, consistent*)
(*                        fallback ONLY on a miss (lib/data/consistent-     *)
(*                        read.ts:50-80); options.preloadedRun is the v4     *)
(*                        handler's EC read (events.ts:2141-2152). Modelled *)
(*                        as "any row version ever committed" (hist) when   *)
(*                        StaleReads, else the current row. A read of a     *)
(*                        deleted row is modelled as a consistent miss.     *)
(*   CallerRow            ws events.ts:8012-8017 -> handleRunCreated        *)
(*                        (events.ts:1979-2133): conditional run-row create *)
(*                        (409 on exists), status pending, spec = stamp.    *)
(*   CallerEvt            run_created event row inserted separately later   *)
(*                        (events.ts:8277-8300; slot 1 pinned at spec>=6,   *)
(*                        event-slot-identity.ts:143-160), event specVersion*)
(*                        = request meta = stamp (events.ts:9540-9553).     *)
(*   CallerFail           wf start.ts:813-900: retryable run_created error  *)
(*                        -> resilientStart, no client retry; 409 ignored.  *)
(*   ExFetch              ws events.ts:8019-8032 fetchAndValidateRun;       *)
(*                        terminal -> EntityGoneError 410 (events.ts:2172). *)
(*   ExRsCreate/ExRsEvent resilient start ws events.ts:8056-8238: run row   *)
(*                        via handleRunCreated, then a separate synthetic   *)
(*                        run_created insert with specVersion =             *)
(*                        input.specVersion (the caller stamp, 8158);       *)
(*                        id = slot 1 if resolveEventId(run_started,stamp)  *)
(*                        allocates else ULID (8131-8138); adopt an existing*)
(*                        slot-1 run_created on conditional failure         *)
(*                        (8181-8212). NO upgrade call on this path.        *)
(*   ExRsRefetch          ws events.ts:8215-8229 EntityConflict -> refetch, *)
(*                        again no upgrade.                                 *)
(*   ExUpgCheck           upgrade.ts:96-109 (not-newer, terminal, pre-read  *)
(*                        log-not-fresh on status != pending). Skips return *)
(*                        the INPUT run unchanged (upgrade.ts:83-92).       *)
(*   ExUpgHead            upgrade.ts:111-122 consistent head read (limit 2, *)
(*                        events.ts:1630-1636): run-created-not-committed,  *)
(*                        run-created-not-first, log-not-fresh (len>1 or    *)
(*                        rekey of a slot run_created).                     *)
(*   ExUpgTx              upgrade.ts:124-182 transactWrite: run patch where *)
(*                        spec==from AND (fresh ? status==pending :         *)
(*                        non-terminal); rekey = delete ULID run_created    *)
(*                        (where eventType==run_created) + create slot 1 at *)
(*                        specVersion=to; else patch run_created's          *)
(*                        specVersion=to. No log condition.                 *)
(*   ExUpgReread          upgrade.ts:184-208 consistent reread; lost-race   *)
(*                        returns the reread (which may be TERMINAL).       *)
(*   ExTrans              ws events.ts:2376-2415 handleRunStateTransition:  *)
(*                        held.status==running -> alreadyRunning (no event);*)
(*                        else UNCONDITIONAL patch status=running (no .where)*)
(*   alreadyRunning, no   ws lib/handlers/v4/events.ts:919-938 ->           *)
(*   run_started row      recoverMissingRunEvent (1697-1855): 503 inside the*)
(*                        60 s grace window (MISSING_RUN_EVENT_GRACE_MS,    *)
(*                        183); past it, if the log holds only start events *)
(*                        (no progress), deleteRunEntityConditionally(status*)
(*                        = running) (ws lib/data/runs.ts:3877-3910) deletes*)
(*                        ONLY the run row (events stay), then 503; the     *)
(*                        retried run_started rebuilds via resilient start. *)
(*   ExRsInsert           run_started event insert afterwards, id mode from *)
(*                        the HELD run's spec (events.ts:8277-8300); slot   *)
(*                        allocation via allocatorFor(held spec)            *)
(*                        (events.ts:1814-1857): sealed -> sequencer (no    *)
(*                        probe), else probeMaxSlot which 500s on a ULID at *)
(*                        the top of the log (event-slot-identity.ts:171-193)*)
(*   ExReplay             wf packages/world/src/slot-identity.ts:116-124    *)
(*                        requireEventSlot on every loaded event, called     *)
(*                        unconditionally by findEventSlotGap/maxEventSlot  *)
(*                        (wf core runtime/helpers.ts:878-960, runtime.ts:  *)
(*                        3278): a ULID row -> terminal run_failed. A log   *)
(*                        without run_created: world-vercel                  *)
(*                        reconstructRunFromReplayEvents throws             *)
(*                        SCHEMA_VALIDATION (world-vercel events.ts:771-795)*)
(*                        -> setup failure -> run_failed.                   *)
(*                        Non-turbo executors take run.specVersion from the *)
(*                        run_created EVENT row, so its sp must match the   *)
(*                        run row (RunCreatedSpecMatchesRow).               *)
(*   ExStep/ExStepIns     step event: fetch (must be running, events.ts:    *)
(*                        2215), id mode from held spec, insert.            *)
(*   ExRfRead/ExRfWrite   run_failed POST: MAX_DELIVERIES_EXCEEDED once the *)
(*                        attempts run out (wf runtime.ts:817-875; 409/410  *)
(*                        consumed silently, other errors leave the run as  *)
(*                        is = "gaveup"), or after a terminal replay error. *)
(*                        Same terminal-transition code as run_cancelled    *)
(*                        (events.ts:2417-2650); modelled as one atomic step*)
(*                        (the ULID patch/insert split is explored by the   *)
(*                        canceller).                                       *)
(*   KRead/KPatch/KInsert run_cancelled: events.ts:2588-2650. Slot mode ->  *)
(*                        commitRunPatchWithEvent (one TX, guard non-terminal)*)
(*                        ULID mode -> guarded patch, then separate insert. *)
(*   Fail(d)              retryable error (5xx) -> queue redelivery         *)
(*                        (wf runtime.ts:817-875), bounded by MaxAttempts;  *)
(*                        the next delivery after the last writes run_failed*)
(*   Crash(d)             server request dies after a committed write and   *)
(*                        before its response (after ExRsCreate, ExUpgTx,   *)
(*                        ExTrans) -> Fail(d).                              *)
(*                                                                         *)
(* TIMING ASSUMPTIONS. The untimed model cannot say that requests finish  *)
(* in seconds while the queue spaces its 48 deliveries over ~9-10 h (5 s   *)
(* to 900 s backoff, wf core runtime/constants.ts:5-23) and recovery waits *)
(* a 60 s grace window. Two knobs encode it:                               *)
(*   GraceHolds     the recovery row delete only happens when no other     *)
(*                  request is in flight (the design premise of            *)
(*                  recoverMissingRunEvent). Always TRUE except in the     *)
(*                  *_noGrace configs, which show what it buys.            *)
(*   BoundedLatency a redelivery (attempt >= 2) and the MAX_DELIVERIES     *)
(*                  run_failed write only start once every request already *)
(*                  in flight has resolved (committed or died).            *)
(* SAFETY is checked with BoundedLatency = FALSE (every interleaving,      *)
(* including redeliveries racing in-flight requests). PROGRESS (NoStuck,   *)
(* GoodOutcome, Termination under FairSpec) is checked with                *)
(* BoundedLatency = TRUE: without it a merely slow request can exhaust     *)
(* MaxAttempts, which the real 9-10 h delivery horizon rules out.          *)
(*                                                                         *)
(* PROPOSED variant (fixes under evaluation)                               *)
(*   P1 (PropResilient)  resilient start creates the run row and picks the *)
(*       synthetic run_created's id mode at Max(stamp, executorSpecVersion);*)
(*       the conflict refetch path runs the upgrade.                       *)
(*       P1e (PropResilientEventMax) the synthetic run_created also CARRIES *)
(*       specVersion = Max(stamp, exec) instead of input.specVersion.      *)
(*   P2 (PropRetrySkips) the post-head-read run-created-not-committed skip *)
(*       throws retryable instead of falling through with the input run.   *)
(*       P2b (PropRetryNotFresh) the same for the post-read log-not-fresh  *)
(*       skip (redundant once P4 is on; see PROPOSED_MIN).                 *)
(*   P3 (PropCancelGuard) ULID-mode terminal patch also conditions on      *)
(*       specVersion == held spec; on that failure reread and retry.       *)
(*   P4 (PropGuardStart) run_started patch conditions on status==pending   *)
(*       AND spec==held spec; on failure reread (running -> alreadyRunning,*)
(*       terminal -> 410).                                                 *)
(*   P5 (PropAtomicCreate) handleRunCreated AND resilient start commit the *)
(*       run row and its run_created event in one transactWrite (adopting  *)
(*       an existing slot-1 run_created inside the same transaction).      *)
(*   RECOMMENDED = P1 + P1e + P3 + P4 + P5. P2 is redundant once P5 closes *)
(*       the row-without-run_created window (PROPOSED_MIN_P5 and           *)
(*       RECOMMENDED explore identical state spaces).                      *)
(*                                                                         *)
(* HEAD variant (#1044 @ f83173c, flag run-spec-version-upgrade on, the   *)
(* default; ws = workflow-server @ f83173c)                                *)
(*   P1+P1e  resilient start creates the row and its run_created at        *)
(*       createdSpecVersion = Max(stamp, executorSpecVersion) (legacy      *)
(*       stamps are never raised; outside this model's stamps), events.ts  *)
(*       8424-8450, and records raisedFromSpecVersion when it raised.      *)
(*       The conflict refetch runs the upgrade and, since 09887ac,         *)
(*       re-checks terminal -> 410 (events.ts 8590-8620; FixReviveGap).    *)
(*   P2 bounded (HeadUpgrade, RetryBudget, WindowHolds) upgrade.ts skip(): *)
(*       a doomed skip (rekey crossing, held pending) other than terminal  *)
(*       rereads (moved spec = lost race), else 503 Retry-After 1 while    *)
(*       now - run.createdAt < 60 s (not for run-created-already-slot),    *)
(*       then falls through with the input run (doomed). Modelled as       *)
(*       RetryBudget window retries per run-row lifetime.                  *)
(*   P3  ULID-mode terminal patches .where(spec == held) (PropCancelGuard);*)
(*       slot mode stays one TX guarded non-terminal.                      *)
(*   P4' run_started .where(status == 'pending' AND spec == held.spec)     *)
(*       (HeadGuardStart + GuardPendingOnly, events.ts 2601-2640); on a    *)
(*       failed condition resolveLostRunStartedTransition (2504-2563):     *)
(*       running -> alreadyRunning, missing/terminal -> 404/410, pending   *)
(*       at another spec -> 503.                                           *)
(*   P5  #1061: handleRunCreated and resilient start commit the row and    *)
(*       run_created in one TX (PropAtomicCreate); a slot-1 conflict with  *)
(*       no run row writes the row alone and adopts the orphaned           *)
(*       run_created (AdoptOrphanRC, events.ts 2207-2283).                 *)
(*   Recovery: reset-to-pending only for rows with raisedFromSpecVersion  *)
(*       and a run_created in the log (ResetOnlyRaised, variable rraised;  *)
(*       ws handlers/v4/events.ts 1870-1905, 4b7b241); every other wedged  *)
(*       run keeps delete-and-rebuild.                                     *)
(*   FlagOn = FALSE is the kill switch WORKFLOW_FLAG_RUN_SPEC_VERSION_     *)
(*       UPGRADE=0 (executorSpecVersion ignored). MAIN = pre-PR reference  *)
(*       (no attestation, no P3, delete-and-rebuild; #1061 + #1065, which  *)
(*       came from main).                                                  *)
(*   TurboWrites: a turbo first delivery backgrounds run_started; if it    *)
(*       fails, the SDK still sends the first replay's step writes (wf     *)
(*       core runtime.ts 1276-1293, 2500-2560). The server rejects a step  *)
(*       write whose run read is not running (StepStatusCheck, events.ts   *)
(*       2365 / 8109), but that read is eventually consistent;             *)
(*       StepCheckConsistent is the hypothetical server-side fix. The      *)
(*       client-side fix (no step write before run_started commits) is    *)
(*       TurboWrites = FALSE, i.e. the HEAD config itself.                 *)
(*   H9159765 = HEAD without P5, AdoptOrphanRC, GuardPendingOnly,          *)
(*       FixReviveGap and ResetOnlyRaised (regression witness).            *)
(*                                                                         *)
(* RESULTS (./run.sh -> results/<cfg>.txt, <cfg>__<Prop>.txt,             *)
(* <cfg>__PROGRESS.txt)                                                    *)
(*   CURRENT*: every safety invariant except SpecMonotonic and             *)
(*     NoStructuralCross is violated; progress fails.                      *)
(*   Every config without P5: the caller's run_created EVENT can land      *)
(*     after the executor's run_started + preload (not-newer path, so no   *)
(*     head read), and a non-turbo replay throws SCHEMA_VALIDATION ->      *)
(*     run_failed (ReplayNeverFails, 7 states). A crash between the run    *)
(*     row and run_created (caller or resilient start) leaves a live run   *)
(*     with run_started and no run_created (RunCreatedPresent).            *)
(*   Without P1e: RunCreatedSpecMatchesRow fails in 3-4 states.            *)
(*   CURRENT_crash: recovery deletes the wedged row and resilient start    *)
(*     rebuilds it at the caller stamp next to the raised slot-1           *)
(*     run_created (SpecNeverLowered, RunCreatedSpecMatchesRow,            *)
(*     NoMixedIdentityLog).                                                *)
(*   RECOMMENDED, RECOMMENDED_crash, RECOMMENDED_D3: every safety          *)
(*     invariant and action property PASSES, and so does progress         *)
(*     (NoStuck, GoodOutcome, Termination). Dropping any one of P1, P1e,   *)
(*     P3, P4 or P5 fails safety. RECOMMENDED_crash_noGrace and            *)
(*     RECOMMENDED__PROGRESS_noBL show that both timing premises are       *)
(*     load-bearing.                                                       *)
(*   H9159765: ReplayNeverFails (7 states, the two-write run_created       *)
(*     window: no P5 yet), TerminalIsFinal (the refetch-path revive gap),  *)
(*     plus NoDoomedRun / ExecutorReadable / AtMostOneRunStarted.          *)
(*   HEAD (f83173c): every safety invariant, action property and          *)
(*     informational invariant PASSES, and so does progress; also with     *)
(*     turbo writes (HEAD_turbo), the server consistent-check fix          *)
(*     (HEAD_turboFix) and without the window premise. HEAD_crash,         *)
(*     HEAD_turbo_crash, HEAD_turboFix_crash: safety PASSES; progress      *)
(*     fails only when an eventually consistent read may still return the *)
(*     pre-reset 'running' row on every redelivery (HEAD_crash_settled     *)
(*     passes). HEAD_turbo_crash_settled / HEAD_turboFix_crash_settled:    *)
(*     a turbo step write lands after a run_started request died between  *)
(*     its running patch and its event insert; recovery then sees progress *)
(*     and never repairs the run (MAX_DELIVERIES run_failed). The same     *)
(*     happens on MAIN (MAIN_turbo_crash_settled_slotStamps).              *)
(*   HEAD_turbo_noStepCheck (hypothetical server without the step status  *)
(*     check): a turbo step write under a stale 'pending' read mints a     *)
(*     ULID into the re-keyed slot log (NoMixedIdentityLog, NoDoomedRun).  *)
(*   HEAD_flagOff (kill switch) = MAIN verdicts: the S1 brick of a stamp   *)
(*     below 6 under a v5 executor (NoDoomedRun, ExecutorReadable,         *)
(*     ReplayNeverFails), nothing else.                                    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  CallerStamps,      \* set of possible caller stamps, e.g. {3,6,7}
  ExecVersions,      \* set of executor minted versions, e.g. {7,8}
  D,                 \* executor delivery ids, e.g. {1,2}
  MaxAttempts,       \* deliveries per id before MAX_DELIVERIES run_failed
  StaleReads,        \* BOOLEAN: EC / preloaded run reads may be stale
  CallerMayFail,     \* BOOLEAN: run_created may fail before writing
  CallerMayCrash,    \* BOOLEAN: run_created may die between row and event
  MaxCrashes,        \* executor-side server requests that may die between
                     \*   their writes (Crash(d)), in total; 0 = none
  CancelEnabled,     \* BOOLEAN: a canceller exists
  ResilientStart,    \* BOOLEAN: FALSE = isolation knob, a delivery never
                     \*   reaches the server before the run row exists
  RunCreatedAtomic,  \* BOOLEAN: TRUE = isolation knob, the CALLER's run row
                     \*   + run_created commit together
  BoundedLatency,    \* BOOLEAN: timing assumption (redeliveries), see header
  GraceHolds,        \* BOOLEAN: timing assumption (recovery grace window)
  PropResilient, PropResilientEventMax, PropRetrySkips, PropRetryNotFresh,
  PropCancelGuard, PropGuardStart, PropAtomicCreate,
                     \* BOOLEANs, see PROPOSED variant above
  FlagOn,            \* BOOLEAN: run-spec-version-upgrade flag (HEAD: when
                     \*   FALSE the attestation is ignored; TRUE everywhere
                     \*   before HEAD, where the raise was not gated)
  HeadUpgrade,       \* BOOLEAN: upgradeRunSpecVersionForExecutor @ 9159765
  RetryBudget,       \* window retries (503) before a doomed skip falls through
  WindowHolds,       \* BOOLEAN: timing premise of the 60 s retry window
  HeadGuardStart,    \* BOOLEAN: run_started patch @ 9159765
  FixReviveGap,      \* BOOLEAN: terminal re-check after the refetch upgrade
  RecoveryReset,     \* BOOLEAN: wedged-run recovery resets to pending
  TurboWrites,       \* BOOLEAN: turbo client writes a step after a failed
                     \*   backgrounded run_started
  StepStatusCheck,   \* BOOLEAN: server rejects a step write whose run read
                     \*   is not running (TRUE in the code)
  \* #1044 @ f83173c switches (FALSE = the 9159765 behaviour above):
  GuardPendingOnly,  \* BOOLEAN: run_started patch .where(status == 'pending'
                     \*   AND spec == held.spec) (#1065, events.ts:2601-2640)
                     \*   instead of status == held.status
  ResetOnlyRaised,   \* BOOLEAN: the wedged-run reset applies only to runs
                     \*   carrying raisedFromSpecVersion (4b7b241); others
                     \*   keep delete-and-rebuild
  AdoptOrphanRC,     \* BOOLEAN: #1061 createRunWithCreatedEvent: a slot
                     \*   conflict on the pinned run_created with no run row
                     \*   writes the run row alone (the caller adopts the
                     \*   orphaned run_created) instead of cancelling
  StepCheckConsistent, \* BOOLEAN: hypothetical server fix: the step write's
                     \*   running check uses a consistent read
  StaleSettles       \* BOOLEAN: timing premise: eventually consistent reads
                     \*   have converged by the time a redelivery or window
                     \*   retry (>= 1 s later) fetches the run

NoRow == [st |-> "none", sp |-> 0]
DeletedRow == [ex |-> FALSE, st |-> "none", sp |-> 0]
Terminal(s) == s \in {"cancelled", "failed", "completed"}
Slot(v) == v >= 6
Sealed(v) == v >= 7
Max(a, b) == IF a >= b THEN a ELSE b
Rekey(a, b) == ~Slot(a) /\ Slot(b)
RequiresFresh(a, b) == Rekey(a, b) \/ (~Sealed(a) /\ Sealed(b))
Crosses(a, b) == RequiresFresh(a, b)
RC == "run_created"

VARIABLES
  stamp, exec,       \* chosen once in Init
  row,               \* persisted run row [ex, st, sp]
  hist,              \* every committed row version [st, sp] (stale reads)
  peak,              \* ghost: highest row spec ever committed (any lifecycle)
  log,               \* set of event rows [t, k \in {"S","U"}, n, sp]
                     \*   (sp = the row's stored specVersion; only read for
                     \*   run_created, 0 elsewhere)
  clk,               \* ULID mint order (ULIDs sort above every slot)
  cpc,               \* caller pc
  epc, eheld, eatt, eid, erc, ersp,  \* executor deliveries
  kpc, kheld,        \* canceller
  sawUlid,           \* some executor replay loaded a ULID row
  crashes,           \* executor request crashes so far
  wleft,             \* HEAD: window retries left (the 60 s window, run-wide)
  ewr,               \* HEAD: this delivery's next fetch is a window retry
  erf,               \* HEAD: this delivery came through the conflict refetch
  eturbo,            \* HEAD: this delivery is a turbo first delivery
  rraised            \* f83173c: the run row carries raisedFromSpecVersion
                     \*   (only tracked when ResetOnlyRaised)

vars == <<stamp, exec, row, hist, peak, log, clk, cpc, epc, eheld, eatt, eid,
          erc, ersp, kpc, kheld, sawUlid, crashes, wleft, ewr, erf, eturbo,
          rraised>>
NUnch == <<wleft, ewr, erf, eturbo>>
EffExec == IF FlagOn THEN exec ELSE 0   \* attestation as the server uses it

-----------------------------------------------------------------------------
SEv == {e \in log : e.k = "S"}
UEv == {e \in log : e.k = "U"}
MaxS == IF SEv = {} THEN 0
        ELSE CHOOSE m \in {e.n : e \in SEv} : \A x \in SEv : x.n <= m
NextSlot == Max(MaxS + 1, 2)          \* minSlotForEventType floor = 2
MinOf(S) == CHOOSE e \in S : \A x \in S : e.n <= x.n
First == IF SEv # {} THEN MinOf(SEv) ELSE MinOf(UEv)   \* log # {}
RCs == {e \in log : e.t = RC}
RSs == {e \in log : e.t = "run_started"}
Slot1Taken == \E e \in log : e.k = "S" /\ e.n = 1

\* Slot allocation for a write whose request holds spec hs (allocatorFor):
\* the sequencer (sealed) never probes; the probing allocator 500s when the
\* highest sort key is a ULID.
CanAllocate(hs) == Sealed(hs) \/ UEv = {}

Ev(t, k, n, sp) == [t |-> t, k |-> k, n |-> n, sp |-> sp]

\* Append an event of type t in id mode kind (already decided from held spec).
AppendSp(t, kind, sp) ==
  IF kind = "U"
  THEN /\ log' = log \cup {Ev(t, "U", clk, sp)}
       /\ clk' = clk + 1
  ELSE /\ log' = log \cup {Ev(t, "S", NextSlot, sp)}
       /\ UNCHANGED clk
Append(t, kind) == AppendSp(t, kind, 0)

\* run_created insert at spec sp: slot 1 pinned (conditional create: a taken
\* slot 1 fails the write), or a fresh ULID.
RCInsert(sp) ==
  IF Slot(sp)
  THEN IF Slot1Taken
       THEN UNCHANGED <<log, clk>>
       ELSE /\ log' = log \cup {Ev(RC, "S", 1, sp)}
            /\ UNCHANGED clk
  ELSE AppendSp(RC, "U", sp)

SetRow(st, sp) ==
  /\ row' = [ex |-> TRUE, st |-> st, sp |-> sp]
  /\ hist' = hist \cup {[st |-> st, sp |-> sp]}
  /\ peak' = Max(peak, sp)

CurRow == [st |-> row.st, sp |-> row.sp]
Reads == IF StaleReads THEN hist ELSE {CurRow}   \* only used when row.ex

Live == row.ex /\ row.st \in {"pending", "running"}

-----------------------------------------------------------------------------
(* Timing assumption helpers                                               *)
\* pcs at which a delivery has no server request in flight
Boundary == {"fetch", "replay", "step", "done", "gone", "gaveup",
             "maxdel", "rf_read", "tstep"}
Quiet(d) ==
  /\ cpc \in {"done", "crashed"}
  /\ kpc \in {"read", "done"}
  /\ \A x \in D \ {d} : epc[x] \in Boundary
LatencyOK(d) == BoundedLatency => Quiet(d)
GraceOK(d) == GraceHolds => Quiet(d)
\* HEAD retry window: a 503 'run-spec-version-upgrade-pending' carries
\* Retry-After 1 s, so its redelivery starts once in-flight requests (ms)
\* have resolved; the window (60 s after run creation) closes after
\* RetryBudget such retries.
WinOK(d) == WindowHolds => Quiet(d)

-----------------------------------------------------------------------------
Init ==
  /\ stamp \in CallerStamps
  /\ exec \in ExecVersions
  /\ row = DeletedRow
  /\ hist = {}
  /\ peak = 0
  /\ log = {}
  /\ clk = 100
  /\ cpc = "row"
  /\ epc = [d \in D |-> "fetch"]
  /\ eheld = [d \in D |-> NoRow]
  /\ eatt = [d \in D |-> 1]
  /\ eid = [d \in D |-> "U"]
  /\ erc = [d \in D |-> Ev("none", "U", 0, 0)]
  /\ ersp = [d \in D |-> 0]
  /\ kpc = IF CancelEnabled THEN "read" ELSE "done"
  /\ kheld = NoRow
  /\ sawUlid = FALSE
  /\ crashes = 0
  /\ wleft = RetryBudget
  /\ ewr = [d \in D |-> FALSE]
  /\ erf = [d \in D |-> FALSE]
  /\ eturbo \in [D -> IF TurboWrites THEN BOOLEAN ELSE {FALSE}]
  /\ rraised = FALSE

-----------------------------------------------------------------------------
(* Caller: run_created POST                                                *)
CallerAtomic == RunCreatedAtomic \/ PropAtomicCreate

CallerRow ==
  /\ cpc = "row"
  /\ \/ /\ CallerMayFail                      \* retryable error, no write
        /\ cpc' = "done"
        /\ UNCHANGED <<row, hist, peak, log, clk>>
     \/ /\ row.ex                             \* 409 workflowRunExists
        /\ cpc' = "done"
        /\ UNCHANGED <<row, hist, peak, log, clk>>
     \/ /\ ~row.ex
        /\ IF CallerAtomic
           THEN IF Slot(stamp) /\ Slot1Taken /\ ~AdoptOrphanRC
                THEN /\ cpc' = "done"             \* TX cancelled on slot 1
                     /\ UNCHANGED <<row, hist, peak, log, clk>>
                ELSE IF Slot(stamp) /\ Slot1Taken
                THEN \* f83173c: slot 1 held, no run row -> row alone; the
                     \* event insert that follows conflicts (409 to start())
                     /\ SetRow("pending", stamp)
                     /\ cpc' = "done"
                     /\ UNCHANGED <<log, clk>>
                ELSE /\ SetRow("pending", stamp)
                     /\ RCInsert(stamp)
                     /\ cpc' = "done"
           ELSE /\ SetRow("pending", stamp)
                /\ cpc' = "evt"
                /\ UNCHANGED <<log, clk>>
  \* a (re)created row opens a new retry window (run.createdAt)
  /\ wleft' = IF ~row.ex /\ row'.ex THEN RetryBudget ELSE wleft
  /\ rraised' = IF ~row.ex /\ row'.ex THEN FALSE ELSE rraised
  /\ UNCHANGED <<stamp, exec, epc, eheld, eatt, eid, erc, ersp,
                 kpc, kheld, sawUlid, crashes, ewr, erf, eturbo>>

CallerEvt ==
  /\ cpc = "evt"
  /\ \/ /\ CallerMayCrash                     \* row committed, event never
        /\ cpc' = "crashed"
        /\ UNCHANGED <<log, clk>>
     \/ /\ RCInsert(stamp)
        /\ cpc' = "done"
  /\ UNCHANGED <<stamp, exec, row, hist, peak, epc, eheld, eatt, eid, erc,
                 ersp, kpc, kheld, sawUlid, crashes, rraised>>
  /\ UNCHANGED NUnch

-----------------------------------------------------------------------------
(* Executor deliveries: run_started server request, then replay + step     *)
ExUnch0 == <<stamp, exec, cpc, kpc, kheld, crashes>>
ExUnch == <<stamp, exec, cpc, kpc, kheld, crashes, rraised>>
RowUnch == <<row, hist, peak>>

\* A retryable failure of the run_started request: the queue redelivers.
\* A turbo first delivery backgrounds run_started and, once it has settled
\* (here: failed), still sends the step writes of its first replay
\* (wf core runtime.ts:1276-1293, 2500-2560; suspension-handler.ts:533-541
\* swallows the barrier rejection), then errors out and is redelivered.
Fail(d) ==
  IF eatt[d] < MaxAttempts
  THEN /\ epc' = [epc EXCEPT ![d] = IF eturbo[d] /\ eatt[d] = 1
                                    THEN "tstep" ELSE "fetch"]
       /\ eatt' = [eatt EXCEPT ![d] = @ + 1]
  ELSE /\ epc' = [epc EXCEPT ![d] = "maxdel"]   \* next delivery: run_failed
       /\ UNCHANGED eatt

Goto(d, pc) == epc' = [epc EXCEPT ![d] = pc]

\* HEAD: the terminal check after upgradeRunSpecVersion (ws events.ts
\* 8189-8207) exists on the main path only; the conflict-refetch path
\* (events.ts 8398-8420) has none unless FixReviveGap.
PostTermCheck(d) == HeadUpgrade /\ (~erf[d] \/ FixReviveGap)
AfterUpg(d) == Goto(d, IF PostTermCheck(d) /\ row.ex /\ Terminal(row.st)
                       THEN "gone" ELSE "trans")

\* spec carried by the synthetic resilient-start run_created
RsEventSp(d) == IF PropResilient /\ PropResilientEventMax THEN ersp[d]
                ELSE stamp

\* synthetic run_created write (id mode from ersp = the row spec it created)
RsEventWrite(d) ==
  IF Slot(ersp[d])
  THEN IF Slot1Taken
       THEN UNCHANGED <<log, clk>>                \* adopt existing slot 1
       ELSE /\ log' = log \cup {Ev(RC, "S", 1, RsEventSp(d))}
            /\ UNCHANGED clk
  ELSE AppendSp(RC, "U", RsEventSp(d))

ExFetch(d) ==
  /\ epc[d] = "fetch"
  /\ ewr[d] => WinOK(d)                               \* window retry
  /\ (eatt[d] > 1 /\ ~ewr[d]) => LatencyOK(d)         \* redelivery
  /\ \/ /\ ~row.ex /\ ResilientStart
        /\ Goto(d, "rs_create") /\ UNCHANGED eheld   \* resilient start
     \/ /\ ~row.ex /\ ~ResilientStart /\ cpc \in {"done", "crashed"}
        /\ Goto(d, "done") /\ UNCHANGED eheld        \* isolation knob only
     \/ /\ row.ex
        /\ \E r \in IF StaleSettles /\ (eatt[d] > 1 \/ ewr[d]) THEN {CurRow}
                    ELSE Reads :
             IF Terminal(r.st)
             THEN /\ Goto(d, "gone") /\ UNCHANGED eheld   \* 410
             ELSE /\ eheld' = [eheld EXCEPT ![d] = r]
                  /\ Goto(d, "upg_check")
  /\ ewr' = [ewr EXCEPT ![d] = FALSE]
  /\ erf' = [erf EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<row, hist, peak, log, clk, eatt, eid, erc, ersp, sawUlid,
                 wleft, eturbo>>
  /\ UNCHANGED ExUnch

ExRsCreate(d) ==
  /\ epc[d] = "rs_create"
  /\ IF row.ex
     THEN /\ Goto(d, "rs_refetch")                   \* EntityConflictError
          /\ UNCHANGED <<row, hist, peak, eheld, ersp, log, clk, wleft,
                         rraised>>
     ELSE LET rs == IF PropResilient THEN Max(stamp, EffExec) ELSE stamp IN
          /\ SetRow("pending", rs)
          /\ wleft' = RetryBudget                    \* new run.createdAt
          /\ rraised' = (ResetOnlyRaised /\ rs # stamp)  \* raisedFrom
          /\ eheld' = [eheld EXCEPT ![d] = [st |-> "pending", sp |-> rs]]
          /\ ersp' = [ersp EXCEPT ![d] = rs]
          /\ IF PropAtomicCreate                     \* P5: one TX
             THEN /\ IF Slot(rs)
                     THEN IF Slot1Taken
                          THEN UNCHANGED <<log, clk>>
                          ELSE /\ log' = log \cup {Ev(RC, "S", 1,
                                    IF PropResilient /\ PropResilientEventMax
                                    THEN rs ELSE stamp)}
                               /\ UNCHANGED clk
                     ELSE AppendSp(RC, "U",
                            IF PropResilient /\ PropResilientEventMax
                            THEN rs ELSE stamp)
                  /\ Goto(d, "trans")
             ELSE /\ Goto(d, "rs_event")
                  /\ UNCHANGED <<log, clk>>
  /\ UNCHANGED <<eatt, eid, erc, sawUlid, ewr, erf, eturbo>>
  /\ UNCHANGED ExUnch0

ExRsEvent(d) ==
  /\ epc[d] = "rs_event"
  /\ RsEventWrite(d)
  /\ Goto(d, "trans")                                \* no upgrade on this path
  /\ UNCHANGED <<row, hist, peak, eheld, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExRsRefetch(d) ==
  /\ epc[d] = "rs_refetch"
  /\ IF ~row.ex
     THEN /\ Fail(d) /\ UNCHANGED <<eheld, erf>>     \* gone again: retry
     ELSE \E r \in Reads :
            IF Terminal(r.st)
            THEN /\ Goto(d, "gone") /\ UNCHANGED <<eheld, eatt, erf>>
            ELSE /\ eheld' = [eheld EXCEPT ![d] = r]
                 /\ Goto(d, IF PropResilient THEN "upg_check" ELSE "trans")
                 /\ erf' = [erf EXCEPT ![d] = HeadUpgrade]
                 /\ UNCHANGED eatt
  /\ UNCHANGED <<row, hist, peak, log, clk, eid, erc, ersp, sawUlid,
                 wleft, ewr, eturbo>>
  /\ UNCHANGED ExUnch

ExUpgCheck(d) ==
  /\ epc[d] = "upg_check"
  /\ LET r == eheld[d] IN
       IF \/ EffExec <= r.sp                                \* not-newer
          \/ Terminal(r.st)                                 \* terminal
          \/ (RequiresFresh(r.sp, EffExec) /\ r.st # "pending") \* log-not-fresh
       THEN Goto(d, "trans")
       ELSE Goto(d, "upg_head")
  /\ UNCHANGED <<row, hist, peak, log, clk, eheld, eatt, eid, erc, ersp,
                 sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExUpgHead(d) ==
  /\ epc[d] = "upg_head"
  /\ LET from == eheld[d].sp
         fresh == RequiresFresh(from, EffExec)
         rk == Rekey(from, EffExec)
         reason == IF log = {} THEN "not-committed"
                   ELSE IF First.t # RC THEN "not-first"
                   ELSE IF fresh /\ Cardinality(log) > 1 THEN "not-fresh"
                   ELSE IF rk /\ First.k = "S"
                        THEN IF HeadUpgrade THEN "already-slot" ELSE "not-fresh"
                   ELSE "go"
         \* HEAD upgrade.ts: doomedIfSkipped = rekey && held status pending
         doomed == HeadUpgrade /\ rk /\ eheld[d].st = "pending"
     IN
     IF reason = "go"
     THEN /\ erc' = [erc EXCEPT ![d] = First]
          /\ Goto(d, "upg_tx")
          /\ UNCHANGED eatt
     ELSE IF doomed
     THEN /\ erc' = [erc EXCEPT ![d] = Ev(reason, "U", 0, 0)]  \* remember why
          /\ Goto(d, "upg_skip")                   \* reread-on-skip
          /\ UNCHANGED eatt
     ELSE IF \/ (PropRetrySkips /\ reason = "not-committed")
             \/ (PropRetryNotFresh /\ reason = "not-fresh")
     THEN /\ Fail(d)                        \* P2: retryable, redeliver
          /\ UNCHANGED erc
     ELSE /\ Goto(d, "trans")               \* skip: keep the INPUT run
          /\ UNCHANGED <<erc, eatt>>
  /\ UNCHANGED <<row, hist, peak, log, clk, eheld, eid, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

\* HEAD upgrade.ts skip(): a doomed skip rereads the run consistently; a
\* moved spec is a lost race (continue on the reread); otherwise, inside the
\* 60 s window and unless the reason is run-created-already-slot, a
\* retryable 503; past it, fall through with the INPUT run ("doomed").
ExUpgSkip(d) ==
  /\ epc[d] = "upg_skip"
  /\ IF row.ex /\ row.sp # eheld[d].sp
     THEN /\ eheld' = [eheld EXCEPT ![d] = CurRow]
          /\ AfterUpg(d)
          /\ UNCHANGED <<eatt, wleft, ewr, eturbo>>
     ELSE IF erc[d].t # "already-slot" /\ wleft > 0
     THEN /\ wleft' = wleft - 1                    \* 503, Retry-After 1
          /\ epc' = [epc EXCEPT ![d] = IF eturbo[d] /\ eatt[d] = 1
                                       THEN "tstep" ELSE "fetch"]
          /\ ewr' = [ewr EXCEPT ![d] = TRUE]
          /\ eturbo' = [eturbo EXCEPT ![d] = FALSE] \* redelivery: attempt 2
          /\ UNCHANGED <<eheld, eatt>>
     ELSE /\ Goto(d, "trans")                     \* window over: doomed
          /\ UNCHANGED <<eheld, eatt, wleft, ewr, eturbo>>
  /\ UNCHANGED <<row, hist, peak, log, clk, eid, erc, ersp, sawUlid, erf>>
  /\ UNCHANGED ExUnch

ExUpgTx(d) ==
  /\ epc[d] = "upg_tx"
  /\ LET from == eheld[d].sp
         fresh == RequiresFresh(from, EffExec)
         rk == Rekey(from, EffExec)
         rc == erc[d]
         Match == {e \in log : e.t = RC /\ e.k = rc.k /\ e.n = rc.n}
         cond == /\ row.ex
                 /\ row.sp = from
                 /\ IF fresh THEN row.st = "pending" ELSE ~Terminal(row.st)
                 /\ Match # {}                       \* where eventType==rc
                 /\ rk => ~Slot1Taken                \* conditional create
     IN
     IF cond
     THEN LET cur == CHOOSE e \in Match : TRUE IN
          /\ SetRow(row.st, EffExec)
          /\ rraised' = (ResetOnlyRaised \/ rraised)
          /\ IF rk
             THEN log' = (log \ {cur}) \cup {Ev(RC, "S", 1, EffExec)}
             ELSE log' = (log \ {cur}) \cup {[cur EXCEPT !.sp = EffExec]}
     ELSE UNCHANGED <<row, hist, peak, log, rraised>> \* cancelled: lost-race
  /\ Goto(d, "upg_reread")
  /\ UNCHANGED <<clk, eheld, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch0 /\ UNCHANGED NUnch

ExUpgReread(d) ==
  /\ epc[d] = "upg_reread"
  /\ IF row.ex
     THEN /\ eheld' = [eheld EXCEPT ![d] = CurRow]   \* consistent get
          /\ AfterUpg(d)
          /\ UNCHANGED eatt
     ELSE IF HeadUpgrade                             \* lostRace(reread ?? run)
     THEN /\ Goto(d, "trans") /\ UNCHANGED <<eheld, eatt>>
     ELSE /\ Fail(d) /\ UNCHANGED eheld              \* null reread throws
  /\ UNCHANGED <<row, hist, peak, log, clk, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

\* v4 recoverMissingRunEvent: past the grace window and with a log holding
\* only start events, delete the run row (conditional on status running).
\* HEAD (RecoveryReset): with a run_created in the log, reset the row to
\* pending instead (ws handlers/v4/events.ts:1864-1904, runs.ts:3954-3990:
\* patch status=pending where status=running AND startedAt=observed; the
\* grace premise makes the observed startedAt the current one).
RecoveryDeletes(d) ==
  /\ row.ex /\ row.st = "running"
  /\ \A e \in log : e.t \in {RC, "run_started"}
  /\ GraceOK(d)

ExTrans(d) ==
  /\ epc[d] = "trans"
  /\ LET h == eheld[d] IN
     /\ eid' = [eid EXCEPT ![d] = IF Slot(h.sp) THEN "S" ELSE "U"]
     /\ IF h.st = "running"
        THEN IF RSs # {}
             THEN /\ Goto(d, "replay")               \* alreadyRunning
                  /\ UNCHANGED <<row, hist, peak, eheld, eatt>>
             ELSE /\ IF RecoveryDeletes(d)            \* wedge
                     THEN IF /\ RecoveryReset /\ RCs # {}
                             /\ ResetOnlyRaised => rraised
                          THEN SetRow("pending", row.sp)   \* HEAD: reset
                          ELSE /\ row' = DeletedRow        \* delete row
                               /\ UNCHANGED <<hist, peak>>
                     ELSE UNCHANGED RowUnch           \* grace / progress
                  /\ Fail(d)                          \* 503 either way
                  /\ UNCHANGED eheld
        ELSE IF ~row.ex
        THEN /\ Fail(d)                               \* patch on missing row
             /\ UNCHANGED <<row, hist, peak, eheld>>
        ELSE IF HeadGuardStart
        THEN \* HEAD events.ts:2417-2445: .where(status == held.status AND
             \* specVersion == held.specVersion); on a conditional failure
             \* resolveStaleRunStarted (7120-7159) rereads consistently.
             IF /\ IF GuardPendingOnly THEN row.st = "pending"
                   ELSE row.st = h.st
                /\ row.sp = h.sp
             THEN /\ SetRow("running", row.sp)
                  /\ Goto(d, "rs_insert")
                  /\ UNCHANGED <<eheld, eatt>>
             ELSE IF Terminal(row.st)
             THEN /\ Goto(d, "gone")                  \* 410
                  /\ UNCHANGED <<row, hist, peak, eheld, eatt>>
             ELSE IF row.st = "running"
             THEN /\ eheld' = [eheld EXCEPT ![d] = CurRow]  \* alreadyRunning
                  /\ Goto(d, "trans")
                  /\ UNCHANGED <<row, hist, peak, eatt>>
             ELSE /\ Fail(d)                          \* 503 spec changed
                  /\ UNCHANGED <<row, hist, peak, eheld>>
        ELSE IF ~PropGuardStart
        THEN /\ SetRow("running", row.sp)            \* unconditional patch
             /\ Goto(d, "rs_insert")
             /\ UNCHANGED <<eheld, eatt>>
        ELSE IF row.st = "pending" /\ row.sp = h.sp
        THEN /\ SetRow("running", row.sp)
             /\ Goto(d, "rs_insert")
             /\ UNCHANGED <<eheld, eatt>>
        ELSE /\ eheld' = [eheld EXCEPT ![d] = CurRow]  \* reread
             /\ Goto(d, IF Terminal(row.st) THEN "gone" ELSE "upg_check")
             /\ UNCHANGED <<row, hist, peak, eatt>>
  /\ UNCHANGED <<log, clk, erc, ersp, sawUlid>>
  \* a deleted row loses its raisedFromSpecVersion marker
  /\ rraised' = IF row.ex /\ ~row'.ex THEN FALSE ELSE rraised
  /\ UNCHANGED ExUnch0 /\ UNCHANGED NUnch

ExRsInsert(d) ==
  /\ epc[d] = "rs_insert"
  /\ IF eid[d] = "S" /\ ~CanAllocate(eheld[d].sp)
     THEN /\ Fail(d)                                  \* 500 mixed identity
          /\ UNCHANGED <<log, clk>>
     ELSE /\ Append("run_started", eid[d])
          /\ Goto(d, "replay")
          /\ UNCHANGED eatt
  /\ UNCHANGED <<row, hist, peak, eheld, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

\* A server request dies after a committed write, before its response.
Crash(d) ==
  /\ crashes < MaxCrashes
  /\ epc[d] \in {"rs_event", "rs_insert", "upg_reread"}
  /\ Fail(d)
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<row, hist, peak, log, clk, eheld, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED <<stamp, exec, cpc, kpc, kheld, rraised>> /\ UNCHANGED NUnch

\* Turbo step write after a failed run_started (see Fail): the step
\* request's run read (EC) must say running when StepStatusCheck
\* (ws events.ts:2239-2241 fetchAndValidateRun -> WorkflowNotRunningError
\* 410; batch path events.ts:11154), else only a terminal run rejects it.
ExTStep(d) ==
  /\ epc[d] = "tstep"
  /\ IF ~row.ex
     THEN /\ Goto(d, "fetch") /\ UNCHANGED eheld      \* 404
     ELSE \E r \in IF StepCheckConsistent THEN {CurRow} ELSE Reads :
            IF Terminal(r.st) \/ (StepStatusCheck /\ r.st # "running")
            THEN /\ Goto(d, "fetch") /\ UNCHANGED eheld   \* 409/410
            ELSE /\ eheld' = [eheld EXCEPT ![d] = r]
                 /\ Goto(d, "tstep_ins")
  /\ UNCHANGED <<row, hist, peak, log, clk, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExTStepIns(d) ==
  /\ epc[d] = "tstep_ins"
  /\ LET kind == IF Slot(eheld[d].sp) THEN "S" ELSE "U" IN
     IF kind = "S" /\ ~CanAllocate(eheld[d].sp)
     THEN UNCHANGED <<log, clk>>                      \* 500
     ELSE Append("step_created", kind)
  /\ Goto(d, "fetch")                                 \* then redelivered
  /\ UNCHANGED <<row, hist, peak, eheld, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExReplay(d) ==
  /\ epc[d] = "replay"
  /\ IF UEv # {}                   \* requireEventSlot throws -> run_failed
     THEN /\ sawUlid' = TRUE
          /\ Goto(d, "rf_read")
     ELSE IF RCs = {}              \* SCHEMA_VALIDATION -> setup failure
     THEN /\ Goto(d, "rf_read")
          /\ UNCHANGED sawUlid
     ELSE /\ Goto(d, "step")
          /\ UNCHANGED sawUlid
  /\ UNCHANGED <<row, hist, peak, log, clk, eheld, eatt, eid, erc, ersp>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExStep(d) ==
  /\ epc[d] = "step"
  /\ IF ~row.ex
     THEN /\ Goto(d, "done") /\ UNCHANGED eheld      \* 404
     ELSE \E r \in Reads :
            \/ /\ r.st = "running"
               /\ eheld' = [eheld EXCEPT ![d] = r]
               /\ Goto(d, "step_ins")
            \/ /\ Terminal(r.st)                     \* 409/410
               /\ Goto(d, "done")
               /\ UNCHANGED eheld
            \/ /\ r.st = "pending" /\ row.st = "pending"
               /\ Goto(d, "done")                    \* row deleted + rebuilt
               /\ UNCHANGED eheld                    \* WorkflowNotRunning
            \* A stale "pending" read of a row that has moved on is not
            \* modelled as a separate outcome: the SDK retries the step
            \* call, which is the same as picking a fresh read here.
  /\ UNCHANGED <<row, hist, peak, log, clk, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExStepIns(d) ==
  /\ epc[d] = "step_ins"
  /\ LET kind == IF Slot(eheld[d].sp) THEN "S" ELSE "U" IN
     IF kind = "S" /\ ~CanAllocate(eheld[d].sp)
     THEN UNCHANGED <<log, clk>>                      \* 500
     ELSE Append("step_created", kind)
  /\ Goto(d, "done")
  /\ UNCHANGED <<row, hist, peak, eheld, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

\* run_failed POST (MAX_DELIVERIES_EXCEEDED, or terminal replay error)
ExRfRead(d) ==
  /\ epc[d] \in {"maxdel", "rf_read"}
  /\ epc[d] = "maxdel" => LatencyOK(d)
  /\ IF ~row.ex
     THEN /\ Goto(d, "gaveup") /\ UNCHANGED eheld    \* 404: left as is
     ELSE \E r \in Reads :
            IF Terminal(r.st)
            THEN /\ Goto(d, "gone") /\ UNCHANGED eheld   \* 409: consumed
            ELSE /\ eheld' = [eheld EXCEPT ![d] = r]
                 /\ Goto(d, "rf_write")
  /\ UNCHANGED <<row, hist, peak, log, clk, eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

ExRfWrite(d) ==
  /\ epc[d] = "rf_write"
  /\ LET h == eheld[d] IN
     IF ~row.ex
     THEN /\ Goto(d, "gaveup")
          /\ UNCHANGED <<row, hist, peak, log, clk, eheld>>
     ELSE IF Slot(h.sp)                               \* one TX
     THEN IF Terminal(row.st)
          THEN /\ Goto(d, "gone")
               /\ UNCHANGED <<row, hist, peak, log, clk, eheld>>
          ELSE IF CanAllocate(h.sp)
          THEN /\ SetRow("failed", row.sp)
               /\ Append("run_failed", "S")
               /\ Goto(d, "done")
               /\ UNCHANGED eheld
          ELSE /\ Goto(d, "gaveup")                   \* 500
               /\ UNCHANGED <<row, hist, peak, log, clk, eheld>>
     ELSE IF ~Terminal(row.st) /\ (PropCancelGuard => row.sp = h.sp)
     THEN /\ SetRow("failed", row.sp)
          /\ Append("run_failed", "U")
          /\ Goto(d, "done")
          /\ UNCHANGED eheld
     ELSE IF PropCancelGuard /\ ~Terminal(row.st)
     THEN /\ eheld' = [eheld EXCEPT ![d] = CurRow]    \* reread, retry
          /\ UNCHANGED <<epc, row, hist, peak, log, clk>>
     ELSE /\ Goto(d, "gone")                          \* already finished
          /\ UNCHANGED <<row, hist, peak, log, clk, eheld>>
  /\ UNCHANGED <<eatt, eid, erc, ersp, sawUlid>>
  /\ UNCHANGED ExUnch /\ UNCHANGED NUnch

-----------------------------------------------------------------------------
(* Canceller: run_cancelled POST                                           *)
KUnch == <<stamp, exec, cpc, epc, eheld, eatt, eid, erc, ersp, sawUlid,
          crashes, wleft, ewr, erf, eturbo, rraised>>

KRead ==
  /\ kpc = "read"
  /\ IF ~row.ex
     THEN /\ kpc' = "done" /\ UNCHANGED kheld                 \* 404
     ELSE \E r \in Reads :
            IF Terminal(r.st)
            THEN /\ kpc' = "done" /\ UNCHANGED kheld          \* 409
            ELSE /\ kheld' = r /\ kpc' = "patch"
  /\ UNCHANGED <<row, hist, peak, log, clk>>
  /\ UNCHANGED KUnch

KPatch ==
  /\ kpc = "patch"
  /\ IF ~row.ex
     THEN /\ kpc' = "done"                            \* patch on missing row
          /\ UNCHANGED <<row, hist, peak, log, clk, kheld>>
     ELSE IF Slot(kheld.sp)
     THEN \* commitRunPatchWithEvent: one TX, guard non-terminal
          /\ IF ~Terminal(row.st) /\ CanAllocate(kheld.sp)
             THEN /\ SetRow("cancelled", row.sp)
                  /\ Append("run_cancelled", "S")
             ELSE UNCHANGED <<row, hist, peak, log, clk>>  \* 409 / 500
          /\ kpc' = "done"
          /\ UNCHANGED kheld
     ELSE IF ~Terminal(row.st) /\ (PropCancelGuard => row.sp = kheld.sp)
     THEN /\ SetRow("cancelled", row.sp)
          /\ kpc' = "insert"
          /\ UNCHANGED <<log, clk, kheld>>
     ELSE IF PropCancelGuard /\ ~Terminal(row.st)
     THEN /\ kheld' = CurRow /\ kpc' = "patch"       \* reread, retry
          /\ UNCHANGED <<row, hist, peak, log, clk>>
     ELSE /\ kpc' = "done"                            \* throwRunAlreadyFinished
          /\ UNCHANGED <<row, hist, peak, log, clk, kheld>>
  /\ UNCHANGED KUnch

KInsert ==
  /\ kpc = "insert"
  /\ Append("run_cancelled", "U")
  /\ kpc' = "done"
  /\ UNCHANGED <<row, hist, peak, kheld>>
  /\ UNCHANGED KUnch

-----------------------------------------------------------------------------
AllDone ==
  /\ cpc \in {"done", "crashed"} /\ kpc = "done"
  /\ \A d \in D : epc[d] \in {"done", "gone", "gaveup"}

ProcNext ==
  \/ CallerRow \/ CallerEvt
  \/ \E d \in D : \/ ExFetch(d) \/ ExRsCreate(d) \/ ExRsEvent(d)
                  \/ ExRsRefetch(d) \/ ExUpgCheck(d) \/ ExUpgHead(d)
                  \/ ExUpgTx(d) \/ ExUpgReread(d) \/ ExTrans(d)
                  \/ ExRsInsert(d) \/ Crash(d) \/ ExReplay(d) \/ ExStep(d)
                  \/ ExStepIns(d) \/ ExRfRead(d) \/ ExRfWrite(d)
                  \/ ExUpgSkip(d) \/ ExTStep(d) \/ ExTStepIns(d)
  \/ KRead \/ KPatch \/ KInsert

Next == ProcNext \/ (AllDone /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(ProcNext)

-----------------------------------------------------------------------------
(* Invariants                                                              *)
TypeOK ==
  /\ row.ex \in BOOLEAN
  /\ \A e \in log : e.k \in {"S", "U"}
  /\ \A d \in D : eatt[d] \in 1..MaxAttempts
  /\ wleft \in 0..RetryBudget

\* No transient in-flight write that is allowed to leave the log briefly
\* out of shape (caller between row and run_created, resilient start between
\* row and synthetic run_created).
Settled == cpc # "evt" /\ \A d \in D : epc[d] # "rs_event"

\* A log never holds both slot ids and ULIDs.
NoMixedIdentityLog == ~(SEv # {} /\ UEv # {})

\* The executor (min version 6 on v5) never loads a ULID row, and once
\* run_started is committed every row is slot-numbered.
ExecutorReadable ==
  /\ ~sawUlid
  /\ (RSs # {} => UEv = {})

\* A live run whose log holds anything also holds a run_created (the client
\* cannot rebuild the run without it).
RunCreatedPresent ==
  (Live /\ log # {} /\ Settled) => RCs # {}

\* A live run with a non-empty log has exactly one run_created and it sorts
\* first. (Strengthened: no longer vacuous when run_created is missing.)
RunCreatedFirstAndUnique ==
  (Live /\ log # {} /\ Settled) =>
    /\ Cardinality(RCs) = 1
    /\ First.t = RC

\* Informational: same shape for any status (a ULID-mode run cancelled
\* between its run-row create and its run_created insert sorts
\* run_cancelled first -- pre-existing, terminal).
RunCreatedFirstAndUniqueStrict ==
  /\ Cardinality(RCs) <= 1
  /\ (RCs # {} => First.t = RC)

\* The run row and its run_created EVENT agree on specVersion. Non-turbo
\* executors rebuild run.specVersion from the event row; the force-claim
\* gate and the id allocator trust the run row.
RunCreatedSpecMatchesRow ==
  (Live /\ Settled) => \A e \in RCs : e.sp = row.sp

\* A live (pending/running) run that the executor can never read: it holds a
\* ULID row that no future raise can re-key (the only healable ULID state is a
\* pending run whose whole log is one ULID run_created), or it is running
\* below slot identity (the executor will write ULIDs).
Healable == /\ row.st = "pending"
            /\ ~Slot(row.sp)
            /\ \A e \in log : e.t = RC
NoDoomedRun ==
  Live =>
    ~( (UEv # {} /\ ~Healable)
       \/ (row.st = "running" /\ ~Slot(row.sp)) )

\* An executor replay never hits a load failure (ULID row, or a log with no
\* run_created). rf_read is only entered from ExReplay's failure branches;
\* every such failure ends in a terminal run_failed of a run the caller
\* believes healthy. (MAX_DELIVERIES failures are timing-dependent and are
\* judged by GoodOutcome in the progress run instead.)
ReplayNeverFails == \A d \in D : epc[d] # "rf_read"

\* The run's spec is never lowered, across a recovery delete + rebuild too.
SpecNeverLowered == row.ex => row.sp >= peak

\* Progress: every non-final state has a successor ...
NoStuck == AllDone \/ ENABLED ProcNext

\* ... and every final state is a healthy outcome: the run never existed,
\* was cancelled, or is running with run_started and executor progress.
\* A run_failed (MAX_DELIVERIES_EXCEEDED or replay failure), a run left
\* pending/wedged, or a run row deleted and never rebuilt is a failure.
GoodOutcome ==
  AllDone =>
    \/ ~row.ex /\ log = {}
    \/ row.ex /\ row.st = "cancelled"
    \/ /\ row.ex /\ row.st = "running" /\ RSs # {}
       /\ \E e \in log : e.t = "step_created"

\* Informational (pre-existing weaknesses, not #1044-specific):
AtMostOneRunStarted == Cardinality(RSs) <= 1

(* Action / temporal properties                                            *)
SpecMonotonic == [][(row.ex /\ row'.ex) => row'.sp >= row.sp]_vars

NoStructuralCrossAfterFirstNonCreatedEvent ==
  [][(row.ex /\ row'.ex /\ Crosses(row.sp, row'.sp)) =>
        \A e \in log : e.t = RC]_vars

TerminalIsFinal == [][(row.ex /\ Terminal(row.st)) => row'.st = row.st]_vars

\* Liveness (checked with FairSpec): every behaviour quiesces.
Termination == <>AllDone
=============================================================================
