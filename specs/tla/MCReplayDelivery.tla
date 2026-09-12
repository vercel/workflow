-------------------------- MODULE MCReplayDelivery --------------------------
(***************************************************************************)
(* TLC harness for ReplayDelivery: concrete schedules to check against.    *)
(*                                                                         *)
(* Schedules are finite event-log suffixes of branch-deciding resolutions. *)
(* They should exercise every ordering feature of the discipline: armed    *)
(* hooks, waits, steps (the DEFER_BEHIND edges), buffered payloads claimed *)
(* mid-run (claim anchoring + arm() flip), buffered payloads never claimed *)
(* (idle retirement + the direct step skip), and adjacent same-kind pairs. *)
(***************************************************************************)
EXTENDS ReplayDelivery

Ev(k, a, c) == [kind |-> k, armed |-> a, claimAfter |-> c]

(***************************************************************************)
(* Full-featured schedule for the main theorem (Barriers = TRUE):          *)
(*  1: hook payload, consumer already waiting (armed)                      *)
(*  2: buffered hook payload, claimed once the guest has seen 2 arrivals   *)
(*  3: wait completion (gates on the unclaimed payload at 2)               *)
(*  4: step result (skips 2 directly while unclaimed; gates on armed 3)    *)
(*  5: buffered hook payload never claimed (idle retirement path)          *)
(*  6: step result (adjacent step pair with 4 across a window boundary)    *)
(***************************************************************************)
SafeSchedule ==
  << Ev("hook", TRUE,  0),
     Ev("hook", FALSE, 2),
     Ev("wait", TRUE,  0),
     Ev("step", TRUE,  0),
     Ev("hook", FALSE, 99),
     Ev("step", TRUE,  0) >>

(***************************************************************************)
(* The tightest interplay in the discipline, isolated:                     *)
(*  1: buffered hook payload the guest never claims                        *)
(*  2: wait completion (gates on the unclaimed payload at 1)               *)
(*  3: step result (skips 1 directly, gates on the armed-but-parked 2)     *)
(*                                                                         *)
(* An invocation whose window ends at 2 goes idle, the safety net retires  *)
(* 1, and the wait delivers. An invocation whose window includes 3 must    *)
(* produce the same relative order: the step gates on the armed wait even  *)
(* while that wait is parked, idle retires the payload, and the chain      *)
(* delivers in log order. This is the shape where a transitive step skip   *)
(* would make the guest-visible order of the shared prefix depend on an    *)
(* event beyond it (the step overtaking the wait only when it is in the    *)
(* window), so it earns a dedicated config.                                *)
(***************************************************************************)
UnreadHookSchedule ==
  << Ev("hook", FALSE, 99),
     Ev("wait", TRUE,  0),
     Ev("step", TRUE,  0) >>

(***************************************************************************)
(* Minimal schedule for the falsifiability check (Barriers = FALSE): a     *)
(* wait completion followed by a step result. Unconstrained scheduling     *)
(* lets the step's (variable-hop) resolve chain outrun the earlier wait's  *)
(* in one invocation and not the other -- the Promise.race flip that       *)
(* surfaces as CorruptedEventLogError. Shows the invariants have teeth     *)
(* and that the barrier discipline is what discharges them.                *)
(***************************************************************************)
RaceSchedule ==
  << Ev("wait", TRUE, 0),
     Ev("step", TRUE, 0) >>

=============================================================================
