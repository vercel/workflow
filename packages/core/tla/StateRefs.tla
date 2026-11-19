------------------------------ MODULE StateRefs ------------------------------
(***************************************************************************)
(* Which `workflow/state` records each reader of a run's log can rebuild   *)
(* (packages/core/src/serialization/state-refs.ts, state-recovery.ts).     *)
(*                                                                         *)
(* The workflow holds versions of state. Calling a step writes its INPUT   *)
(* record; the step runs INLINE (sharing the replay's context) or COLD (a  *)
(* queued step, or a retry in a new invocation, whose context is rebuilt   *)
(* from the run input, hook payloads and step OUTPUTS: never step inputs). *)
(* A step returns a new version on top of its input (produce), its input   *)
(* unchanged (identity), or a new root; its OUTPUT record is written       *)
(* against its context. A new invocation replays: it reads the outputs and *)
(* the hook payloads it delivers, in log order. Hooks arrive at any time;  *)
(* a step output may refer to a hook payload's strings (StateSrcV1).       *)
(*                                                                         *)
(* Record kinds: "ref" (same as version v), "patch" (v = base + ops),      *)
(* "full" (v whole), "plain" (no state record: stored as without refs).    *)
(*                                                                         *)
(* Switches (TRUE = the riskier world, or the fix):                        *)
(*   BodyLineage    produce() in workflow code has lineage the serializer  *)
(*                  sees (FALSE on today's Node VM; TRUE is the worst case)*)
(*   Opaque         a step can put a value only workflow code can revive   *)
(*                  (a custom-serde class, a stream) into state            *)
(*   OpaquePlain    FIX: versions holding one are written "plain"          *)
(*   Undelivered    the log can hold a hook_received replay doesn't        *)
(*                  deliver (after hook_disposed, a duplicate resumeId)    *)
(*   FilterHooks    FIX: recovery registers only what replay delivers      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxVersions, MaxSteps, MaxHooks,
          BodyLineage, Opaque, OpaquePlain, Undelivered, FilterHooks

VARIABLES
  log,      \* sequence of records
  known,    \* versions the current invocation's replay context holds
  srcs,     \* hook payloads the replay context registered
  held,     \* versions the workflow currently holds
  parent,   \* parent[v]: the version v was produced from (0: a root)
  opaque,   \* opaque[v]: v holds a value only workflow code can revive
  nextV,    \* next fresh version id
  steps,    \* steps[s]: [st |-> "none"/"created"/"done", in |-> v]
  broken,   \* a reader met a record it could not rebuild
  seen      \* coverage ghosts: which interesting behaviors happened

vars == <<log, known, srcs, held, parent, opaque, nextV, steps, broken, seen>>

V == 1..MaxVersions
S == 1..MaxSteps
Fresh == nextV <= MaxVersions
Rec(t, s, kind, v, base, src, delivered) ==
  [t |-> t, s |-> s, kind |-> kind, v |-> v, base |-> base, src |-> src,
   delivered |-> delivered]

Init ==
  \* The run input carries a whole root value (always "full", always readable).
  /\ log = << Rec("out", 0, "full", 1, 0, {}, TRUE) >>
  /\ known = {1}
  /\ srcs = {}
  /\ held = {1}
  /\ parent = [v \in V |-> 0]
  /\ opaque = [v \in V |-> FALSE]
  /\ nextV = 2
  /\ steps = [s \in S |-> [st |-> "none", in |-> 0]]
  /\ broken = {}
  /\ seen = {}

\* ---- writers (reduceTracked) --------------------------------------------
\* Kind of a record for version v written against context k. Step inputs and
\* outputs use the same rule; only outputs register what they write.
KindFor(v, k, viaProduce) ==
  IF OpaquePlain /\ opaque[v] THEN "plain"
  ELSE IF v \in k THEN "ref"
  ELSE IF viaProduce /\ parent[v] # 0 /\ parent[v] \in k THEN "patch"
  ELSE "full"

\* ---- readers ---------------------------------------------------------------
Tracked(r) == r.kind \in {"ref", "patch", "full"}
Resolvable(r, k, sk) ==
  CASE r.kind = "ref"   -> r.v \in k
    [] r.kind = "patch" -> r.base \in k /\ r.src \subseteq sk
    [] OTHER            -> TRUE

HookIds(all) ==
  {i \in 1..Len(log) : log[i].t = "hook" /\ (all \/ log[i].delivered)}
ReplaySources == HookIds(FALSE)
RecoverySources == HookIds(~FilterHooks)

\* Versions a reader rebuilds by reading the log's outputs in order.
RECURSIVE FoldTo(_, _, _, _)
FoldTo(i, n, k, sk) ==
  IF i >= n THEN k
  ELSE LET r == log[i] IN
       IF r.t = "out" /\ Tracked(r) /\ Resolvable(r, k, sk)
       THEN FoldTo(i + 1, n, k \cup {r.v}, sk)
       ELSE FoldTo(i + 1, n, k, sk)
Fold(i, k, sk) == FoldTo(i, Len(log) + 1, k, sk)

\* Cold recovery reads every output without running workflow code: a tracked
\* output (full or patch) holding an opaque value fails the whole recovery.
RecoveryFails ==
  \E i \in 1..Len(log) :
    log[i].t = "out" /\ log[i].kind \in {"full", "patch"} /\ opaque[log[i].v]
RecoveryCtx == Fold(1, {}, RecoverySources)

\* ---- the workflow ------------------------------------------------------------
HookArrives ==
  /\ Cardinality(HookIds(TRUE)) < MaxHooks
  /\ \E d \in (IF Undelivered THEN BOOLEAN ELSE {TRUE}) :
       /\ log' = Append(log, Rec("hook", 0, "source", 0, 0, {}, d))
       /\ srcs' = IF d THEN srcs \cup {Len(log) + 1} ELSE srcs
  /\ UNCHANGED <<known, held, parent, opaque, nextV, steps, broken, seen>>

BodyProduce ==
  /\ BodyLineage /\ Fresh
  /\ \E h \in held \cup {0} :
       /\ parent' = [parent EXCEPT ![nextV] = h]
       /\ opaque' = [opaque EXCEPT ![nextV] = (h # 0 /\ opaque[h])]
  /\ held' = held \cup {nextV}
  /\ nextV' = nextV + 1
  /\ UNCHANGED <<log, known, srcs, steps, broken, seen>>

CallStep(s, h) ==
  /\ steps[s].st = "none" /\ h \in held
  /\ LET kind == KindFor(h, known, TRUE) IN
     /\ log' = Append(log, Rec("in", s, kind, h, parent[h], {}, TRUE))
     /\ seen' = IF kind = "ref" THEN seen \cup {"ref input"} ELSE seen
  /\ steps' = [steps EXCEPT ![s] = [st |-> "created", in |-> h]]
  /\ UNCHANGED <<known, srcs, held, parent, opaque, nextV, broken>>

InputRecord(s) == CHOOSE i \in 1..Len(log) : log[i].t = "in" /\ log[i].s = s

\* ---- step execution ------------------------------------------------------
\* ctx/sk: the context the step reads and writes against; inline: the workflow
\* takes the result in this invocation. A step returns produce | identity |
\* root, may add an opaque value, and may refer to hook strings it knows.
Complete(s, how, addOpaque, ctx, sk, inline) ==
  LET inR  == log[InputRecord(s)]
      inV  == inR.v
      outV == IF how = "identity" THEN inV ELSE nextV
      par  == IF how = "produce" THEN inV ELSE 0
      opq  == IF how = "identity" THEN opaque[inV]
              ELSE addOpaque \/ (how = "produce" /\ opaque[inV])
      par2 == IF how = "identity" THEN parent ELSE [parent EXCEPT ![outV] = par]
      opq2 == IF how = "identity" THEN opaque ELSE [opaque EXCEPT ![outV] = opq]
      kind == IF OpaquePlain /\ opq THEN "plain"
              ELSE IF how = "identity" THEN (IF inV \in ctx THEN "ref" ELSE "full")
              ELSE IF par # 0 /\ par \in ctx THEN "patch" ELSE "full"
  IN
  /\ (how # "identity") => Fresh
  /\ addOpaque => (Opaque /\ how # "identity")
  /\ \E src \in SUBSET sk :
       /\ (kind # "patch") => src = {}
       /\ log' = Append(log, Rec("out", s, kind, outV, par, src, TRUE))
       /\ seen' = seen \cup (IF src # {} THEN {"source ref"} ELSE {})
                       \cup (IF kind = "patch" THEN {"patch output"} ELSE {})
                       \cup (IF ~inline /\ inR.kind = "ref" THEN {"cold ref"} ELSE {})
  /\ parent' = par2
  /\ opaque' = opq2
  /\ nextV' = IF how = "identity" THEN nextV ELSE nextV + 1
  /\ steps' = [steps EXCEPT ![s].st = "done"]
  /\ known' = IF inline /\ kind # "plain" THEN known \cup {outV} ELSE known
  /\ held'  = IF inline THEN held \cup {outV} ELSE held
  /\ UNCHANGED <<srcs, broken>>

RunInline(s) ==
  /\ steps[s].st = "created"
  /\ \E how \in {"produce", "identity", "root"}, addOpaque \in BOOLEAN :
       Complete(s, how, addOpaque, known, srcs, TRUE)

\* Cold: recover only when the input needs it (needsRecovery).
RunCold(s) ==
  /\ steps[s].st = "created"
  /\ LET inR == log[InputRecord(s)]
         needs == inR.kind \in {"ref", "patch"}
     IN IF needs /\ RecoveryFails
        THEN /\ broken' = broken \cup {<<"cold step: recovery fails", s>>}
             /\ UNCHANGED <<log, known, srcs, held, parent, opaque, nextV, steps, seen>>
        ELSE LET ctx == IF needs THEN RecoveryCtx ELSE {}
             IN IF ~Resolvable(inR, ctx, RecoverySources)
                THEN /\ broken' = broken \cup {<<"cold step input", s>>}
                     /\ UNCHANGED <<log, known, srcs, held, parent, opaque, nextV, steps, seen>>
                ELSE \E how \in {"produce", "identity", "root"}, addOpaque \in BOOLEAN :
                       Complete(s, how, addOpaque, ctx,
                                IF needs THEN RecoverySources ELSE {}, FALSE)

\* A new invocation: replay reads outputs and delivered hooks in log order.
Replay ==
  /\ LET outs == {i \in 1..Len(log) : log[i].t = "out" /\ Tracked(log[i])}
         miss == {i \in outs :
                    ~Resolvable(log[i], FoldTo(1, i, {}, ReplaySources),
                                ReplaySources)}
     IN /\ broken' = IF miss = {} THEN broken
                     ELSE broken \cup {<<"replay", Len(log)>>}
        /\ known' = Fold(1, {}, ReplaySources)
        /\ srcs' = ReplaySources
        \* Workflow code is re-run: it holds what it held (body versions are
        \* re-made with the same ids by the seeded VM).
        /\ held' = held \cup known'
  /\ UNCHANGED <<log, parent, opaque, nextV, steps, seen>>

Next ==
  \/ HookArrives
  \/ BodyProduce
  \/ \E s \in S, h \in V : CallStep(s, h)
  \/ \E s \in S : RunInline(s) \/ RunCold(s)
  \/ Replay

Spec == Init /\ [][Next]_vars

\* ---- properties ------------------------------------------------------------
\* No reader ever meets a record it can't rebuild.
NoMissing == broken = {}

\* Coverage probes: each is expected to be VIOLATED, which shows the model
\* reaches that behavior (see the *.cfg files named Cov*).
NeverRefInput == "ref input" \notin seen
NeverPatchOutput == "patch output" \notin seen
NeverColdRef == "cold ref" \notin seen
NeverSourceRef == "source ref" \notin seen
=============================================================================
