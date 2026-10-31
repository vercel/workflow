--------------------------- MODULE MCSelfHealing ---------------------------
(***************************************************************************)
(* TLC harness for SelfHealing: one pending wait and one pending step --   *)
(* the two driver-message paths (wait continuation, step dispatch), each   *)
(* keyed on its entity's correlationId in the shipping discipline.         *)
(***************************************************************************)
EXTENDS SelfHealing

WaitAndStep == <<[kind |-> "wait"], [kind |-> "step"]>>

=============================================================================
