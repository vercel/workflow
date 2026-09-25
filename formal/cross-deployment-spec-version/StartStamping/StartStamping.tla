---------------------------- MODULE StartStamping ----------------------------
(***************************************************************************)
(* End-to-end spec-version negotiation for ONE workflow run: the caller's *)
(* stamp (start / replay / CLI) composed with the server's run_started    *)
(* raise (#4366 + #1044) under real interleavings.                        *)
(*                                                                         *)
(* TWO LAYERS, ONE STATE MACHINE                                           *)
(*  Layer A (stamp). Init picks a scenario scn (caller profile, target     *)
(*   profile, World, start kind, probe outcome, attributes, explicit or    *)
(*   source spec). Stamp(scn) is a pure function of scn. The Layer-A      *)
(*   invariants (NoOverStamp, CallerCap, CallerCapExplicit,               *)
(*   AttrGateMatchesStamp, AttributesGateCorrect, TargetCanReadInput) are *)
(*   state predicates over scn, and the ASSUME block at the bottom prints *)
(*   every violating scenario class per invariant.                        *)
(*  Layer B (server + executor). From the stamp, the run's life is a set  *)
(*   of interleaved processes over shared server state (run row, event    *)
(*   log with per-row id kind, stale-read history):                        *)
(*     Caller     run_created: run-row create, then a SEPARATE event       *)
(*                insert whose id mode comes from the request's own run   *)
(*                object (server events.ts:1979-2133, 8277-8300); may fail *)
(*                retryably before writing (resilient start) or die        *)
(*                between the two writes.                                  *)
(*     Exec[d]    queue deliveries (duplicates / redeliveries / turbo     *)
(*                re-invocations): fetch (possibly stale), #1044 upgrade  *)
(*                (check + head read, then transaction), state patch,     *)
(*                run_started insert in the HELD run's id mode, replay,   *)
(*                completion (return value or error). Missing run ->      *)
(*                resilient start. alreadyRunning without a run_started    *)
(*                row -> 503, and past the grace window the v4 missing-run-*)
(*                event recovery deletes ONLY the run row (events stay),  *)
(*                so the retried run_started rebuilds via resilient start. *)
(*                A request may die after a committed write (Crash).       *)
(*     Canceller  run_cancelled racing the upgrade (status condition,     *)
(*                lost-race reread; ULID-mode patch then separate insert). *)
(*   The Layer-B state is keyed by the scenario's CLASS (stamp, target,   *)
(*   World, caller decode ability) through VIEW, so every class's        *)
(*   interleavings are explored once while every scenario still gets its  *)
(*   Layer-A predicates checked (their truth values are part of the view).*)
(*                                                                         *)
(* CODE MAP (workflow = github.com/vercel/workflow,                      *)
(*           server   = github.com/vercel/workflow-server @ d0575db)      *)
(*  Profiles                                                              *)
(*   CallerMint / TMint = World.specVersion = mintedSpecVersion() at       *)
(*     createWorld (main world/src/spec-version.ts:170-176: 8, or 6 with  *)
(*     WORKFLOW_SEALED_LOG=0; #4327 head 764eafd1a: 7; stable 3).         *)
(*   CallerMax / TMax (= reader capability) = SPEC_VERSION_MAX_SUPPORTED   *)
(*     (main 8, #4327 head 7, stable 3 = CURRENT, no MAX on stable).       *)
(*   TResp = the health responder's value, fixed at createWorld            *)
(*     (764eafd1a helpers.ts:194 worldSpecVersion ?? CURRENT).             *)
(*   Exec mint (attested) = mintedSpecVersion() re-read from process.env   *)
(*     on EVERY run_started (#4366 world-vercel events.ts:765-770), so     *)
(*     with EnvDrift a main target's processes may attest 6 or 8           *)
(*     independently of TResp. T_X9 = a future SDK minting 9: the server   *)
(*     accepts any integer >= 1 (server v4/headers.ts:518-523, no ceiling, *)
(*     version-utils.ts:49-102).                                           *)
(*   T_B4/T_B5/C_B4 = older v5 betas (spec 4 attributes / 5 compression), *)
(*     pre-#4327 code, no #4366, no slot-id requirement (requireEventSlot *)
(*     arrived with 6). T_P2 = pre-spec-3 deployment (plain-text reply).   *)
(*  Stamp                                                                  *)
(*   StartProbeTarget  764eafd1a start.ts:117-138 (reply -> reply;         *)
(*                     plain -> 2; miss/no channel -> 6 = MissFloor),      *)
(*                     min with world.specVersion (line 137).             *)
(*   explicit wins     start.ts:587-588 opts.specVersion ?? target, uncapped*)
(*                     and unvalidated: ex in {0} \cup 1..9 on every start  *)
(*                     kind (0 = unset).                                    *)
(*   pre-#4327/stable  origin/main start.ts:449, origin/stable start.ts:248*)
(*   replaySame        runs.ts:83-130 run.specVersion ?? LEGACY(1).         *)
(*   replayRedirect    #4327: options.specVersion ?? undefined -> probe;    *)
(*                     main before #4327 and stable (runs.ts:64-65):        *)
(*                     options.specVersion ?? run.specVersion ?? LEGACY.    *)
(*                     ex = that explicit/source value (0 = both unset).   *)
(*   #4327 @ 29197a10f (HeadMalformed3, CliCapsSource, probe "badjson"):    *)
(*                     start.ts:156-182 a JSON reply without a valid       *)
(*                     version -> 3 ('probe-malformed'), plain text -> 2,  *)
(*                     miss -> 6; cli run.ts:94-108 ignores a version that *)
(*                     is not an integer >= 1 and caps run.specVersion at  *)
(*                     world.specVersion. The probe cache (start.ts:250-   *)
(*                     320) changes only WHEN a start gets fast/miss, not  *)
(*                     the set of outcomes: see ProbeCache.tla.            *)
(*   #4366 @ 03e6e6771 attests world.specVersion captured at createWorld   *)
(*                     (world-vercel index.ts:31-34, events.ts:779-781):   *)
(*                     EnvDrift is no longer reachable inside one process; *)
(*                     variant i_ keeps it as the d2b83751f behaviour.     *)
(*   cli               764eafd1a cli inspect/run.ts:87-109: min(hc, world)  *)
(*                     only on a versioned reply, else run.specVersion      *)
(*                     uncapped; run.specVersion undefined (ex = 0) passes  *)
(*                     undefined, so start() resolves it itself.           *)
(*   Gate              start.ts:595-661 attributes throw when stamp < 4.   *)
(*   Input compression main start.ts:598-613: targetSupportsCompression   *)
(*                     (same deployment, or probe workflowCoreVersion with *)
(*                     gzip per capabilities.ts FORMAT_VERSION_TABLE) AND  *)
(*                     stamp >= 5.                                         *)
(*  Server (Layer B)                                                       *)
(*   Upgrade  run-spec-version-upgrade.ts:96-208 (see actions XUpg/XTx).    *)
(*   Trans    events.ts:2376-2415 unconditional running patch (no .where). *)
(*   Insert   event id mode from the held run's spec (event-slot-identity. *)
(*            ts:143-160); probing allocator 500s on a ULID at the top of  *)
(*            the log (171-193); sealed runs use the sequencer (no probe,  *)
(*            events.ts:1814-1857, slot-sequencer.ts:141-180).            *)
(*   Resilient events.ts:8056-8238 (row at input.specVersion = stamp,      *)
(*            synthetic run_created id slot 1 iff Slot(stamp), adopt an    *)
(*            existing slot-1 row; conflict refetch; NO upgrade).          *)
(*   Recovery v4/events.ts:1650-1830 deletes only the run entity.          *)
(*   Terminal events.ts:2417-2650 guarded non-terminal patch; slot mode    *)
(*            atomic with the event row, ULID mode patch then insert.     *)
(*  Executor                                                               *)
(*   replay   requireEventSlot on every loaded event, unconditional        *)
(*            (world/src/slot-identity.ts:116-124, core helpers.ts:878-960)*)
(*            -> run_failed (runtime.ts:817-875). Non-turbo setup rebuilds *)
(*            the run from the preload's run_created row (world-vercel     *)
(*            events.ts:771-795): no run_created -> SCHEMA_VALIDATION ->   *)
(*            run_failed. Turbo (attempt 1, stamp >= 3) skips the preload  *)
(*            and keeps runInput.specVersion = stamp in memory             *)
(*            (runtime.ts:2506-2600).                                      *)
(*   output   workflow.ts:1254 (return value) and runtime.ts:430 (run      *)
(*            error) compress iff in-memory spec >= 5 and the executor's   *)
(*            code knows compression (TMax >= 5). Callers decode only      *)
(*            'devl'/'encr' unless CallerMax >= 5 (stable serialization-   *)
(*            format.ts:15-20,58-87).                                      *)
(*  Local Worlds (world-local / world-postgres): never raise, ids from     *)
(*   their own counter, RunNotSupportedError on every non-run_created     *)
(*   event when spec > MAX (events-storage.ts:1242, storage.ts:1247).     *)
(*                                                                         *)
(* NOT MODELLED (documented residuals): framedByteStreams (not a spec      *)
(*  gate, driven by getRunCapabilities only); sequencer counter drift;    *)
(*  a zero-step turbo workflow that never reloads its log; CLI probe world *)
(*  vs start()'s getWorldLazy world; the queue's real delivery horizon    *)
(*  (MaxAttempts is small, so run_failed MAX_DELIVERIES_EXCEEDED is not   *)
(*  counted as a brick: see the sibling ServerRaiseProtocol for timing).  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    CallerHas4327,       \* main-line v5 callers run #4327's start/recreate/CLI
    MissFloor,           \* stamp target when the probe misses (#4327: 6)
    ProbeBudgetSec,      \* start()'s probe budget in seconds (#4327: 10)
    ServerRaise,         \* #4366 + #1044 deployed
    RaiseOnResilient,    \* proposed P1(+P1e): resilient start creates the row
                         \*  at Max(stamp, attested), keys and stamps its
                         \*  synthetic run_created at that version, and the
                         \*  conflict refetch runs the upgrade
    RaiseOnNotCommitted, \* proposed (naive): the upgrade raises the ROW even
                         \*  when run_created's event row is not committed yet
    FixLateRunCreated,   \* proposed: the run_created event insert re-reads the
                         \*  persisted row and takes id mode + specVersion from it
    FixSkipReread,       \* proposed P2: run-created-not-committed -> retryable;
                         \*  log-not-fresh / not-first -> consistent reread
    FixGuardStart,       \* proposed P4: run_started patch conditioned on
                         \*  status == pending AND spec == held spec
    FixRecoveryAdopt,    \* proposed: resilient start reads the log head and, if
                         \*  a run_created survives, rebuilds the row at ITS spec
                         \*  and does not write a second run_created
    FixConsistentIdMode, \* proposed: every post-start event insert (terminal,
                         \*  cancel) takes its id mode from the run row inside the
                         \*  writing transaction, not from an EC / preloaded read
    FixAtomicCreate,     \* proposed P5: run row + its run_created event commit
                         \*  in one transaction (caller AND resilient start)
    FixCompressOnStamp,  \* proposed: payload compression gated on
                         \*  min(caller stamp, run spec): the stamp is what the
                         \*  caller can decode, the raise must not widen it
    EnvDrift,            \* main targets' processes may mint 6 or 8 per call
    MutAttestAboveMax,   \* MUTANT: attest mint+1 (shows NoOverRaise can fail)
    D,                   \* delivery ids
    MaxAttempts,         \* attempts per delivery before MAX_DELIVERIES run_failed
    StaleReads,          \* EC / preloaded run reads may return an older version
    CallerMayFail,       \* run_created may fail retryably before writing
    CancelEnabled,       \* a canceller exists
    RecoveryEnabled,     \* v4 missing-run-event recovery (row delete)
    MaxCrashes,          \* server requests that may die after a committed write
    ScenarioFilter,      \* "all" | "default" | "explicit" | "legacyCallers"
    RaceScope,           \* "all" | "attesting": restrict to world-vercel targets
                         \*  that run #4366 (the only runs the server raises);
                         \*  used to keep the cancel / crash+recovery races small
    MalformedReplies,    \* JSON targets may answer with a malformed specVersion
                         \*  (probe kind "badjson"; a community World / bug)
    HeadMalformed3,      \* #4327 @ 29197a10f: start() stamps a JSON reply
                         \*  without a valid version 3 ('probe-malformed');
                         \*  FALSE = 764eafd1a (-> 2, like plain text)
    CliCapsSource,       \* #4327 @ 29197a10f: `wf inspect` caps the source
                         \*  run's version at its World too (cli run.ts:94-97)
    FocusInv             \* "ALL" (full run, prints the Layer-A summary), "LB"
                         \* (Layer-B-only run: no summary, Layer-A verdicts out
                         \* of the VIEW), or a Layer-A invariant name: restrict
                         \* Init to its score-minimal violating scenario

Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b
MaxOf(S) == CHOOSE m \in S : \A x \in S : x <= m

Specs == 1..9

(* ---------------- caller profiles ---------------- *)
Callers == {"C_V4", "C_B4", "C_B7", "C_H7", "C_M6", "C_M8"}
\* C_V4 stable v4 (mint 3 / max 3)
\* C_B4 older v5 beta at spec 4 (4/4), pre-#4327 code, no compression
\* C_B7 published v5 beta (7/7), pre-#4327 code
\* C_H7 #4327 head as-is (7/7)
\* C_M6 main with WORKFLOW_SEALED_LOG=0 (mint 6 / max 8)
\* C_M8 main (8/8)
CallerMint == [c \in Callers |->
    CASE c = "C_V4" -> 3 [] c = "C_B4" -> 4 [] c = "C_B7" -> 7
      [] c = "C_H7" -> 7 [] c = "C_M6" -> 6 [] c = "C_M8" -> 8]
CallerMax == [c \in Callers |->
    CASE c = "C_V4" -> 3 [] c = "C_B4" -> 4 [] c = "C_B7" -> 7
      [] c = "C_H7" -> 7 [] c = "C_M6" -> 8 [] c = "C_M8" -> 8]
CallerCode(c) ==
    IF c = "C_V4" THEN "stable"
    ELSE IF c \in {"C_B4", "C_B7"} THEN "pre4327"
    ELSE IF CallerHas4327 THEN "4327" ELSE "pre4327"
IsV5Caller(c) == c # "C_V4"
CallerDecodes(c) == CallerMax[c] >= 5      \* knows gzip/zstd
Mainline == {"C_H7", "C_M6", "C_M8"}

(* ---------------- target profiles ---------------- *)
Targets == {"T_P2", "T_V4", "T_B4", "T_B5", "T_B7", "T_S6", "T_M8", "T_X9"}
TResp == [t \in Targets |->      \* health responder value (0 = plain text)
    CASE t = "T_P2" -> 0 [] t = "T_V4" -> 3 [] t = "T_B4" -> 4
      [] t = "T_B5" -> 5 [] t = "T_B7" -> 7 [] t = "T_S6" -> 6
      [] t = "T_M8" -> 8 [] t = "T_X9" -> 9]
TMint == [t \in Targets |-> IF t = "T_P2" THEN 2 ELSE TResp[t]]
TMax == [t \in Targets |->       \* reader capability of the target's code
    CASE t = "T_P2" -> 2 [] t = "T_V4" -> 3 [] t = "T_B4" -> 4
      [] t = "T_B5" -> 5 [] t = "T_B7" -> 7 [] t = "T_S6" -> 8
      [] t = "T_M8" -> 8 [] t = "T_X9" -> 9]
TReply(t) == IF t = "T_P2" THEN "plain" ELSE "json"
TAttests(t) == t \in {"T_S6", "T_M8", "T_X9"}        \* runs #4366
ReaderNeedsSlots(t) == TMax[t] >= 6                    \* requireEventSlot
TCompresses(t) == TMax[t] >= 5                         \* executor code
TCoreGzip(t) == TMax[t] >= 5 /\ TReply(t) = "json"     \* probe core version
ExecMints(t) ==
    IF EnvDrift /\ t \in {"T_S6", "T_M8"} THEN {6, 8} ELSE {TMint[t]}
SameTarget == [c \in Callers |->
    CASE c = "C_V4" -> "T_V4" [] c = "C_B4" -> "T_B4" [] c = "C_B7" -> "T_B7"
      [] c = "C_H7" -> "T_B7" [] c = "C_M6" -> "T_S6" [] c = "C_M8" -> "T_M8"]

Worlds == {"vercel", "local"}
StartKinds == {"same", "cross", "latestOther"}
Kinds  == StartKinds \cup {"replaySame", "replayRedirect", "cli"}
Probes == {"fast", "slow", "miss", "nochan"}   \* slow = answers in (2s, 10s]
\* "badjson": the target answered in time, in JSON, without a valid specVersion
\* (not an integer >= 1). Only JSON targets, only when MalformedReplies.
\* The #4327 @ 29197a10f probe cache (start.ts:250-320) adds no new Layer-A
\* outcome: a cache hit reuses an answer (same stamp as "fast"), and a start
\* that gets the 2 s retry budget after a recent miss either answers ("fast")
\* or misses ("miss"), both already in Probes. WHEN each outcome happens is
\* the sibling timing model ProbeCache.tla.
AllProbes == Probes \cup {"badjson"}

ProbeKinds(k) == IF k = "same" THEN {"none"}
                 ELSE Probes \cup (IF MalformedReplies THEN {"badjson"} ELSE {})
ExSet(k, t) ==
    CASE k \in StartKinds \cup {"replayRedirect"} -> {0} \cup Specs
      [] k = "replaySame" -> 1..TMax[t]
      [] k = "cli" -> {0} \cup 1..TMax[t]

Valid(r) ==
    /\ (r.k = "same") => (r.t = SameTarget[r.c])
    /\ (r.k = "latestOther") => (r.w = "vercel")   \* local: 'latest' = self
    /\ r.p \in ProbeKinds(r.k)
    /\ (r.p = "badjson") => TReply(r.t) = "json"
    /\ r.ex \in ExSet(r.k, r.t)
    /\ r.a => (r.k \in StartKinds /\ IsV5Caller(r.c))

AllScenarios ==
    {r \in [c : Callers, t : Targets, w : Worlds, k : Kinds,
            p : AllProbes \cup {"none"}, a : BOOLEAN, ex : {0} \cup Specs] :
        Valid(r)}

(* ---------------- Layer A: pure stamp behaviour ---------------- *)
StartProbeGot(r) ==
    IF r.p = "badjson" THEN TRUE               \* answered in time
    ELSE IF CallerCode(r.c) = "4327"
    THEN r.p = "fast" \/ (r.p = "slow" /\ ProbeBudgetSec >= 10)
    ELSE r.p = "fast"                          \* pre-#4327 budget 2s
StartProbeTarget(r) ==
    IF r.p # "nochan" /\ StartProbeGot(r)
    THEN (IF r.p = "badjson"
          THEN (IF HeadMalformed3 /\ CallerCode(r.c) = "4327" THEN 3 ELSE 2)
          ELSE IF TReply(r.t) = "json" THEN TResp[r.t] ELSE 2)
    ELSE MissFloor
\* CLI budget is 10s. A malformed version is not used: at 29197a10f it fails
\* the >= 1 integer check (cli run.ts:103-108); at 764eafd1a a non-number was
\* dropped too (a numeric 0 was not: Lean Combined.cli_zero_version_764).
CliGot(p) == p \in {"fast", "slow"}
CliVersioned(r) == r.k = "cli" /\ CliGot(r.p) /\ TReply(r.t) = "json"

Default(r) ==           \* start()'s own resolution when no explicit value
    IF r.k = "same" THEN CallerMint[r.c]
    ELSE IF CallerCode(r.c) = "4327"
         THEN Min(StartProbeTarget(r), CallerMint[r.c])
         ELSE CallerMint[r.c]

Stamp(r) ==
    CASE r.k \in StartKinds -> IF r.ex # 0 THEN r.ex ELSE Default(r)
      [] r.k = "replaySame" -> r.ex
      [] r.k = "replayRedirect" ->
            IF CallerCode(r.c) = "4327"
            THEN (IF r.ex # 0 THEN r.ex ELSE Default(r))
            ELSE (IF r.ex # 0 THEN r.ex ELSE 1)
      [] r.k = "cli" ->
            IF CliVersioned(r)
            THEN (IF CallerCode(r.c) = "4327"
                  THEN Min(TResp[r.t], CallerMint[r.c]) ELSE TResp[r.t])
            ELSE (IF r.ex # 0
                  THEN (IF CliCapsSource /\ CallerCode(r.c) = "4327"
                        THEN Min(r.ex, CallerMint[r.c]) ELSE r.ex)
                  ELSE Default(r))

\* The stamp did not come out of start()'s own (capped) resolution.
Explicit(r) ==
    CASE r.k \in StartKinds -> r.ex # 0
      [] r.k = "replaySame" -> TRUE
      [] r.k = "replayRedirect" -> CallerCode(r.c) # "4327" \/ r.ex # 0
      [] r.k = "cli" ->
            IF CliVersioned(r) THEN CallerCode(r.c) # "4327" ELSE r.ex # 0

Threw(r) == r.a /\ Stamp(r) < 4

TargetSupportsCompression(r) ==
    IF r.k = "same" THEN TRUE
    ELSE r.p # "nochan" /\ StartProbeGot(r) /\ TCoreGzip(r.t)
InputCompressed(r) ==
    CallerDecodes(r.c) /\ Stamp(r) >= 5 /\ TargetSupportsCompression(r)

InFilter(r) ==
    CASE ScenarioFilter = "all" -> TRUE
      [] ScenarioFilter = "default" -> r.c \in Mainline /\ ~Explicit(r)
      [] ScenarioFilter = "explicit" -> r.c \in Mainline /\ Explicit(r)
      [] ScenarioFilter = "legacyCallers" -> r.c \notin Mainline
InScope(r) == RaceScope = "all" \/ (r.w = "vercel" /\ TAttests(r.t))
Scenarios == {r \in AllScenarios : InFilter(r) /\ InScope(r)}

(* Layer-A invariants (per scenario) *)
P_NoOverStamp(r)          == ~Threw(r) => Stamp(r) <= TMax[r.t]
P_CallerCap(r)            == (~Threw(r) /\ ~Explicit(r)) => Stamp(r) <= CallerMint[r.c]
P_CallerCapExplicit(r)    == ~Threw(r) => Stamp(r) <= CallerMax[r.c]
P_AttrGateMatchesStamp(r) == r.a => (Threw(r) <=> Stamp(r) < 4)
P_AttributesGateCorrect(r)== r.a => (Threw(r) <=> TMax[r.t] < 4)
P_TargetCanReadInput(r)   == (~Threw(r) /\ InputCompressed(r)) => TMax[r.t] >= 5
\* The stamp is one the target can run at all: not above its reader, and on
\* a world-vercel v5 slot reader either already slot-numbered (>= 6) or
\* raisable by the server (attesting target, #1044 deployed, not legacy:
\* legacy <= 1 is routed to the legacy handler before the upgrade).
StampFixable(r, s) ==
    /\ s <= TMax[r.t]
    /\ (r.w = "vercel" /\ ReaderNeedsSlots(r.t) /\ s < 6) =>
          (ServerRaise /\ TAttests(r.t) /\ s > 1)
P_StampRunnable(r)        == ~Threw(r) => StampFixable(r, Stamp(r))
\* a stamp >= 5 lets the executor compress the result the caller must read
P_CallerCanReadOwnStamp(r)== (~Threw(r) /\ Stamp(r) >= 5 /\ TCompresses(r.t))
                                 => CallerDecodes(r.c)

AInvNames == <<"NoOverStamp", "CallerCap", "CallerCapExplicit",
               "AttrGateMatchesStamp", "AttributesGateCorrect",
               "TargetCanReadInput", "StampRunnable", "CallerCanReadOwnStamp">>
NA == 8
HoldsA(name, r) ==
    CASE name = "NoOverStamp" -> P_NoOverStamp(r)
      [] name = "CallerCap" -> P_CallerCap(r)
      [] name = "CallerCapExplicit" -> P_CallerCapExplicit(r)
      [] name = "AttrGateMatchesStamp" -> P_AttrGateMatchesStamp(r)
      [] name = "AttributesGateCorrect" -> P_AttributesGateCorrect(r)
      [] name = "TargetCanReadInput" -> P_TargetCanReadInput(r)
      [] name = "StampRunnable" -> P_StampRunnable(r)
      [] name = "CallerCanReadOwnStamp" -> P_CallerCanReadOwnStamp(r)
AKey(r) == [i \in 1..NA |-> HoldsA(AInvNames[i], r)]
IsAInv(name) == \E i \in 1..NA : AInvNames[i] = name
VIO == [i \in 1..NA |-> {r \in Scenarios : ~HoldsA(AInvNames[i], r)}]
ViolatorsA(name) == VIO[CHOOSE i \in 1..NA : AInvNames[i] = name]

Groups == <<"mainline-v5 (C_H7,C_M6,C_M8)", "betas (C_B4,C_B7)", "stable C_V4">>
InGroup(g, r) ==
    CASE g = Groups[1] -> r.c \in Mainline
      [] g = Groups[2] -> r.c \in {"C_B4", "C_B7"}
      [] g = Groups[3] -> r.c = "C_V4"

KScore(k) == CASE k = "same" -> 0 [] k = "cross" -> 1 [] k = "latestOther" -> 2
               [] k = "replaySame" -> 2 [] OTHER -> 3
PScore(p) == CASE p \in {"none", "fast"} -> 0 [] p \in {"miss", "slow", "badjson"} -> 1
               [] OTHER -> 2
Score(r) == KScore(r.k) + PScore(r.p) + (IF r.a THEN 1 ELSE 0)
            + (IF r.w = "vercel" THEN 0 ELSE 1) + (IF r.ex = 0 THEN 0 ELSE 1)
MinOf(V) ==
    LET m == CHOOSE m \in {Score(r) : r \in V} : \A r \in V : m <= Score(r)
    IN CHOOSE r \in V : Score(r) = m
FocusSet(name) ==
    LET V == ViolatorsA(name)
        U == {r \in V : InGroup(Groups[1], r)}
    IN IF U # {} THEN U ELSE V

InitSet ==
    IF FocusInv = "ALL" \/ ~IsAInv(FocusInv) THEN Scenarios
    ELSE IF ViolatorsA(FocusInv) = {} THEN Scenarios
    ELSE {MinOf(FocusSet(FocusInv))}

(* Layer-B class of a scenario *)
Cls(r) == [s |-> Stamp(r), t |-> r.t, w |-> r.w, dec |-> CallerDecodes(r.c),
           threw |-> Threw(r)]

(* ---------------- Layer B: server + executor ---------------- *)
VARIABLES
    scn,        \* the scenario (constant after Init)
    mint,       \* [D -> executor mint per delivery] (EnvDrift)
    row,        \* persisted run row [ex, st, sp]
    hist,       \* every committed row version [st, sp] (stale reads)
    peak,       \* ghost: highest row spec ever committed
    resur,      \* ghost: a terminal row was patched back to running
    log,        \* event rows [t, k \in {"S","U"}, n, sp]
    clk,        \* ULID mint order (ULIDs sort above every slot)
    cpc,        \* caller pc
    xpc, held, att, upg, rsp,   \* per delivery
    kpc, kheld, \* canceller
    rdone, crashes,
    outc        \* <<compressed?, kind>> of the stored terminal payload

vars == <<scn, mint, row, hist, peak, resur, log, clk, cpc, xpc, held, att,
          upg, rsp, kpc, kheld, rdone, crashes, outc>>

S == Stamp(scn)
T == scn.t
W == scn.w
NoRow == [ex |-> FALSE, st |-> "none", sp |-> 0]
NoUpg == [from |-> 0, to |-> 0, fresh |-> FALSE, rekey |-> FALSE,
          rk |-> "none", rn |-> 0]
Snap(r) == [st |-> r.st, sp |-> r.sp]
Terminal(s) == s \in {"completed", "failed", "cancelled"}
IsLegacy(v) == v <= 1
Slot(v) == v >= 6
Sealed(v) == v >= 7
Rekey(a, b) == ~Slot(a) /\ Slot(b)
NeedsFresh(a, b) == Rekey(a, b) \/ (~Sealed(a) /\ Sealed(b))
AttestsHere == ServerRaise /\ W = "vercel" /\ TAttests(T)
Att(d) == IF MutAttestAboveMax THEN mint[d] + 1 ELSE mint[d]

\* id mode of a row written by a request holding spec hs
Mode(hs) == IF W = "local" \/ Slot(hs) THEN "S" ELSE "U"
HasUlid == \E e \in log : e.k = "U"
HasRC == \E e \in log : e.t = "RC"
HasRS == \E e \in log : e.t = "RS"
Before(e, f) == (e.k = "S" /\ f.k = "U") \/ (e.k = f.k /\ e.n < f.n)
First(L) == CHOOSE e \in L : \A f \in L : f = e \/ Before(e, f)
FirstRC == First({e \in log : e.t = "RC"})
NextSlot == 1 + MaxOf({1} \cup {e.n : e \in {f \in log : f.k = "S"}})
Slot1Taken == \E e \in log : e.k = "S" /\ e.n = 1
\* probeMaxSlot 500s when a ULID sits at the top of a slot-mode log; sealed
\* runs allocate from the sequencer without probing.
CanInsert(hs) == ~(Mode(hs) = "S" /\ W = "vercel" /\ ~Sealed(hs) /\ HasUlid)
NewEvt(et, hs) ==
    IF Mode(hs) = "S" THEN [t |-> et, k |-> "S", n |-> NextSlot, sp |-> 0]
    ELSE [t |-> et, k |-> "U", n |-> clk, sp |-> 0]
Insert(et, hs) ==
    /\ log' = log \cup {NewEvt(et, hs)}
    /\ clk' = IF Mode(hs) = "U" THEN clk + 1 ELSE clk
InsertRC(hs, sp) ==   \* run_created: slot 1 pinned, else a fresh ULID
    IF Mode(hs) = "S"
    THEN /\ log' = log \cup {[t |-> "RC", k |-> "S", n |-> 1, sp |-> sp]}
         /\ clk' = clk
    ELSE /\ log' = log \cup {[t |-> "RC", k |-> "U", n |-> clk, sp |-> sp]}
         /\ clk' = clk + 1

SetRow(r) ==
    /\ row' = r
    /\ hist' = hist \cup {Snap(r)}
    /\ peak' = Max(peak, r.sp)
    /\ resur' = (resur \/ (row.ex /\ Terminal(row.st) /\ r.st = "running"))
RowSame == UNCHANGED <<row, hist, peak, resur>>

ReadChoices == (IF StaleReads THEN hist ELSE {}) \cup {Snap(row)}
\* spec a post-start write keys its event id on
IdSpec(heldSp) == IF FixConsistentIdMode THEN row.sp ELSE heldSp

Turbo(d) == att[d] = 1 /\ S >= 3

Finals == {"done", "gone410", "overmax", "idsFail", "noRCFail", "exhausted",
           "none"}
BrickFinals == {"overmax", "idsFail", "noRCFail"}

Retry(d) ==
    /\ att' = [att EXCEPT ![d] = @ + 1]
    /\ xpc' = [xpc EXCEPT ![d] = "fetch"]
    /\ upg' = [upg EXCEPT ![d] = NoUpg]

Init ==
    /\ scn \in InitSet
    /\ mint \in [D -> ExecMints(scn.t)]
    /\ row = NoRow /\ hist = {} /\ peak = 0 /\ resur = FALSE
    /\ log = {} /\ clk = 100
    /\ cpc = IF Threw(scn) THEN "threw" ELSE "row"
    /\ xpc = [d \in D |-> IF Threw(scn) THEN "none" ELSE "fetch"]
    /\ held = [d \in D |-> [st |-> "none", sp |-> 0]]
    /\ att = [d \in D |-> 1]
    /\ upg = [d \in D |-> NoUpg]
    /\ rsp = [d \in D |-> 0]
    /\ kpc = "idle" /\ kheld = [st |-> "none", sp |-> 0]
    /\ rdone = 0 /\ crashes = 0
    /\ outc = <<FALSE, "none">>

(* ---- Caller: run_created ---- *)
CRow ==
    /\ cpc = "row"
    /\ IF row.ex
       THEN /\ cpc' = "done" /\ RowSame /\ UNCHANGED <<log, clk>>  \* 409
       ELSE /\ SetRow([ex |-> TRUE, st |-> "pending", sp |-> S])
            /\ IF FixAtomicCreate
               THEN /\ IF Mode(S) = "S" /\ Slot1Taken
                       THEN UNCHANGED <<log, clk>> ELSE InsertRC(S, S)
                    /\ cpc' = "done"
               ELSE /\ cpc' = "evt" /\ UNCHANGED <<log, clk>>
    /\ UNCHANGED <<scn, mint, xpc, held, att, upg, rsp, kpc, kheld,
                   rdone, crashes, outc>>

CFail ==        \* retryable error before any write -> resilientStart
    /\ cpc = "row" /\ CallerMayFail
    /\ cpc' = "failed"
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, log, clk, xpc, held, att,
                   upg, rsp, kpc, kheld, rdone, crashes, outc>>

CEvt ==         \* separate run_created event insert
    /\ cpc = "evt"
    /\ LET sp == IF FixLateRunCreated /\ row.ex THEN row.sp ELSE S
       IN IF Mode(sp) = "S" /\ Slot1Taken
          THEN UNCHANGED <<log, clk>>                \* conflict -> 409
          ELSE InsertRC(sp, sp)
    /\ cpc' = "done"
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, xpc, held, att, upg, rsp,
                   kpc, kheld, rdone, crashes, outc>>

CCrash ==       \* request dies between run-row create and event insert
    /\ cpc = "evt" /\ crashes < MaxCrashes
    /\ cpc' = "failed" /\ crashes' = crashes + 1
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, log, clk, xpc, held, att,
                   upg, rsp, kpc, kheld, rdone, outc>>

(* ---- Executor delivery d: run_started ---- *)
Quiet(d) ==      \* grace window premise: nothing else in flight
    /\ \A e \in D \ {d} : xpc[e] \in Finals \cup {"fetch"}
    /\ cpc \in {"done", "failed"}
    /\ kpc \in {"idle", "done"}

XFetch(d) ==
    /\ xpc[d] = "fetch"
    /\ IF att[d] > MaxAttempts THEN
          \* MAX_DELIVERIES_EXCEEDED -> run_failed (local over-max rejects it).
          \* The real queue spaces 48 deliveries over ~9-10 h, so by then every
          \* other in-flight request has resolved (Quiet), as in the sibling
          \* ServerRaiseProtocol's BoundedLatency premise.
          /\ Quiet(d)
          /\ xpc' = [xpc EXCEPT ![d] = "exhausted"]
          /\ IF row.ex /\ ~Terminal(row.st) /\ ~(W = "local" /\ row.sp > TMax[T])
             THEN SetRow([row EXCEPT !.st = "failed"]) ELSE RowSame
          /\ UNCHANGED <<held, att, upg>>
       ELSE IF ~row.ex THEN
          /\ IF S >= 3                           \* eventData only with runInput
             THEN /\ xpc' = [xpc EXCEPT ![d] = "rsCreate"]
                  /\ UNCHANGED <<att, upg>>
             ELSE Retry(d)                       \* 404 -> redelivery
          /\ RowSame /\ UNCHANGED held
       ELSE \E h \in ReadChoices :
          /\ held' = [held EXCEPT ![d] = h]
          /\ xpc' = [xpc EXCEPT ![d] =
                CASE Terminal(h.st) -> "gone410"
                  [] W = "local" /\ h.sp > TMax[T] -> "overmax"
                  [] OTHER -> "upg"]
          /\ RowSame /\ UNCHANGED <<att, upg>>
    /\ UNCHANGED <<scn, mint, log, clk, cpc, rsp, kpc, kheld, rdone, crashes,
                   outc>>

\* after-read skip: FixSkipReread rereads the run (consistent)
SkipAfterRead(d) ==
    IF FixSkipReread
    THEN IF row.ex
         THEN /\ held' = [held EXCEPT ![d] = Snap(row)]
              /\ xpc' = [xpc EXCEPT ![d] = "trans"] /\ UNCHANGED <<att, upg>>
         ELSE Retry(d) /\ UNCHANGED held
    ELSE /\ xpc' = [xpc EXCEPT ![d] = "trans"] /\ UNCHANGED <<held, att, upg>>

\* upgrade.ts:96-122: early skips on the HELD run, then the consistent head read
XUpg(d) ==
    /\ xpc[d] = "upg"
    /\ LET h == held[d]
           a == Att(d)
           fresh == NeedsFresh(h.sp, a)
           mk(rk, rn) == [from |-> h.sp, to |-> a, fresh |-> fresh,
                          rekey |-> Rekey(h.sp, a), rk |-> rk, rn |-> rn]
       IN IF ~AttestsHere \/ a <= h.sp \/ IsLegacy(h.sp) \/ Terminal(h.st)
                 \/ (fresh /\ h.st # "pending")
          THEN /\ xpc' = [xpc EXCEPT ![d] = "trans"]
               /\ UNCHANGED <<held, att, upg>>
          ELSE IF log = {} THEN              \* run-created-not-committed
               IF RaiseOnNotCommitted
               THEN /\ upg' = [upg EXCEPT ![d] = mk("none", 0)]
                    /\ xpc' = [xpc EXCEPT ![d] = "tx"] /\ UNCHANGED <<held, att>>
               ELSE IF FixSkipReread THEN Retry(d) /\ UNCHANGED held
               ELSE /\ xpc' = [xpc EXCEPT ![d] = "trans"]
                    /\ UNCHANGED <<held, att, upg>>
          ELSE LET f == First(log) IN
               IF f.t # "RC" \/ (fresh /\ Cardinality(log) > 1)
                  \/ (Rekey(h.sp, a) /\ f.k = "S")
               THEN SkipAfterRead(d)
               ELSE /\ upg' = [upg EXCEPT ![d] = mk(f.k, f.n)]
                    /\ xpc' = [xpc EXCEPT ![d] = "tx"] /\ UNCHANGED <<held, att>>
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, log, clk, cpc, rsp, kpc,
                   kheld, rdone, crashes, outc>>

\* upgrade.ts:124-208: transactWrite (row cond + run_created cond), then reread
XTx(d) ==
    /\ xpc[d] = "tx"
    /\ LET u == upg[d]
           rcs == {e \in log : e.t = "RC" /\ e.k = u.rk /\ e.n = u.rn}
           ok == /\ row.ex /\ row.sp = u.from
                 /\ IF u.fresh THEN row.st = "pending" ELSE ~Terminal(row.st)
                 /\ (u.rk = "none" \/ rcs # {})
                 /\ (u.rk # "none" /\ u.rekey => ~Slot1Taken)
           nr == [row EXCEPT !.sp = u.to]
       IN IF ok
          THEN /\ SetRow(nr)
               /\ log' = IF u.rk = "none" THEN log
                         ELSE IF u.rekey
                         THEN (log \ rcs) \cup
                              {[t |-> "RC", k |-> "S", n |-> 1, sp |-> u.to]}
                         ELSE (log \ rcs) \cup {[e EXCEPT !.sp = u.to] : e \in rcs}
               /\ held' = [held EXCEPT ![d] = Snap(nr)]
               /\ xpc' = [xpc EXCEPT ![d] = "trans"]
               /\ UNCHANGED <<att, upg>>
          ELSE /\ RowSame /\ UNCHANGED log
               /\ IF row.ex                     \* lost-race: reread
                  THEN /\ held' = [held EXCEPT ![d] = Snap(row)]
                       /\ xpc' = [xpc EXCEPT ![d] = "trans"]
                       /\ UNCHANGED <<att, upg>>
                  ELSE Retry(d) /\ UNCHANGED held
    /\ UNCHANGED <<scn, mint, clk, cpc, rsp, kpc, kheld, rdone, crashes, outc>>

\* events.ts:2376-2415 handleRunStateTransition(run_started)
XTrans(d) ==
    /\ xpc[d] = "trans"
    /\ LET h == held[d] IN
       CASE Terminal(h.st) ->
              /\ xpc' = [xpc EXCEPT ![d] = "gone410"]
              /\ RowSame /\ UNCHANGED <<held, att, upg, rdone>>
         [] h.st = "running" ->
              IF HasRS
              THEN /\ xpc' = [xpc EXCEPT ![d] = "replay"]     \* alreadyRunning
                   /\ RowSame /\ UNCHANGED <<held, att, upg, rdone>>
              ELSE \/ /\ RowSame /\ UNCHANGED <<held, rdone>>  \* 503 in grace
                      /\ IF RecoveryEnabled /\ rdone = 0
                         \* the 60 s grace is far shorter than the delivery
                         \* horizon: these redeliveries do not use up attempts
                         THEN /\ xpc' = [xpc EXCEPT ![d] = "fetch"]
                              /\ UNCHANGED <<att, upg>>
                         ELSE Retry(d)
                   \/ /\ RecoveryEnabled /\ rdone = 0 /\ Quiet(d)
                      /\ row.ex /\ row.st = "running" /\ ~HasRS
                      /\ row' = NoRow                        \* row ONLY
                      /\ UNCHANGED <<hist, peak, resur>>
                      /\ rdone' = 1 /\ Retry(d) /\ UNCHANGED held
         [] OTHER ->
              IF FixGuardStart
              THEN IF row.ex /\ row.st = "pending" /\ row.sp = h.sp
                   THEN /\ SetRow([row EXCEPT !.st = "running"])
                        /\ xpc' = [xpc EXCEPT ![d] = "ins"]
                        /\ UNCHANGED <<held, att, upg, rdone>>
                   ELSE IF row.ex
                   THEN /\ held' = [held EXCEPT ![d] = Snap(row)]
                        /\ RowSame /\ UNCHANGED <<xpc, att, upg, rdone>>
                   ELSE Retry(d) /\ RowSame /\ UNCHANGED <<held, rdone>>
              ELSE IF row.ex                          \* UNCONDITIONAL patch
                   THEN /\ SetRow([row EXCEPT !.st = "running"])
                        /\ xpc' = [xpc EXCEPT ![d] = "ins"]
                        /\ UNCHANGED <<held, att, upg, rdone>>
                   ELSE Retry(d) /\ RowSame /\ UNCHANGED <<held, rdone>>
    /\ UNCHANGED <<scn, mint, log, clk, cpc, rsp, kpc, kheld, crashes, outc>>

\* run_started event insert in the HELD run's id mode
XIns(d) ==
    /\ xpc[d] = "ins"
    /\ IF CanInsert(held[d].sp)
       THEN /\ Insert("RS", held[d].sp)
            /\ xpc' = [xpc EXCEPT ![d] = "replay"] /\ UNCHANGED <<att, upg>>
       ELSE Retry(d) /\ UNCHANGED <<log, clk>>   \* 500 slot-log-mixed-identity
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, cpc, held, rsp, kpc, kheld,
                   rdone, crashes, outc>>

RsBase(d) == IF RaiseOnResilient /\ AttestsHere THEN Max(S, Att(d)) ELSE S
\* synthetic run_created: id slot 1 iff Slot(mode spec) (current code: the
\* stamp, events.ts:8131-8138), adopt an existing slot-1 row (8181-8212)
RsInsert(sp) ==
    LET ms == IF RaiseOnResilient \/ FixRecoveryAdopt THEN sp ELSE S
    IN IF (FixRecoveryAdopt /\ HasRC) \/ (Mode(ms) = "S" /\ Slot1Taken)
       THEN UNCHANGED <<log, clk>>                    \* adopt
       ELSE InsertRC(ms, ms)

\* resilient start: create the run row from eventData
XRsCreate(d) ==
    /\ xpc[d] = "rsCreate"
    /\ IF row.ex
       THEN \E h \in ReadChoices :     \* EntityConflict -> refetch
              /\ held' = [held EXCEPT ![d] = h]
              /\ xpc' = [xpc EXCEPT ![d] =
                    IF Terminal(h.st) THEN "gone410"
                    ELSE IF RaiseOnResilient THEN "upg" ELSE "trans"]
              /\ RowSame /\ UNCHANGED <<rsp, log, clk>>
       ELSE LET sp == IF FixRecoveryAdopt /\ HasRC THEN FirstRC.sp ELSE RsBase(d)
            IN /\ SetRow([ex |-> TRUE, st |-> "pending", sp |-> sp])
               /\ held' = [held EXCEPT ![d] = [st |-> "pending", sp |-> sp]]
               /\ rsp' = [rsp EXCEPT ![d] = sp]
               /\ IF FixAtomicCreate                \* one transaction
                  THEN RsInsert(sp) /\ xpc' = [xpc EXCEPT ![d] = "trans"]
                  ELSE UNCHANGED <<log, clk>> /\ xpc' = [xpc EXCEPT ![d] = "rsEvt"]
    /\ UNCHANGED <<scn, mint, cpc, att, upg, kpc, kheld, rdone, crashes, outc>>

XRsEvt(d) ==     \* the separate synthetic run_created insert
    /\ xpc[d] = "rsEvt"
    /\ RsInsert(rsp[d])
    /\ xpc' = [xpc EXCEPT ![d] = "trans"]
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, cpc, held, att, upg, rsp,
                   kpc, kheld, rdone, crashes, outc>>

FailRun == IF row.ex /\ ~Terminal(row.st)
           THEN SetRow([row EXCEPT !.st = "failed"]) ELSE RowSame

\* executor replay: requireEventSlot, run rebuild, reader capability
XReplay(d) ==
    /\ xpc[d] = "replay"
    /\ LET v == IF row.ex THEN row.sp ELSE S IN
       CASE ReaderNeedsSlots(T) /\ W = "vercel" /\ HasUlid ->
              xpc' = [xpc EXCEPT ![d] = "idsFail"] /\ FailRun
         [] W = "vercel" /\ ~HasRC /\ ~Turbo(d) ->
              xpc' = [xpc EXCEPT ![d] = "noRCFail"] /\ FailRun
         [] v > TMax[T] ->
              xpc' = [xpc EXCEPT ![d] = "overmax"] /\ RowSame
         [] OTHER ->
              xpc' = [xpc EXCEPT ![d] = "complete"] /\ RowSame
    /\ UNCHANGED <<scn, mint, log, clk, cpc, held, att, upg, rsp, kpc, kheld,
                   rdone, crashes, outc>>

\* run_completed / run_failed(error): guarded terminal patch + event row in
\* the id mode of the server's (possibly stale) read of the run
XComplete(d) ==
    /\ xpc[d] = "complete"
    /\ \E kind \in {"returnValue", "error"}, r \in ReadChoices :
         LET eff0 == IF Turbo(d) \/ ~HasRC THEN S ELSE FirstRC.sp
             eff == IF FixCompressOnStamp THEN Min(S, eff0) ELSE eff0
             comp == TCompresses(T) /\ eff >= 5
         IN IF row.ex /\ ~Terminal(row.st)
            THEN IF CanInsert(IdSpec(r.sp))
                 THEN /\ SetRow([row EXCEPT !.st =
                            IF kind = "returnValue" THEN "completed" ELSE "failed"])
                      /\ Insert("RX", IdSpec(r.sp))
                      /\ outc' = <<comp, kind>>
                      /\ xpc' = [xpc EXCEPT ![d] = "done"]
                      /\ UNCHANGED <<att, upg>>
                 ELSE Retry(d) /\ RowSame /\ UNCHANGED <<log, clk, outc>>
            ELSE /\ xpc' = [xpc EXCEPT ![d] = "done"]      \* 409 finished
                 /\ RowSame /\ UNCHANGED <<log, clk, outc, att, upg>>
    /\ UNCHANGED <<scn, mint, cpc, held, rsp, kpc, kheld, rdone, crashes>>

XCrash(d) ==     \* request dies after a committed write, before responding
    /\ xpc[d] \in {"trans", "ins", "rsEvt"} /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1 /\ Retry(d)
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, log, clk, cpc, held, rsp,
                   kpc, kheld, rdone, outc>>

(* ---- Canceller: run_cancelled ---- *)
KRead ==
    /\ CancelEnabled /\ kpc = "idle" /\ row.ex
    /\ \E h \in ReadChoices : ~Terminal(h.st) /\ kheld' = h
    /\ kpc' = "patch"
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, log, clk, cpc, xpc, held,
                   att, upg, rsp, rdone, crashes, outc>>
KPatch ==
    /\ kpc = "patch"
    /\ LET ks == IdSpec(kheld.sp) IN
       IF row.ex /\ ~Terminal(row.st)
       THEN IF Mode(ks) = "S"
            THEN IF CanInsert(ks)
                 THEN /\ SetRow([row EXCEPT !.st = "cancelled"])
                      /\ Insert("RK", ks) /\ kpc' = "done"
                 ELSE /\ RowSame /\ UNCHANGED <<log, clk>> /\ kpc' = "done"
            ELSE /\ SetRow([row EXCEPT !.st = "cancelled"])
                 /\ UNCHANGED <<log, clk>> /\ kpc' = "ins"
       ELSE /\ RowSame /\ UNCHANGED <<log, clk>> /\ kpc' = "done"
    /\ UNCHANGED <<scn, mint, cpc, xpc, held, att, upg, rsp, kheld, rdone,
                   crashes, outc>>
KIns ==     \* ULID-mode insert after the patch (the run is terminal now, so
            \* no raise can land in between)
    /\ kpc = "ins"
    /\ Insert("RK", IdSpec(kheld.sp)) /\ kpc' = "done"
    /\ UNCHANGED <<scn, mint, row, hist, peak, resur, cpc, xpc, held, att, upg,
                   rsp, kheld, rdone, crashes, outc>>

Next ==
    \/ CRow \/ CFail \/ CEvt \/ CCrash
    \/ \E d \in D : XFetch(d) \/ XUpg(d) \/ XTx(d) \/ XTrans(d) \/ XIns(d)
                    \/ XRsCreate(d) \/ XRsEvt(d) \/ XReplay(d) \/ XComplete(d)
                    \/ XCrash(d)
    \/ KRead \/ KPatch \/ KIns

Spec == Init /\ [][Next]_vars

\* Layer-B dedup: the scenario only matters through its class and its
\* Layer-A verdicts.
\* (AKey only on the FocusInv = "ALL" runs, which check the Layer-A
\* predicates; Layer-B-only runs use FocusInv = "LB".)
View == <<Cls(scn), IF FocusInv = "LB" THEN <<>> ELSE AKey(scn), mint, row, hist, peak, resur, log, clk, cpc,
          xpc, held, att, upg, rsp, kpc, kheld, rdone, crashes, outc>>

(* ---------------- state invariants ---------------- *)
Quiescent ==
    /\ cpc \in {"done", "failed", "threw"}
    /\ \A d \in D : xpc[d] \in Finals
    /\ kpc \in {"idle", "done"}

TypeOK ==
    /\ scn \in AllScenarios
    /\ row.st \in {"none", "pending", "running", "completed", "failed",
                   "cancelled"}
    /\ \A e \in log : e.k \in {"S", "U"}

\* Layer A
NoOverStamp          == P_NoOverStamp(scn)
CallerCap            == P_CallerCap(scn)
CallerCapExplicit    == P_CallerCapExplicit(scn)
AttrGateMatchesStamp == P_AttrGateMatchesStamp(scn)
AttributesGateCorrect== P_AttributesGateCorrect(scn)
TargetCanReadInput   == P_TargetCanReadInput(scn)
StampRunnable        == P_StampRunnable(scn)
CallerCanReadOwnStamp== P_CallerCanReadOwnStamp(scn)

\* Layer B
NoBrick == \A d \in D : xpc[d] \notin BrickFinals
\* A brick the stamp alone does not explain (StampRunnable holds for the
\* scenario's class): a protocol race, not a bad stamp.
NoAvoidableBrick == StampFixable(scn, S) => NoBrick
NoMixedIdentityLog == ~(\E e, f \in log : e.k = "S" /\ f.k = "U")
NoStuck == (Quiescent /\ ~Threw(scn)) => (row.ex /\ Terminal(row.st))
\* Stuck runs the stamp alone does not explain: the stamp is runnable and
\* >= 3 (below 3 there is no runInput, so no resilient start, and a
\* retryable run_created failure loses the run: pre-existing, see NoStuck).
NoAvoidableStuck == (StampFixable(scn, S) /\ S >= 3) => NoStuck
NoResurrect == ~resur
SpecNeverLowered == row.ex => row.sp >= peak
SingleRunCreated == Cardinality({e \in log : e.t = "RC"}) <= 1
\* A spec other than the caller's stamp is a server raise; it must be
\* readable by every executor of the pinned deployment (all share TMax).
NoOverRaise == (row.ex /\ row.sp # S) => row.sp <= TMax[T]
\* The stored result is readable by the caller, unless the caller itself
\* stamped >= 5 (Layer A CallerCanReadOwnStamp flags that).
CallerCanReadResult == (outc[1] /\ row.ex /\ Terminal(row.st))
                           => (CallerDecodes(scn.c) \/ S >= 5)

(* ---------------- summary printed at startup ---------------- *)
Witness(r) ==
    <<"caller", r.c, "target", r.t, "world", r.w, "kind", r.k, "probe", r.p,
      "attrs", r.a, "ex", r.ex, "=> stamp", Stamp(r), "explicit", Explicit(r),
      "inputCompressed", InputCompressed(r)>>

GroupLine(name, g) ==
    LET V == {r \in ViolatorsA(name) : InGroup(g, r)}
        Vd == {r \in V : ~Explicit(r)}     \* start()'s own resolution
    IN IF V = {} THEN <<name, g, "holds">>
       ELSE <<name, g, "VIOLATED", Cardinality(V), "minimal", Witness(MinOf(V)),
              "pairs", {<<r.c, r.t>> : r \in V}, "kinds", {r.k : r \in V},
              "stamps", {Stamp(r) : r \in V},
              "of which non-explicit", Cardinality(Vd),
              "non-explicit <<caller,target,world,kind,probe,stamp>>",
              {<<r.c, r.t, r.w, r.k, r.p, Stamp(r)>> : r \in Vd}>>

SummaryA(name) ==
    LET V == ViolatorsA(name)
    IN IF V = {} THEN <<"LAYER-A INVARIANT", name, "HOLDS on all", Cardinality(Scenarios)>>
       ELSE <<"LAYER-A INVARIANT", name, "VIOLATED in", Cardinality(V), "of",
              Cardinality(Scenarios)>>

NonThrew == {r \in Scenarios : ~Threw(r)}
\* Default-path stamps that a v5 slot reader on world-vercel can only run if
\* the server raises them (stamp < 6).
LowOnSlotReader ==
    {<<r.c, r.t, r.k, r.p, Stamp(r), IF TAttests(r.t) THEN "attesting" ELSE "NOT attesting">> :
        r \in {x \in NonThrew : x.w = "vercel" /\ ReaderNeedsSlots(x.t)
                               /\ Stamp(x) < 6 /\ x.c \in Mainline /\ ~Explicit(x)}}

ASSUME PrintT(<<"VARIANT", "CallerHas4327", CallerHas4327, "MissFloor", MissFloor,
                "ProbeBudgetSec", ProbeBudgetSec, "ServerRaise", ServerRaise,
                "RaiseOnResilient", RaiseOnResilient,
                "RaiseOnNotCommitted", RaiseOnNotCommitted,
                "FixLateRunCreated", FixLateRunCreated,
                "FixSkipReread", FixSkipReread, "FixGuardStart", FixGuardStart,
                "FixRecoveryAdopt", FixRecoveryAdopt,
                "FixConsistentIdMode", FixConsistentIdMode,
                "FixAtomicCreate", FixAtomicCreate,
                "FixCompressOnStamp", FixCompressOnStamp, "EnvDrift", EnvDrift,
                "MutAttestAboveMax", MutAttestAboveMax,
                "MalformedReplies", MalformedReplies,
                "HeadMalformed3", HeadMalformed3, "CliCapsSource", CliCapsSource,
                "ScenarioFilter", ScenarioFilter, "RaceScope", RaceScope,
                "FocusInv", FocusInv,
                "scenarios", Cardinality(Scenarios),
                "layerB classes", Cardinality({Cls(r) : r \in Scenarios})>>)
ASSUME FocusInv = "ALL" =>
    \A i \in 1..NA : PrintT(ToString(SummaryA(AInvNames[i])))
ASSUME FocusInv = "ALL" =>
    \A i \in 1..NA : \A j \in 1..3 : PrintT(ToString(GroupLine(AInvNames[i], Groups[j])))
ASSUME FocusInv = "ALL" =>
    PrintT(<<"DEFAULT-PATH STAMPS < 6 ON V5 SLOT READERS (world-vercel) <<caller,target,kind,probe,stamp,attest>>",
             Cardinality(LowOnSlotReader)>>)
ASSUME FocusInv = "ALL" => \A x \in LowOnSlotReader : PrintT(ToString(x))
=============================================================================
