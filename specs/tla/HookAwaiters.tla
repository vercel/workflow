---------------------------- MODULE HookAwaiters ----------------------------
(***************************************************************************)
(* Which awaiter a hook payload settles, when workflow code races a hook   *)
(* against a timeout and awaits it again after losing (vercel/workflow     *)
(* #4264, fixed in #4324).                                                 *)
(*                                                                         *)
(* A Hook is a thenable. Every `hook.then()` (and so every `await hook`,   *)
(* including one inside `Promise.race`) asks the hook for an awaiter, and  *)
(* each `hook_received` the log walk consumes settles one awaiter.         *)
(* `Promise.race` never tells the hook that a branch lost, so the hook     *)
(* cannot distinguish an abandoned awaiter from a live one. The question   *)
(* this spec answers is: which payloads can end up in an awaiter that no   *)
(* workflow code is still waiting on?                                      *)
(*                                                                         *)
(* Code being modeled (packages/core/src/workflow/hook.ts):                *)
(*   - createHookPromise   : Then (decision order: in-flight, buffered,    *)
(*                           shared pending, enrol a new awaiter)          *)
(*   - hook_received branch: Consume (awaiter picked at consumption time:  *)
(*                           `promises.shift()`, `inFlight = next`, or     *)
(*                           buffered into `payloadsQueue`)                *)
(*   - deferred resolution : Settle (`earlierDelivered.then(...)` clears   *)
(*                           `inFlight` and resolves the awaiter)          *)
(*                                                                         *)
(* The two halves of the fix are separate constants so TLC can show that  *)
(* each one is necessary (see the ablation configs in the README).         *)
(*                                                                         *)
(* Timing adversary: the log walk runs ahead of workflow code (Consume can *)
(* fire at any point, e.g. during a replay before the guest reaches its    *)
(* next race), a consumed payload settles only after earlier deliveries    *)
(* (Settle is a separate, later step), and either branch of a race may win *)
(* while both are pending. Letting the timeout win even when the barrier   *)
(* discipline would have delivered the payload first is a superset of the *)
(* real orderings, so the safety results below hold for the real engine;  *)
(* ReplayDelivery.tla is what pins the ordering itself.                    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  \* Fix part 1: an await made while no payload is available shares the
  \* pending awaiter (`promises[0]`) instead of enrolling another.
  SharePending,
  \* Fix part 2: an await made while a consumed payload has not settled yet
  \* shares that awaiter (`inFlight`), ahead of anything buffered after it.
  ShareInFlight,
  \* How workflow code awaits the hook in each race:
  \*   "fresh" -- Promise.race([hook.then(...), sleep(...)]) every time
  \*   "once"  -- const p = hook.then(...) created once, raced every time
  \*              (the pattern the hooks docs recommend), re-created only
  \*              after it delivers
  Pattern,
  \* Number of races the workflow runs (each one a lost race or a delivery).
  NRaces,
  \* Number of payloads the sender may send (`resumeHook()` calls).
  NPayloads

ASSUME SharePending \in BOOLEAN /\ ShareInFlight \in BOOLEAN
ASSUME Pattern \in {"fresh", "once"}
ASSUME NRaces \in Nat \ {0} /\ NPayloads \in Nat \ {0}

\* Each race asks for at most one awaiter, so NRaces bounds the awaiter ids.
Awaiters == 1..NRaces
Payloads == 1..NPayloads

VARIABLES
  \* --- hook implementation state (hook.ts) ---
  pending,    \* `promises`: awaiters enrolled and not yet picked by a payload
  inFlight,   \* `inFlight`: awaiter a consumed payload is on its way to, or 0
  buffered,   \* `payloadsQueue`: payloads consumed while no awaiter waited
  settleQ,    \* consumed-but-unsettled <<awaiter, payload>> pairs, in log
              \* order (same-kind deliveries settle in log order, A4)
  value,      \* settled payload per awaiter, 0 while unsettled
  nAw,        \* awaiters allocated so far
  \* --- event log ---
  sent,       \* hook_received events appended (payloads 1..sent)
  consumed,   \* hook_received events the log walk has consumed
  \* --- workflow code (the guest) ---
  pc,         \* "idle" (between races) | "racing" | "done"
  race,       \* races started so far
  live,       \* awaiter the guest is waiting on in the current race
  needNew,    \* "once" pattern: the held promise has delivered (or none yet)
  delivered,  \* payloads the guest observed, in order
  \* --- history ---
  lostRacing, \* a payload settled a non-live awaiter while the guest raced
  lostIdle    \* a payload settled a non-live awaiter between races

vars == <<pending, inFlight, buffered, settleQ, value, nAw, sent, consumed,
          pc, race, live, needNew, delivered, lostRacing, lostIdle>>

\* An awaiter some workflow code is still waiting on: the current race's,
\* or, with the "once" pattern, the held promise between races too.
Live(a) ==
  /\ a = live
  /\ \/ pc = "racing"
     \/ Pattern = "once" /\ ~needNew /\ pc = "idle"

-----------------------------------------------------------------------------
\* createHookPromise(): which awaiter does this `then()` get?
Then ==
  IF ShareInFlight /\ inFlight # 0 THEN
    \* `if (inFlight) return inFlight.promise`
    /\ live' = inFlight
    /\ UNCHANGED <<pending, buffered, value, nAw>>
  ELSE IF buffered # <<>> THEN
    \* `payloadsQueue.shift().claim()`: a fresh promise settled with the
    \* oldest buffered payload (claimed promptly, A5)
    /\ nAw' = nAw + 1
    /\ live' = nAw + 1
    /\ value' = [value EXCEPT ![nAw + 1] = Head(buffered)]
    /\ buffered' = Tail(buffered)
    /\ UNCHANGED pending
  ELSE IF SharePending /\ pending # <<>> THEN
    \* `const pending = promises[0]; if (pending) return pending.promise`
    /\ live' = Head(pending)
    /\ UNCHANGED <<pending, buffered, value, nAw>>
  ELSE
    \* `promises.push(resolvers)`
    /\ nAw' = nAw + 1
    /\ live' = nAw + 1
    /\ pending' = Append(pending, nAw + 1)
    /\ UNCHANGED <<buffered, value>>

StartRace ==
  /\ pc = "idle"
  /\ race < NRaces
  /\ race' = race + 1
  /\ pc' = "racing"
  /\ IF Pattern = "fresh" \/ needNew
       THEN Then /\ needNew' = FALSE
       ELSE UNCHANGED <<pending, buffered, value, nAw, live, needNew>>
  /\ UNCHANGED <<inFlight, settleQ, sent, consumed, delivered,
                 lostRacing, lostIdle>>

\* The hook branch wins: the guest observes the payload and goes on (in the
\* "fresh" pattern its next race is a sequential `await hook`).
Win ==
  /\ pc = "racing"
  /\ value[live] # 0
  /\ delivered' = Append(delivered, value[live])
  /\ pc' = "idle"
  /\ needNew' = TRUE
  /\ UNCHANGED <<pending, inFlight, buffered, settleQ, value, nAw, sent,
                 consumed, race, live, lostRacing, lostIdle>>

\* The sleep branch wins. In the "fresh" pattern the race's awaiter is now
\* abandoned; nothing tells the hook.
Timeout ==
  /\ pc = "racing"
  /\ value[live] = 0
  /\ pc' = "idle"
  /\ UNCHANGED <<pending, inFlight, buffered, settleQ, value, nAw, sent,
                 consumed, race, live, needNew, delivered, lostRacing,
                 lostIdle>>

Finish ==
  /\ pc = "idle"
  /\ race = NRaces
  /\ pc' = "done"
  /\ UNCHANGED <<pending, inFlight, buffered, settleQ, value, nAw, sent,
                 consumed, race, live, needNew, delivered, lostRacing,
                 lostIdle>>

-----------------------------------------------------------------------------
\* The sender: `resumeHook()` appends a hook_received to the log.
Send ==
  /\ sent < NPayloads
  /\ sent' = sent + 1
  /\ UNCHANGED <<pending, inFlight, buffered, settleQ, value, nAw, consumed,
                 pc, race, live, needNew, delivered, lostRacing, lostIdle>>

\* The log walk consumes the next hook_received: the awaiter is picked NOW
\* (`promises.shift()`), but settled later, after earlier deliveries.
Consume ==
  /\ consumed < sent
  /\ consumed' = consumed + 1
  /\ IF pending # <<>>
       THEN /\ settleQ' = Append(settleQ, <<Head(pending), consumed + 1>>)
            /\ inFlight' = Head(pending)
            /\ pending' = Tail(pending)
            /\ UNCHANGED buffered
       ELSE /\ buffered' = Append(buffered, consumed + 1)
            /\ UNCHANGED <<settleQ, inFlight, pending>>
  /\ UNCHANGED <<value, nAw, sent, pc, race, live, needNew, delivered,
                 lostRacing, lostIdle>>

\* `earlierDelivered.then(...)`: clear `inFlight` and resolve the awaiter.
Settle ==
  /\ settleQ # <<>>
  /\ LET a == Head(settleQ)[1]
         p == Head(settleQ)[2]
     IN /\ value' = [value EXCEPT ![a] = p]
        /\ inFlight' = IF inFlight = a THEN 0 ELSE inFlight
        /\ lostRacing' = (lostRacing \/ (~Live(a) /\ pc = "racing"))
        /\ lostIdle' = (lostIdle \/ (~Live(a) /\ pc = "idle"))
  /\ settleQ' = Tail(settleQ)
  /\ UNCHANGED <<pending, buffered, nAw, sent, consumed, pc, race, live,
                 needNew, delivered>>

-----------------------------------------------------------------------------
Init ==
  /\ pending = <<>>
  /\ inFlight = 0
  /\ buffered = <<>>
  /\ settleQ = <<>>
  /\ value = [a \in Awaiters |-> 0]
  /\ nAw = 0
  /\ sent = 0
  /\ consumed = 0
  /\ pc = "idle"
  /\ race = 0
  /\ live = 0
  /\ needNew = TRUE
  /\ delivered = <<>>
  /\ lostRacing = FALSE
  /\ lostIdle = FALSE

Next ==
  \/ StartRace \/ Win \/ Timeout \/ Finish
  \/ Send \/ Consume \/ Settle

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
  /\ pending \in Seq(Awaiters)
  /\ inFlight \in Awaiters \cup {0}
  /\ buffered \in Seq(Payloads)
  /\ settleQ \in Seq(Awaiters \X Payloads)
  /\ value \in [Awaiters -> Payloads \cup {0}]
  /\ nAw \in 0..NRaces
  /\ sent \in 0..NPayloads /\ consumed \in 0..sent
  /\ pc \in {"idle", "racing", "done"}
  /\ race \in 0..NRaces
  /\ live \in Awaiters \cup {0}
  /\ needNew \in BOOLEAN
  /\ delivered \in Seq(Payloads)
  /\ lostRacing \in BOOLEAN /\ lostIdle \in BOOLEAN

\* Every consumed payload is in exactly one place: buffered, on its way to an
\* awaiter, or settled into one. No payload is duplicated or dropped by the
\* bookkeeping itself (losses are only ever to the wrong awaiter).
Conservation ==
  \A p \in 1..consumed :
    Cardinality({i \in DOMAIN buffered : buffered[i] = p})
      + Cardinality({i \in DOMAIN settleQ : settleQ[i][2] = p})
      + Cardinality({a \in Awaiters : value[a] = p}) = 1

\* Successive deliveries to the workflow are distinct and in log order: a
\* sequential `await hook` after a delivery never sees the same payload
\* again (`inFlight` is cleared before the awaiter resolves) and never skips
\* back to an older one.
InOrder ==
  \A i \in 1..Len(delivered) - 1 : delivered[i] < delivered[i + 1]

\* Fix part 1's structural claim: `promises` holds at most one awaiter, and
\* never while one is in flight (part 2).
SingleAwaiter ==
  /\ Len(pending) <= 1
  /\ ShareInFlight => (inFlight # 0 => pending = <<>>)

\* #4264: a payload never settles an abandoned awaiter while the workflow is
\* waiting on a different one. This is what the PR fixes.
NoLossWhileRacing == ~lostRacing

\* Stronger: no payload ever settles an awaiter nobody is waiting on. With
\* the "fresh" pattern this does NOT hold even with the fix: a payload that
\* settles between races (e.g. during a step) goes to the last race's
\* abandoned awaiter. That is the documented gap, and why the docs
\* recommend the "once" pattern, for which it holds.
NoLoss == ~lostRacing /\ ~lostIdle

=============================================================================
