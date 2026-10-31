--------------------------- MODULE ReplayDelivery ---------------------------
(***************************************************************************)
(* Prefix consistency of the Workflow SDK replay engine.                   *)
(*                                                                         *)
(* This module models the part of the engine that decides IN WHICH ORDER   *)
(* event-log resolutions (step results, hook payloads, wait completions)   *)
(* become visible to workflow code, and checks that this order is a        *)
(* deterministic, prefix-monotone function of the consumed event-log       *)
(* prefix -- independent of scheduler timing.                              *)
(*                                                                         *)
(* Why arrival order is the right observable: workflow code is assumed     *)
(* deterministic (assumption A2 in the README), so every downstream        *)
(* observable -- control-flow paths, the commands a replay issues, the     *)
(* per-family correlation-id ordinals (correlation-id.ts), and the         *)
(* WorkflowSuspension output that suspension-handler.ts commits -- is a    *)
(* pure function of the sequence of deliveries handed to the guest. If     *)
(* arrival sequences are deterministic and prefix-monotone, all of those   *)
(* are too. The lemma and the full theorem decomposition are in            *)
(* specs/tla/README.md.                                                    *)
(*                                                                         *)
(* Code being modeled (packages/core/src):                                 *)
(*   - events-consumer.ts   : strict in-log-order consumption (Consume)    *)
(*   - private.ts           : delivery barriers, DEFER_BEHIND edges,       *)
(*                            resolvesOnItsOwn skip rule, idle safety net  *)
(*                            (Arrive / SelfRes / Blocked / RetireAtIdle)  *)
(*   - workflow/hook.ts     : buffered-payload claim path with claim-time  *)
(*                            barrier snapshot (Claim)                     *)
(*   - runtime.ts + private.ts scheduleWhenIdle : suspension fires only at *)
(*                            quiescence (Idle / Quiescent)                *)
(*                                                                         *)
(* The timing adversary: between a delivery's resolve() and the workflow   *)
(* observing it lie a variable number of microtask hops (hydration,        *)
(* decrypt/decompress, iterator wrappers, replay-cache memo hits). The     *)
(* model captures this by making every enabled arrival a nondeterministic  *)
(* scheduler choice. With Barriers = TRUE the DEFER_BEHIND discipline      *)
(* constrains the choice and the divergence invariants hold. Barriers =    *)
(* FALSE removes the discipline as a falsifiability check: TLC finds       *)
(* arrival-order divergence between two replays of the same log (the       *)
(* CorruptedEventLogError failure mode), showing the invariants have teeth *)
(* and that the ordering discipline is what discharges them.               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  \* Sequence of branch-deciding resolutions in committed event-log order.
  \* Each element: [kind: {"hook","wait","step"}, armed: BOOLEAN, claimAfter: Nat]
  \*   kind       -- hook_received | wait_completed | step_completed/failed
  \*   armed      -- TRUE when a consumer is already waiting when the event
  \*                 is consumed (waits and steps always; hooks only when the
  \*                 guest is already awaiting the payload). FALSE models a
  \*                 BUFFERED hook payload with no waiting consumer.
  \*   claimAfter -- for buffered payloads only: the guest claims the payload
  \*                 once its arrival count reaches this value. This is
  \*                 guest-deterministic (a function of the guest's own
  \*                 progress), which is why it is a constant of the schedule
  \*                 and not a scheduler choice. Use a value > Len(Schedule)
  \*                 for "never claimed".
  Schedule,
  \* Number of concurrent replay invocations of the same run.
  NInv,
  \* TRUE: enforce the delivery-barrier discipline (the engine).
  \* FALSE: arrivals race freely on scheduler timing -- a falsifiability
  \* check that the invariants can fail and that the discipline is what
  \* makes them hold.
  Barriers

Kinds == {"hook", "wait", "step"}

ASSUME
  /\ Schedule \in Seq([kind: Kinds, armed: BOOLEAN, claimAfter: Nat])
  \* Only hook payloads can be buffered; waits and steps always resolve from
  \* their own delivery chain (private.ts: "True for wait completions and
  \* step results, which always resolve from their own chain").
  /\ \A n \in 1..Len(Schedule):
       Schedule[n].kind \in {"wait", "step"} => Schedule[n].armed
  /\ NInv \in Nat \ {0}
  /\ Barriers \in BOOLEAN

N    == Len(Schedule)
Idx  == 1..N
Invs == 1..NInv

(***************************************************************************)
(* DEFER_BEHIND from private.ts: which earlier-in-log delivery kinds a     *)
(* delivery of each kind must wait for before resolving to the workflow.   *)
(* Every edge points from a later log index to a strictly earlier one, so  *)
(* the wait-for graph is acyclic by construction.                          *)
(***************************************************************************)
DeferBehind ==
  [hook |-> {"wait", "step"},
   wait |-> {"hook", "step"},
   step |-> {"wait", "hook", "step"}]

VARIABLES
  consumed,  \* [Invs -> 0..N]           EventsConsumer.eventIndex
  status,    \* [Invs -> [Idx -> ...]]   per-delivery lifecycle
  arrivals   \* [Invs -> Seq(Idx)]       guest-visible arrival order (THE observable)

vars == <<consumed, status, arrivals>>

(***************************************************************************)
(* Delivery lifecycle:                                                     *)
(*   "unconsumed" -- not yet reached by the consumer                       *)
(*   "pending"    -- consumed; barrier registered; not yet delivered       *)
(*   "arrived"    -- delivered to the guest (appended to arrivals)         *)
(*   "retired"    -- barrier retired by the idle safety net WITHOUT a      *)
(*                   guest-visible delivery (only unclaimed buffered       *)
(*                   payloads). The payload itself remains claimable: a    *)
(*                   later Claim can still move it to "arrived", matching  *)
(*                   registerDeliveryBarrier's finish() which removes the  *)
(*                   ordering entry but does not consume the payload.      *)
(***************************************************************************)
Statuses == {"unconsumed", "pending", "arrived", "retired"}

TypeOK ==
  /\ consumed \in [Invs -> 0..N]
  /\ status   \in [Invs -> [Idx -> Statuses]]
  /\ arrivals \in [Invs -> Seq(Idx)]

Buffered(e) == ~Schedule[e].armed

\* The guest has passed the claim point for buffered payload e. Monotone in
\* the invocation's own progress, hence stable once true.
ClaimReached(i, e) == Len(arrivals[i]) >= Schedule[e].claimAfter

\* private.ts DeliveryBarrierEntry.armed, including the arm() flip at claim.
ArmedNow(i, e) == Schedule[e].armed \/ ClaimReached(i, e)

(***************************************************************************)
(* gatesOn (private.ts): whether a delivery at index e defers behind the   *)
(* still-registered earlier entry at index j. The single source of truth   *)
(* shared by the gate (Blocked) and self-resolution (SelfRes), exactly as  *)
(* the implementation shares it between awaitEarlierDeliveries and         *)
(* computeResolvesOnItsOwn. A step does not gate on an unarmed entry (an   *)
(* unclaimed buffered hook payload) -- the skip is direct, never           *)
(* transitive: a step still gates on earlier ARMED waits/hooks/steps,      *)
(* even ones themselves parked behind such a payload. The payload's idle   *)
(* safety net retires it and the parked chain then delivers in log order.  *)
(***************************************************************************)
GatesOn(i, e, j) ==
  /\ j < e
  /\ status[i][j] = "pending"
  /\ Schedule[j].kind \in DeferBehind[Schedule[e].kind]
  /\ ~(Schedule[e].kind = "step" /\ ~ArmedNow(i, j))

(***************************************************************************)
(* resolvesOnItsOwn (private.ts): a delivery is committed to reaching the  *)
(* workflow without further guest action iff it is armed and every earlier *)
(* entry it gates on is likewise self-resolving. A step parked behind an   *)
(* armed-but-parked wait is NOT self-resolving, which is what keeps idle   *)
(* (and hence the payload's retirement) reachable.                         *)
(* Terminates: every recursive call strictly decreases the index.          *)
(***************************************************************************)
RECURSIVE SelfRes(_, _)
SelfRes(i, e) ==
  /\ ArmedNow(i, e)
  /\ \A j \in 1..(e-1): GatesOn(i, e, j) => SelfRes(i, j)

(***************************************************************************)
(* awaitEarlierDeliveries (private.ts): delivery e is gated behind an      *)
(* earlier still-registered (pending) delivery j when:                     *)
(*                                                                         *)
(*  - e gates on j per GatesOn: j's kind is in DEFER_BEHIND[kind(e)], and  *)
(*    when e is a step, j is armed -- a step skips an unclaimed buffered   *)
(*    payload DIRECTLY (gating on it would stall against the guest         *)
(*    needing the step result to reach the claim), but never               *)
(*    transitively. Waits and hooks do not skip at all: for them, waiting  *)
(*    for the claim IS the ordering guarantee (a wait_completed must not   *)
(*    preempt a payload the log ordered first).                            *)
(*                                                                         *)
(*  - OR j is an armed delivery of the SAME kind (hook-hook, wait-wait).   *)
(*    DEFER_BEHIND has no such edges; in the implementation same-kind      *)
(*    order among armed deliveries comes from the serial promiseQueue      *)
(*    (hydration slots run in log order) plus hop-count homogeneity of     *)
(*    same-kind consumers. The model states the NET discipline; this is    *)
(*    assumption A4 in the README. The same-kind edge deliberately does    *)
(*    NOT apply to the claim path (Schedule[e].armed required): a claimed  *)
(*    buffered payload is anchored to the guest's claim point instead,     *)
(*    and its claim-time snapshot checks only DEFER_BEHIND kinds,          *)
(*    matching workflow/hook.ts.                                           *)
(***************************************************************************)
Blocked(i, e) ==
  LET k == Schedule[e].kind IN
  \E j \in 1..(e-1):
    \/ GatesOn(i, e, j)
    \/ /\ status[i][j] = "pending"
       /\ k # "step"            \* step-step is already a DEFER_BEHIND edge
       /\ Schedule[e].armed     \* claim path is claim-anchored, not queue-anchored
       /\ Schedule[j].kind = k
       /\ Schedule[j].armed

(***************************************************************************)
(* A buffered payload the guest is ready to claim. The claim itself runs   *)
(* on the guest's own continuation, so it takes priority over new armed    *)
(* arrivals (assumption A5: claim promptness -- the guest's current        *)
(* continuation, including the claim it performs, runs before a fresh      *)
(* delivery's resolve chain lands; the macrotask yield in                  *)
(* awaitEarlierDeliveries exists to enforce exactly this drain order).     *)
(* Multiple simultaneously claimable payloads are claimed in a             *)
(* guest-deterministic order, modeled as lowest log index first.           *)
(***************************************************************************)
ClaimableNow(i, e) ==
  /\ Buffered(e)
  /\ status[i][e] \in {"pending", "retired"}
  /\ ClaimReached(i, e)
  /\ (Barriers => ~Blocked(i, e))   \* claim-time snapshot (workflow/hook.ts)

SomeClaimable(i) == \E e \in Idx: ClaimableNow(i, e)

(***************************************************************************)
(* Quiescence (scheduleWhenIdle + hasParkedCommittedDelivery): no          *)
(* committed delivery is still in flight and the guest has no claim to     *)
(* perform. Suspension may only be accepted here; the idle safety net may  *)
(* only retire barriers here. Modeling the #3183 lesson: an idle check     *)
(* that fired while a committed delivery was parked mid-deferral produced  *)
(* a suspension carrying none of the follow-up work.                       *)
(***************************************************************************)
Idle(i) ==
  /\ ~\E e \in Idx: status[i][e] = "pending" /\ SelfRes(i, e)
  /\ ~SomeClaimable(i)

-----------------------------------------------------------------------------

Init ==
  /\ consumed = [i \in Invs |-> 0]
  /\ status   = [i \in Invs |-> [e \in Idx |-> "unconsumed"]]
  /\ arrivals = [i \in Invs |-> <<>>]

\* EventsConsumer: events are consumed strictly in log order, one at a time.
\* Different invocations advance independently (they loaded the log at
\* different times / replay at different speeds).
Consume(i) ==
  /\ consumed[i] < N
  /\ consumed' = [consumed EXCEPT ![i] = @ + 1]
  /\ status'   = [status EXCEPT ![i][consumed[i] + 1] = "pending"]
  /\ UNCHANGED arrivals

\* An armed delivery's resolve chain reaches the guest. Under Barriers this
\* requires the DEFER_BEHIND gate to be clear and no claim to be pending
\* (claim promptness, A5); without Barriers any consumed delivery may land
\* in any order -- the raw timing race.
Arrive(i, e) ==
  /\ status[i][e] = "pending"
  /\ Schedule[e].armed
  /\ Barriers => (~Blocked(i, e) /\ ~SomeClaimable(i))
  /\ status'   = [status EXCEPT ![i][e] = "arrived"]
  /\ arrivals' = [arrivals EXCEPT ![i] = Append(@, e)]
  /\ UNCHANGED consumed

\* The guest claims a buffered payload (workflow/hook.ts claim()): the
\* payload becomes guest-visible at the claim point. Claims happen in
\* guest-deterministic order (lowest index first among claimable).
Claim(i, e) ==
  /\ ClaimableNow(i, e)
  /\ \A e2 \in 1..(e-1): ~ClaimableNow(i, e2)
  /\ status'   = [status EXCEPT ![i][e] = "arrived"]
  /\ arrivals' = [arrivals EXCEPT ![i] = Append(@, e)]
  /\ UNCHANGED consumed

\* Idle safety net (registerDeliveryBarrier): an unclaimed buffered
\* payload's ordering entry retires at quiescence so deliveries gated on it
\* cannot deadlock and the suspension can fire. The payload stays claimable.
RetireAtIdle(i, e) ==
  /\ status[i][e] = "pending"
  /\ ~ArmedNow(i, e)
  /\ Idle(i)
  /\ status' = [status EXCEPT ![i][e] = "retired"]
  /\ UNCHANGED <<consumed, arrivals>>

Next ==
  \E i \in Invs:
    \/ Consume(i)
    \/ \E e \in Idx: Arrive(i, e) \/ Claim(i, e) \/ RetireAtIdle(i, e)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

IsPrefix(s, t) == Len(s) <= Len(t) /\ \A n \in 1..Len(s): s[n] = t[n]

(***************************************************************************)
(* THE theorem (T1+T2 in the README): at every reachable state, any two    *)
(* replay invocations' arrival sequences are prefix-comparable. Because    *)
(* arrivals are append-only, this simultaneously gives:                    *)
(*   - Determinism: two replays of the same prefix deliver identically.    *)
(*   - Prefix monotonicity: a replay of a longer log extends (never        *)
(*     contradicts) the deliveries of a replay of any shorter prefix --    *)
(*     so a suspension computed at prefix k stays correct as the log       *)
(*     grows, which is the property this spec exists to establish.        *)
(***************************************************************************)
PrefixConsistency ==
  \A i1, i2 \in Invs:
    IsPrefix(arrivals[i1], arrivals[i2]) \/ IsPrefix(arrivals[i2], arrivals[i1])

\* A replay invocation at an ACCEPTED suspension: whole log consumed, idle,
\* and no committed delivery still parked. (scheduleWhenIdle loops -- an
\* idle observation that unparks further deliveries re-arms the check -- so
\* by the time a WorkflowSuspension is accepted, nothing armed is pending.)
SuspensionPoint(i) ==
  /\ consumed[i] = N
  /\ Idle(i)
  /\ ~\E e \in Idx: status[i][e] = "pending" /\ ArmedNow(i, e)

(***************************************************************************)
(* Suspension-output determinism: two invocations that suspend after       *)
(* consuming the same prefix produced identical delivery histories, hence  *)
(* (deterministic guest) identical suspension outputs: same pending set,   *)
(* same commands, same per-family correlation-id ordinals. This is what    *)
(* makes concurrent suspension writes collide idempotently on correlation  *)
(* id (EntityConflictError dedup) instead of appending side by side.       *)
(***************************************************************************)
Determinism ==
  \A i1, i2 \in Invs:
    (SuspensionPoint(i1) /\ SuspensionPoint(i2)) => arrivals[i1] = arrivals[i2]

(***************************************************************************)
(* Sanity: arrivals never contain duplicates and only contain consumed     *)
(* events -- guards against modeling bugs that would vacuously satisfy     *)
(* the invariants above.                                                   *)
(***************************************************************************)
ArrivalsWellFormed ==
  \A i \in Invs:
    /\ \A n \in 1..Len(arrivals[i]): arrivals[i][n] <= consumed[i]
    /\ \A n, m \in 1..Len(arrivals[i]): n # m => arrivals[i][n] # arrivals[i][m]

=============================================================================
