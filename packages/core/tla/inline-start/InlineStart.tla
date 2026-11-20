---------------------------- MODULE InlineStart ----------------------------
(***************************************************************************)
(* How `start()` creates a run whose first orchestrator message may be     *)
(* held for the sender and run inline (send-and-hold), with and without    *)
(* skipping `run_created` (WORKFLOW_INLINE_SKIP_RUN_CREATED).               *)
(*                                                                         *)
(* One run, a workflow of one step (and optionally a hook it waits on),    *)
(* spec 9's in-band fence, an at-least-once queue with leases, and a       *)
(* bounded budget of faults: the sender process crashing, a queue          *)
(* delivery crashing, a lease lapsing while its holder keeps running, and  *)
(* a write whose outcome is unknown.                                       *)
(*                                                                         *)
(* Skip = FALSE (today): `run_created` and the (held) send run             *)
(*   concurrently; a held message runs inline (turbo), and its             *)
(*   `run_started` creates the run from `runInput` if `run_created` has    *)
(*   not landed.                                                           *)
(* Skip = TRUE: the held send goes first.                                  *)
(*   held      -> no `run_created`; the inline turbo delivery's            *)
(*                `run_started` creates the run, and `start()` returns     *)
(*                once that write settles.                                 *)
(*   not_held  -> `start()` writes `run_created` (awaited) after the       *)
(*                answer; the queue delivers the message.                  *)
(*   threw     -> re-send without a hold (same idempotency key) beside     *)
(*                `run_created`.                                           *)
(*                                                                         *)
(* Shape: how the World records a creating `run_started`:                  *)
(*   "synthetic" -> a synthetic `run_created` at slot 1, `run_started` at  *)
(*                  slot 2 (today's resilient start; any World without     *)
(*                  `createsRun`);                                         *)
(*   "alone"     -> the `run_started` alone at slot 1 (`createsRun`).      *)
(* Both keep the in-band count a `run_created` log has: the creation is    *)
(* position 1, `run_started` position 2.                                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Skip,            \* WORKFLOW_INLINE_SKIP_RUN_CREATED=1 (and the capability)
  Shape,           \* "synthetic" | "alone"
  HasHook,         \* the workflow waits on a hook a resume delivers
  MaxFaults,       \* bound on injected faults (crashes, lapses, unknown writes)
  AllowInvalid,    \* the run's input may be one every creation refuses (a 400)
  Slots,           \* concurrent deliveries (inline + queue), e.g. {1,2,3}
  \* Seeded bugs, each FALSE in a correct configuration:
  BugReturnEarly,  \* Skip: `start()` returns success as soon as the hold is held
  BugNoInputOnRedelivery, \* a redelivery's `run_started` drops `runInput`
  \* Proposal: Skip, after a thrown held send, re-send first and write
  \* `run_created` only once the message is enqueued (instead of beside it).
  ThrewResendFirst

ASSUME Skip \in BOOLEAN /\ Shape \in {"synthetic", "alone"}
ASSUME HasHook \in BOOLEAN /\ MaxFaults \in Nat /\ AllowInvalid \in BOOLEAN
ASSUME BugReturnEarly \in BOOLEAN /\ BugNoInputOnRedelivery \in BOOLEAN
ASSUME ThrewResendFirst \in BOOLEAN

\* The shape a creating `run_started` gets: only a Skip SDK sends `createsRun`.
EffShape == IF Skip THEN Shape ELSE "synthetic"

\* The orchestrator's in-band writes, in order, after the run's creation.
W == IF HasHook
       THEN <<"run_started", "step", "hook_created", "run_completed">>
       ELSE <<"run_started", "step", "run_completed">>

Msgs == {"M0", "W1"}   \* the start message (carries runInput), a hook wake

VARIABLES
  log,        \* the run's event log: records [t |-> type, creates |-> BOOLEAN]
  cnt,        \* the World's in-band count (0 before the run exists)
  created,    \* the run row exists
  storedInput,\* the input the run row holds
  createdAt,  \* the run row's creation time (the slot of its creation event)
  valid,      \* whether the run's input can be stored at all
  msg,        \* message state: "unsent" | "queued" | "leased" | "acked"
  holder,     \* the slot holding a message's lease (0 for none)
  dcount,     \* deliveries of a message so far (capped at 2)
  slot,       \* delivery slots
  sp,         \* start(): "init" | "both" | "send" | "await" | "rc" | "done"
  rcSt,       \* start()'s run_created: "idle" | "pending" | "ok" | "retryable" | "permanent"
  sndSt,      \* start()'s send: "idle" | "pending" | "resend" | "done"
  result,     \* what start() came to: "none" | "ok" | "resilient" | "threw" | "dead"
  report,     \* the inline delivery's run_started outcome, for start():
              \* "none" | "ok" | "retryable" | "permanent" | "ended"
  senderAlive,\* the process that called start() (and runs the inline delivery)
  faults

vars == <<log, cnt, created, storedInput, createdAt, valid, msg, holder,
          dcount, slot, sp, rcSt, sndSt, result, report, senderAlive, faults>>

Free == [st |-> "free", m |-> "none", turbo |-> FALSE, exp |-> 0,
         pos |-> 0, inproc |-> FALSE, loaded |-> FALSE, input |-> FALSE]

Init ==
  /\ log = << >>
  /\ cnt = 0
  /\ created = FALSE
  /\ storedInput = "none"
  /\ createdAt = 0
  /\ valid \in (IF AllowInvalid THEN BOOLEAN ELSE {TRUE})
  /\ msg = [m \in Msgs |-> "unsent"]
  /\ holder = [m \in Msgs |-> 0]
  /\ dcount = [m \in Msgs |-> 0]
  /\ slot = [s \in Slots |-> Free]
  /\ sp = "init"
  /\ rcSt = "idle"
  /\ sndSt = "idle"
  /\ result = "none"
  /\ report = "none"
  /\ senderAlive = TRUE
  /\ faults = 0

-----------------------------------------------------------------------------
(* Helpers *)

Types == {log[i].t : i \in DOMAIN log}
Has(t) == t \in Types
IsCreation(e) == e.t = "run_created" \/ (e.t = "run_started" /\ e.creates)
Creations == SelectSeq(log, IsCreation)
SlotOf(t) == CHOOSE i \in DOMAIN log : log[i].t = t
CountOf(t) == Len(SelectSeq(log, LAMBDA e : e.t = t))
Completed == Has("run_completed")
Min2(n) == IF n >= 2 THEN 2 ELSE n
FreeSlot == {s \in Slots : slot[s].st = "free"}
CanFault == faults < MaxFaults

\* The run's creation, by whichever write gets there first.
CreateBy(viaStart) ==
  /\ created' = TRUE
  /\ storedInput' = "IN"
  /\ createdAt' = 1
  /\ IF viaStart
       THEN /\ log' = <<[t |-> "run_created", creates |-> FALSE]>>
            /\ cnt' = 1
       ELSE IF EffShape = "synthetic"
         THEN /\ log' = <<[t |-> "run_created", creates |-> FALSE],
                          [t |-> "run_started", creates |-> FALSE]>>
              /\ cnt' = 2
         ELSE /\ log' = <<[t |-> "run_started", creates |-> TRUE]>>
              /\ cnt' = 2

\* A delivery `s` gives its message back (counted redelivery) or acks it.
Release(s, ack) ==
  LET m == slot[s].m IN
  /\ IF holder[m] = s
       THEN /\ msg' = [msg EXCEPT ![m] = IF ack THEN "acked" ELSE "queued"]
            /\ holder' = [holder EXCEPT ![m] = 0]
       ELSE UNCHANGED <<msg, holder>>
  /\ slot' = [slot EXCEPT ![s] = Free]

\* What the inline delivery tells start() when it ends without a report.
EndReport(s) ==
  report' = IF slot[s].inproc /\ report = "none" THEN "ended" ELSE report

-----------------------------------------------------------------------------
(* start() *)

\* Skip off: run_created and the held send, concurrently.
StartBegin ==
  /\ sp = "init" /\ senderAlive
  /\ IF Skip
       THEN /\ sp' = "send" /\ sndSt' = "pending" /\ UNCHANGED rcSt
       ELSE /\ sp' = "both" /\ rcSt' = "pending" /\ sndSt' = "pending"
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, msg, holder,
                 dcount, slot, result, report, senderAlive, faults>>

\* The held send's answer.
HeldAnswer ==
  \E s \in FreeSlot :
    /\ msg' = [msg EXCEPT !["M0"] = "leased"]
    /\ holder' = [holder EXCEPT !["M0"] = s]
    /\ dcount' = [dcount EXCEPT !["M0"] = Min2(@ + 1)]
    /\ slot' = [slot EXCEPT ![s] = [Free EXCEPT !.st = "run", !.m = "M0",
                 !.turbo = (dcount["M0"] = 0), !.inproc = TRUE,
                 !.input = TRUE]]

StartSend ==
  /\ sndSt = "pending" /\ senderAlive /\ sp \in {"both", "send"}
  /\ \/ \* held
        /\ HeldAnswer
        /\ sndSt' = "done"
        /\ IF Skip
             THEN IF BugReturnEarly
                    THEN sp' = "done" /\ result' = "ok"
                    ELSE sp' = "await" /\ UNCHANGED result
             ELSE UNCHANGED <<sp, result>>
        /\ UNCHANGED rcSt
     \/ \* not_held (any reason): the queue delivers it
        /\ msg' = [msg EXCEPT !["M0"] = "queued"]
        /\ sndSt' = "done"
        /\ IF Skip THEN sp' = "rc" /\ rcSt' = "pending"
                   ELSE UNCHANGED <<sp, rcSt>>
        /\ UNCHANGED <<holder, dcount, slot, result>>
     \/ \* the held send threw: it may or may not have enqueued
        /\ \E enq \in BOOLEAN :
             msg' = [msg EXCEPT !["M0"] = IF enq THEN "queued" ELSE "unsent"]
        /\ sndSt' = "resend"
        /\ IF Skip
             THEN /\ sp' = "both"
                  /\ rcSt' = IF ThrewResendFirst THEN "after_resend" ELSE "pending"
             ELSE UNCHANGED <<sp, rcSt>>
        /\ UNCHANGED <<holder, dcount, slot, result>>
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, report,
                 senderAlive, faults>>

\* The plain re-send after a thrown held send; the idempotency key drops it
\* when the held attempt did enqueue.
StartResend ==
  /\ sndSt = "resend" /\ senderAlive
  /\ msg' = [msg EXCEPT !["M0"] = IF @ = "unsent" THEN "queued" ELSE @]
  /\ sndSt' = "done"
  /\ rcSt' = IF rcSt = "after_resend" THEN "pending" ELSE rcSt
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, holder,
                 dcount, slot, sp, result, report, senderAlive, faults>>

\* start()'s run_created (out of band, unfenced).
StartRunCreated ==
  /\ rcSt = "pending" /\ senderAlive
  /\ \/ /\ ~valid
        /\ rcSt' = "permanent"
        /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, faults>>
     \/ /\ valid
        /\ IF created
             THEN UNCHANGED <<log, cnt, created, storedInput, createdAt>> \* 409
             ELSE CreateBy(TRUE)
        /\ rcSt' = "ok"
        /\ UNCHANGED faults
     \/ \* a retryable failure (429/5xx/transport), committed or not
        /\ valid /\ CanFault
        /\ faults' = faults + 1
        /\ rcSt' = "retryable"
        /\ \/ UNCHANGED <<log, cnt, created, storedInput, createdAt>>
           \/ /\ IF created THEN UNCHANGED <<log, cnt, created, storedInput, createdAt>>
                            ELSE CreateBy(TRUE)
  /\ UNCHANGED <<valid, msg, holder, dcount, slot, sp, sndSt, result, report,
                 senderAlive>>

\* start() returns once both writes settled (or, Skip, the creation did).
StartFinish ==
  /\ senderAlive
  /\ \/ /\ sp \in {"both", "rc"} /\ rcSt \in {"ok", "retryable", "permanent"}
        /\ sndSt \in {"idle", "done"}
        /\ result' = CASE rcSt = "ok" -> "ok"
                       [] rcSt = "retryable" -> "resilient"
                       [] rcSt = "permanent" -> "threw"
     \/ /\ sp = "await" /\ report # "none"
        /\ result' = CASE report = "ok" -> "ok"
                       [] report = "permanent" -> "threw"
                       [] OTHER -> "resilient"
  /\ sp' = "done"
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, msg, holder,
                 dcount, slot, rcSt, sndSt, report, senderAlive, faults>>

\* The process that called start() dies: start() and its inline delivery
\* with it. A lease it held lapses into a queue delivery.
SenderCrash ==
  /\ senderAlive /\ CanFault /\ sp # "init"
  /\ senderAlive' = FALSE
  /\ faults' = faults + 1
  /\ result' = IF result = "none" THEN "dead" ELSE result
  /\ sp' = "done"
  /\ LET inline == {s \in Slots : slot[s].inproc /\ slot[s].st = "run"} IN
       IF inline = {} THEN UNCHANGED <<msg, holder, slot>>
                      ELSE Release(CHOOSE s \in inline : TRUE, FALSE)
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, dcount,
                 rcSt, sndSt, report>>

-----------------------------------------------------------------------------
(* Queue and deliveries *)

Deliver(m) ==
  /\ msg[m] = "queued"
  /\ \E s \in FreeSlot :
       /\ msg' = [msg EXCEPT ![m] = "leased"]
       /\ holder' = [holder EXCEPT ![m] = s]
       /\ dcount' = [dcount EXCEPT ![m] = Min2(@ + 1)]
       /\ slot' = [slot EXCEPT ![s] = [Free EXCEPT !.st = "run", !.m = m,
                    !.turbo = (m = "M0" /\ dcount["M0"] = 0),
                    !.input = (m = "M0" /\ ~(BugNoInputOnRedelivery /\ dcount["M0"] > 0))]]
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, sp, rcSt,
                 sndSt, result, report, senderAlive, faults>>

\* A non-turbo delivery loads the log (one consistent read) and replays it:
\* it resumes at the first in-band write not yet in the log.
Load(s) ==
  /\ slot[s].st = "run" /\ ~slot[s].turbo /\ ~slot[s].loaded
  /\ slot' = [slot EXCEPT ![s].loaded = TRUE,
       ![s].exp = IF created THEN cnt ELSE 1,
       ![s].pos = IF created
                    THEN 1 + Cardinality({i \in 1..Len(W) : Has(W[i])})
                    ELSE 1]
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, msg, holder,
                 dcount, sp, rcSt, sndSt, result, report, senderAlive, faults>>

\* Turbo: no load; the count is the one right after the run's creation.
TurboSetup(s) ==
  /\ slot[s].st = "run" /\ slot[s].turbo /\ ~slot[s].loaded
  /\ slot' = [slot EXCEPT ![s].loaded = TRUE, ![s].exp = 1, ![s].pos = 1]
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, msg, holder,
                 dcount, sp, rcSt, sndSt, result, report, senderAlive, faults>>

Ready(s) == slot[s].st = "run" /\ slot[s].loaded

\* Nothing left to write, or waiting on a hook not yet received: ack.
Finish(s) ==
  /\ Ready(s)
  /\ IF slot[s].pos > Len(W) THEN TRUE
     ELSE W[slot[s].pos] = "run_completed" /\ HasHook /\ ~Has("hook_received")
  /\ Release(s, TRUE)
  /\ EndReport(s)
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, dcount, sp,
                 rcSt, sndSt, result, senderAlive, faults>>

NextWrite(s) == W[slot[s].pos]
Writable(s) ==
  /\ Ready(s) /\ slot[s].pos <= Len(W)
  /\ ~(NextWrite(s) = "run_completed" /\ HasHook /\ ~Has("hook_received"))

Advance(s) == slot' = [slot EXCEPT ![s].exp = @ + 1, ![s].pos = @ + 1]

\* One in-band write, with the World's answer.
Write(s) ==
  /\ Writable(s)
  /\ LET t == NextWrite(s)
         first == t = "run_started"
         rep(o) == IF slot[s].inproc /\ first /\ report = "none" THEN o ELSE report
     IN
     IF ~created
       THEN \* only a creating run_started can be written to a missing run
            IF first /\ slot[s].input
              THEN IF ~valid
                     THEN \* refused for good: the delivery gives up
                          /\ Release(s, TRUE) /\ report' = rep("permanent")
                          /\ UNCHANGED <<log, cnt, created, storedInput, createdAt>>
                     ELSE /\ slot[s].exp = 1
                          /\ CreateBy(FALSE) /\ Advance(s) /\ report' = rep("ok")
                          /\ UNCHANGED <<msg, holder>>
              ELSE \* 404: retried by redelivery
                   /\ Release(s, FALSE) /\ EndReport(s)
                   /\ UNCHANGED <<log, cnt, created, storedInput, createdAt>>
       ELSE IF slot[s].exp = cnt
         THEN /\ log' = Append(log, [t |-> t, creates |-> FALSE])
              /\ cnt' = cnt + 1
              /\ Advance(s) /\ report' = rep("ok")
              /\ UNCHANGED <<created, storedInput, createdAt, msg, holder>>
         ELSE \* the fence refuses: counted redelivery, never an ack
              /\ Release(s, FALSE) /\ EndReport(s)
              /\ UNCHANGED <<log, cnt, created, storedInput, createdAt>>
  /\ UNCHANGED <<valid, dcount, sp, rcSt, sndSt, result, senderAlive, faults>>

\* A write whose outcome is unknown (transport error, 5xx): it may have
\* committed; the delivery stops and its message is redelivered.
WriteUnknown(s) ==
  /\ Writable(s) /\ CanFault /\ valid
  /\ faults' = faults + 1
  /\ LET t == NextWrite(s) IN
     \/ UNCHANGED <<log, cnt, created, storedInput, createdAt>>
     \/ IF ~created
          THEN /\ t = "run_started" /\ slot[s].input /\ slot[s].exp = 1
               /\ CreateBy(FALSE)
          ELSE /\ slot[s].exp = cnt
               /\ log' = Append(log, [t |-> t, creates |-> FALSE])
               /\ cnt' = cnt + 1
               /\ UNCHANGED <<created, storedInput, createdAt>>
  /\ Release(s, FALSE)
  /\ report' = IF slot[s].inproc /\ NextWrite(s) = "run_started" /\ report = "none"
                 THEN "retryable" ELSE report
  /\ UNCHANGED <<valid, dcount, sp, rcSt, sndSt, result, senderAlive>>

\* A queue delivery's process dies; its lease lapses.
DeliveryCrash(s) ==
  /\ slot[s].st = "run" /\ ~slot[s].inproc /\ CanFault
  /\ faults' = faults + 1
  /\ Release(s, FALSE)
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, dcount, sp,
                 rcSt, sndSt, result, report, senderAlive>>

\* A lease lapses while its holder keeps running (a stall): the queue
\* redelivers beside it.
Lapse(m) ==
  /\ msg[m] = "leased" /\ CanFault
  /\ faults' = faults + 1
  /\ msg' = [msg EXCEPT ![m] = "queued"]
  /\ holder' = [holder EXCEPT ![m] = 0]
  /\ UNCHANGED <<log, cnt, created, storedInput, createdAt, valid, dcount, slot,
                 sp, rcSt, sndSt, result, report, senderAlive>>

\* resumeHook(): records the payload out of band, then wakes the run.
Resume ==
  /\ HasHook /\ Has("hook_created") /\ ~Has("hook_received")
  /\ log' = Append(log, [t |-> "hook_received", creates |-> FALSE])
  /\ msg' = [msg EXCEPT !["W1"] = "queued"]
  /\ UNCHANGED <<cnt, created, storedInput, createdAt, valid, holder, dcount,
                 slot, sp, rcSt, sndSt, result, report, senderAlive, faults>>

-----------------------------------------------------------------------------
StartStep == StartBegin \/ StartSend \/ StartResend \/ StartRunCreated \/ StartFinish
DeliveryStep(s) == Load(s) \/ TurboSetup(s) \/ Finish(s) \/ Write(s)
Faults == SenderCrash \/ (\E s \in Slots : WriteUnknown(s) \/ DeliveryCrash(s))
          \/ (\E m \in Msgs : Lapse(m))

Next ==
  \/ StartStep
  \/ \E m \in Msgs : Deliver(m)
  \/ \E s \in Slots : DeliveryStep(s)
  \/ Resume
  \/ Faults

Fairness ==
  /\ WF_vars(StartStep)
  /\ \A m \in Msgs : WF_vars(Deliver(m))
  /\ \A s \in Slots : WF_vars(DeliveryStep(s))
  /\ WF_vars(Resume)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* The run exists exactly once, created at slot 1, with its input; the log
\* never holds both a `run_created` and a creating `run_started`.
CreatedOnce ==
  /\ Len(Creations) = (IF created THEN 1 ELSE 0)
  /\ created => IsCreation(log[1])
  /\ created => storedInput = "IN"
  /\ ~(Has("run_created") /\ \E i \in DOMAIN log :
          log[i].t = "run_started" /\ log[i].creates)
  /\ ~created => log = << >>

\* Each in-band write at most once (the step's commit included).
ExactlyOnce ==
  \A i \in 1..Len(W) : CountOf(W[i]) <= 1

\* The in-band count matches the log: creation counts 1 in either shape.
CountMatches ==
  created => cnt = 1 + Cardinality({i \in 1..Len(W) : Has(W[i])})

\* created-time <= started-time <= the step's commit; createdAt is the
\* creation event's slot.
TimesConsistent ==
  /\ created => createdAt = 1
  /\ Has("run_started") => createdAt <= SlotOf("run_started")
  /\ Has("step") => SlotOf("run_started") < SlotOf("step")

\* start()'s contract: a plain success means the run exists, and no
\* permanent creation error is swallowed by one.
StartContract ==
  /\ result = "ok" => created /\ valid
  /\ result = "threw" => ~valid

\* A run that exists always gets its message (no run that nothing will run,
\* left `pending` when the sender dies between `run_created` and the send).
NoOrphanRun == [](created => <>(msg["M0"] # "unsent"))

Inv == CreatedOnce /\ ExactlyOnce /\ CountMatches /\ TimesConsistent
       /\ StartContract

\* Every accepted run with a valid input completes; every step commits.
Accepted == msg["M0"] # "unsent"
NoStranding == [](Accepted /\ valid => <>(Completed /\ CountOf("step") = 1))
\* A run whose input is refused never holds its message forever.
InvalidSettles == [](Accepted /\ ~valid => <>(msg["M0"] = "acked"))
=============================================================================
