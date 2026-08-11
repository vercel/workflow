-------------------------- MODULE MCReplayDelivery --------------------------
(***************************************************************************)
(* TLC harness for ReplayDelivery: concrete schedules to check against.    *)
(*                                                                         *)
(* Schedules are finite event-log suffixes of branch-deciding resolutions. *)
(* They should exercise every ordering feature of the discipline: armed    *)
(* hooks, waits, steps (the DEFER_BEHIND edges), buffered payloads claimed *)
(* mid-run (claim anchoring + arm() flip), buffered payloads never claimed *)
(* (idle retirement + the step skip rule), and adjacent same-kind pairs.   *)
(***************************************************************************)
EXTENDS ReplayDelivery

Ev(k, a, c) == [kind |-> k, armed |-> a, claimAfter |-> c]

(***************************************************************************)
(* Full-featured schedule for the positive theorem (Barriers = TRUE,       *)
(* SkipMode = "direct"):                                                   *)
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
(* Minimal counterexample schedule for the negative result (Barriers =     *)
(* FALSE): a wait completion followed by a step result. Unconstrained      *)
(* scheduling lets the step's (variable-hop) resolve chain outrun the      *)
(* earlier wait's in one invocation and not the other -- the exact         *)
(* Promise.race flip that surfaces as CorruptedEventLogError.              *)
(***************************************************************************)
RaceSchedule ==
  << Ev("wait", TRUE, 0),
     Ev("step", TRUE, 0) >>

(***************************************************************************)
(* Minimal schedule exposing the transitive-skip / idle-retirement         *)
(* asymmetry in the PRE-#3406 discipline (Barriers = TRUE, SkipMode =      *)
(* "transitive"):                                                          *)
(*  1: buffered hook payload the guest never claims                        *)
(*  2: wait completion (gates on the unclaimed payload at 1)               *)
(*  3: step result                                                         *)
(*                                                                         *)
(* An invocation whose window ends at 2 goes idle, the safety net retires  *)
(* 1, and the wait delivers: guest sees <<2>>. An invocation whose window  *)
(* includes 3 lets the step skip past 1 and 2 (both non-self-resolving):   *)
(* guest sees <<3, 2>>. The shared prefix's guest-visible order then       *)
(* depends on an event BEYOND the shared prefix, so a guest that races the *)
(* wait against the step diverges -- and a suspension committed at prefix  *)
(* 2 is contradicted by the full-window replay. #3406 narrows the skip to  *)
(* direct-only (SkipMode = "direct"): the step gates on the armed wait at  *)
(* 2 even while 2 is parked behind 1, so both windows deliver <<2, ...>>   *)
(* -- checked by ReplayDeliveryCurrentHazard.cfg.                          *)
(***************************************************************************)
SkipHazardSchedule ==
  << Ev("hook", FALSE, 99),
     Ev("wait", TRUE,  0),
     Ev("step", TRUE,  0) >>

=============================================================================
