------------------------------ MODULE SelfHealing ------------------------------
(***************************************************************************)
(* Self-healing of the Workflow SDK dispatch layer.                        *)
(*                                                                         *)
(* The design claim under check: if a run is stuck at any point after      *)
(* creation -- every queue message driving it lost (crash, prune, TTL) --  *)
(* then enqueueing ONE replay of the event log rehydrates every queue      *)
(* message the run needs to continue making progress. The event log is     *)
(* the source of truth; queue messages are reconstructible cache.          *)
(*                                                                         *)
(* This spec models the layer that claim lives in: not delivery ordering  *)
(* inside a replay (see ReplayDelivery.tla), but the dispatch loop --      *)
(* what a suspension pass enqueues, how the queue's idempotency dedup      *)
(* treats those enqueues, and what an adversary can lose. The run itself  *)
(* is abstracted to a set of pending entities (steps awaiting execution,   *)
(* waits awaiting their timer), each of which needs exactly one kind of    *)
(* driver message:                                                         *)
(*                                                                         *)
(*   - a pending step needs a step-dispatch message                        *)
(*     (runtime.ts: queueMessage with idempotencyKey = step.correlationId) *)
(*   - a pending wait needs a delayed continuation message                 *)
(*     (runtime/wait-continuation.ts: idempotencyKey seeded from the       *)
(*     wait's correlationId; bare correlationId for mid-range waits)       *)
(*                                                                         *)
(* The idempotency dedup exists for a good reason: every replay pass over  *)
(* a run re-observes every pending entity (e.g. once per step completion   *)
(* in Promise.all([steps..., sleep()])), and without dedup each pass       *)
(* would enqueue a fresh driver message. The dedup collapses those         *)
(* re-observations to one message per entity. The hazard is that the       *)
(* dedup record and the message have different lifetimes: worlds keep the  *)
(* idempotency record past the message's own life (wait-continuation.ts:   *)
(* "VQS keeps idempotency records until message-retention TTL;             *)
(* world-postgres keeps a completed-keys cache"). If the MESSAGE is lost   *)
(* while the RECORD survives, a healing replay re-derives the same key,    *)
(* its enqueue is silently dropped, and the entity is left with no driver  *)
(* -- the run stays stuck despite the heal.                                *)
(*                                                                         *)
(* The spec makes that lifetime split an explicit constant                 *)
(* (DedupSurvivesLoss) and checks the self-healing property against both   *)
(* semantics, and against an alternative keying discipline, so the exact   *)
(* condition under which the design claim holds is pinned down.            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  \* Sequence of pending entities the stuck run needs to drive to
  \* completion. Each: [kind: {"step", "wait"}]. These model entities whose
  \* *_created events are already durable in the event log (that is what
  \* makes them reconstructible by a replay at all).
  Entities,
  \* TRUE  -- losing a message leaves its idempotency record behind (the
  \*          documented world behavior: records live until retention TTL /
  \*          completed-keys cache, independent of the message).
  \* FALSE -- losing a message also forgets its idempotency record (a
  \*          hypothetical queue where prune purges dedup state).
  DedupSurvivesLoss,
  \* Which idempotency key a suspension pass derives for an entity's
  \* driver message:
  \*   "entity"  -- the entity's correlationId alone. This is the shipping
  \*                discipline for step dispatch and for mid-range wait
  \*                continuations.
  \*   "attempt" -- correlationId + replay-pass ordinal, so every pass can
  \*                re-enqueue. (A candidate healing discipline; costs the
  \*                one-message-per-entity collapse the dedup provides.)
  KeyMode,
  \* Bound on replay passes, to keep the state space finite. Must leave
  \* room for: initial dispatch, loss, heal, and follow-up passes.
  MaxAttempts

ASSUME
  /\ Entities \in Seq([kind: {"step", "wait"}])
  /\ DedupSurvivesLoss \in BOOLEAN
  /\ KeyMode \in {"entity", "attempt"}
  /\ MaxAttempts \in Nat

N    == Len(Entities)
EIdx == 1..N

Replay == [type |-> "replay"]

VARIABLES
  resolved,  \* SUBSET EIdx: entities with a terminal event in the log
  elapsed,   \* SUBSET EIdx: waits whose resumeAt has passed (wall clock)
  queue,     \* set of in-flight messages
  burnt,     \* set of idempotency keys the queue has ever accepted
  attempt,   \* replay-pass counter (keys in "attempt" mode; state bound)
  violation  \* TRUE once some replay pass failed to rehydrate an entity

vars == <<resolved, elapsed, queue, burnt, attempt, violation>>

\* The idempotency key a pass running now would derive for entity e.
KeyFor(e) == IF KeyMode = "attempt" THEN <<e, attempt>> ELSE <<e>>

Dispatch(e, k) == [type |-> "dispatch", ent |-> e, key |-> k]

TypeOK ==
  /\ resolved \subseteq EIdx
  /\ elapsed \subseteq EIdx
  /\ attempt \in 0..MaxAttempts
  /\ violation \in BOOLEAN

-----------------------------------------------------------------------------

\* The run starts with its initial orchestrator message enqueued -- the
\* moment after run_created. Everything downstream is derivable.
Init ==
  /\ resolved  = {}
  /\ elapsed   = {}
  /\ queue     = {Replay}
  /\ burnt     = {}
  /\ attempt   = 0
  /\ violation = FALSE

(***************************************************************************)
(* A replay pass (suspension-handler + dispatch loop in runtime.ts),       *)
(* atomic here because the handler settles all suspension writes and       *)
(* dispatches before acking:                                               *)
(*  - a pending wait whose deadline has passed is completed directly (the  *)
(*    "complete elapsed waits" pass) -- no message needed;                 *)
(*  - every other pending entity gets its driver message enqueued, keyed   *)
(*    by KeyFor. The queue drops the enqueue silently when the key was     *)
(*    ever accepted before (idempotency dedup).                            *)
(*                                                                         *)
(* Inline execution is deliberately absent: a healing replay did not       *)
(* create these steps (createdStepCorrelationIds gating) and owns none of  *)
(* them, so it reaches them through the keyed "immediate enqueue" path.    *)
(*                                                                         *)
(* The violation flag captures the self-healing postcondition: when the    *)
(* pass finishes, every still-pending entity must have a driver message    *)
(* in flight. A pass that leaves a pending entity with no message -- the   *)
(* dedup swallowed the re-enqueue and the original message no longer       *)
(* exists -- has failed to heal, and no later pass will do better (it      *)
(* derives the same key), so the flag latches.                             *)
(***************************************************************************)
DeliverReplay ==
  /\ Replay \in queue
  /\ attempt < MaxAttempts
  /\ LET pending      == EIdx \ resolved
         elapsedWaits == {e \in pending:
                            Entities[e].kind = "wait" /\ e \in elapsed}
         needDriver   == pending \ elapsedWaits
         enqueueable  == {e \in needDriver: KeyFor(e) \notin burnt}
         queueAfter   == (queue \ {Replay})
                           \cup {Dispatch(e, KeyFor(e)): e \in enqueueable}
     IN
       /\ resolved'  = resolved \cup elapsedWaits
       /\ queue'     = queueAfter
       /\ burnt'     = burnt \cup {KeyFor(e): e \in enqueueable}
       /\ attempt'   = attempt + 1
       /\ violation' = \/ violation
                       \/ \E e \in needDriver:
                            ~\E m \in queueAfter:
                              m.type = "dispatch" /\ m.ent = e
       /\ UNCHANGED elapsed

(***************************************************************************)
(* A driver message is delivered: the step executes (terminal event        *)
(* written) or the wait continuation fires at its deadline (hence the      *)
(* elapsed requirement -- the message's delaySeconds), and the handler     *)
(* wakes the orchestrator, i.e. a replay message follows.                  *)
(***************************************************************************)
DeliverDispatch(e) ==
  \E m \in queue:
    /\ m.type = "dispatch"
    /\ m.ent = e
    /\ Entities[e].kind = "wait" => e \in elapsed
    /\ queue'    = (queue \ {m}) \cup {Replay}
    /\ resolved' = resolved \cup {e}
    /\ UNCHANGED <<elapsed, burnt, attempt, violation>>

\* Wall clock: a wait's deadline passes.
Elapse(e) ==
  /\ Entities[e].kind = "wait"
  /\ e \notin elapsed
  /\ elapsed' = elapsed \cup {e}
  /\ UNCHANGED <<resolved, queue, burnt, attempt, violation>>

(***************************************************************************)
(* The adversary: any in-flight message is lost -- crash before ack with   *)
(* retries exhausted, queue prune, retention TTL. Whether the              *)
(* idempotency record dies with it is exactly the DedupSurvivesLoss        *)
(* constant.                                                               *)
(***************************************************************************)
Lose(m) ==
  /\ m \in queue
  /\ queue' = queue \ {m}
  /\ burnt' = IF m.type = "dispatch" /\ ~DedupSurvivesLoss
                THEN burnt \ {m.key}
                ELSE burnt
  /\ UNCHANGED <<resolved, elapsed, attempt, violation>>

(***************************************************************************)
(* The healing action from the design claim: an operator (or watchdog)     *)
(* enqueues one fresh replay of the run. The replay message itself is not  *)
(* idempotency-keyed against anything -- the claim's weak point is not     *)
(* this message but what the resulting pass can re-enqueue.                *)
(***************************************************************************)
Heal ==
  /\ Replay \notin queue
  /\ queue' = queue \cup {Replay}
  /\ UNCHANGED <<resolved, elapsed, burnt, attempt, violation>>

Next ==
  \/ DeliverReplay
  \/ \E e \in EIdx: DeliverDispatch(e) \/ Elapse(e)
  \/ \E m \in queue: Lose(m)
  \/ Heal

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

Complete == resolved = EIdx

(***************************************************************************)
(* THE self-healing property, as a safety postcondition on replay passes:  *)
(* no reachable pass ever finishes leaving a pending entity with no        *)
(* driver message in flight. When this holds, one healing replay from any  *)
(* degraded state rehydrates the run: every pending entity either          *)
(* resolves in the pass (elapsed wait) or has its message restored, and    *)
(* each delivery wakes the next pass, inductively down to completion.      *)
(* When it fails, TLC's trace is an execution where the heal was silently  *)
(* absorbed by the idempotency dedup and the run remains stuck.            *)
(***************************************************************************)
SelfHealSound == ~violation

=============================================================================
