#!/usr/bin/env python3
"""Generates every ServerRaiseProtocol *.cfg from one table (python3 gen_cfgs.py).

Each <name>.cfg is the SAFETY run (BoundedLatency = FALSE: every interleaving).
run.sh derives the PROGRESS run from it (BoundedLatency = TRUE, FairSpec,
GoodOutcome + NoStuck + Termination) and the per-property isolation runs.
"""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = dict(CallerStamps="{3, 6, 7, 8}", ExecVersions="{6, 7, 8}", D="{1, 2}",
            MaxAttempts=2, StaleReads=True, CallerMayFail=True,
            CallerMayCrash=False, MaxCrashes=0, CancelEnabled=True,
            ResilientStart=True, RunCreatedAtomic=False,
            BoundedLatency=False, GraceHolds=True,
            PropResilient=False, PropResilientEventMax=False,
            PropRetrySkips=False, PropRetryNotFresh=False,
            PropCancelGuard=False, PropGuardStart=False,
            PropAtomicCreate=False,
            # 9159765 switches (defaults = the model before HEAD; the old
            # configs explore exactly the state space they did before)
            FlagOn=True, HeadUpgrade=False, RetryBudget=0, WindowHolds=True,
            HeadGuardStart=False, FixReviveGap=False, RecoveryReset=False,
            TurboWrites=False, StepStatusCheck=True,
            # f83173c switches (FALSE = 9159765 / earlier behaviour)
            GuardPendingOnly=False, ResetOnlyRaised=False, AdoptOrphanRC=False,
            StepCheckConsistent=False, StaleSettles=False)
FULL = dict(PropResilient=True, PropResilientEventMax=True, PropRetrySkips=True,
            PropRetryNotFresh=True, PropCancelGuard=True, PropGuardStart=True)
MIN = dict(FULL, PropRetryNotFresh=False)
REC = dict(MIN, PropRetrySkips=False, PropAtomicCreate=True)
# one executor-request crash + a caller crash; 3 attempts = crash, recovery
# delete, resilient rebuild, +1 for a 503 while a duplicate is mid-start
CRASH = dict(CallerMayCrash=True, MaxCrashes=1, MaxAttempts=4)
# #1044 @ 9159765 (flag on): P1+P1e, bounded P2 (60 s window of retryable
# 503s, modelled as RetryBudget retries run-wide), P3, run_started guard
# status == held.status AND spec == held.spec, reset-to-pending recovery for
# every run with a run_created. P5 NOT merged yet; no terminal re-check after
# the conflict-refetch upgrade (the revive-terminal gap).
H9159765 = dict(PropResilient=True, PropResilientEventMax=True, PropCancelGuard=True,
                HeadUpgrade=True, RetryBudget=2, HeadGuardStart=True,
                RecoveryReset=True)
# #1044 @ f83173c (flag on, the default): 9159765 + #1061 (P5: run row and
# run_created in one TX, both in handleRunCreated and resilient start; a slot
# conflict with no run row writes the row alone and adopts the orphan) +
# #1065 (run_started .where status == 'pending' AND spec == held.spec) +
# 09887ac (terminal re-check after the refetch upgrade) + 4b7b241 (reset only
# runs carrying raisedFromSpecVersion; others delete-and-rebuild).
HEAD = dict(H9159765, PropAtomicCreate=True, FixReviveGap=True,
            GuardPendingOnly=True, ResetOnlyRaised=True, AdoptOrphanRC=True)
# main before #1044 (pre-PR reference): no attestation honoured, no P3, no
# reset (delete-and-rebuild), with #1061 and #1065 from main.
MAIN = dict(HEAD, FlagOn=False, PropCancelGuard=False, RecoveryReset=False,
            ResetOnlyRaised=False)
TURBO = dict(TurboWrites=True)
CONFIGS = {
  "CURRENT": ("#1044 as written", {}),
  "CURRENT_iso_starters": ("isolation: concurrent starters only, consistent reads, atomic run_created",
      dict(StaleReads=False, CancelEnabled=False, ResilientStart=False, RunCreatedAtomic=True)),
  "CURRENT_iso_cancel": ("isolation: one starter + canceller, consistent reads, atomic run_created",
      dict(D="{1}", StaleReads=False, ResilientStart=False, RunCreatedAtomic=True)),
  # Reduced version sets / attempts: the unguarded CURRENT protocol with
  # crashes + recovery has >100M states at the full sets (39M at these sets
  # with 4 attempts); every crossing kind (3->6 rekey, 3->8 rekey+seal,
  # 6->8 seal, 7->8 plain, not-newer) is still covered.
  "CURRENT_crash": ("#1044 as written + request crashes (recovery reachable); reduced sets",
      dict(CRASH, CallerStamps="{3, 6, 7}", ExecVersions="{6, 8}", MaxAttempts=3)),
  "PROPOSED": ("P1+P1e+P2+P2b+P3 (no P4, no P5)", dict(FULL, PropGuardStart=False)),
  "PROPOSED_FULL": ("P1+P1e+P2+P2b+P3+P4 (no P5)", FULL),
  "PROPOSED_MIN": ("P1+P1e+P2+P3+P4 (no P5)", MIN),
  "PROPOSED_FULL_noP1": ("minimality: FULL without P1/P1e", dict(FULL, PropResilient=False, PropResilientEventMax=False)),
  "PROPOSED_FULL_noP2": ("minimality: FULL without P2/P2b", dict(FULL, PropRetrySkips=False, PropRetryNotFresh=False)),
  "PROPOSED_FULL_noP3": ("minimality: FULL without P3", dict(FULL, PropCancelGuard=False)),
  "PROPOSED_MIN_noP1e": ("MIN, but the synthetic run_created keeps input.specVersion", dict(MIN, PropResilientEventMax=False)),
  "PROPOSED_FULL_crash": ("FULL + crashes", dict(FULL, **CRASH)),
  "PROPOSED_MIN_crash": ("MIN + crashes", dict(MIN, **CRASH)),
  "PROPOSED_P5_only": ("#1044 + P5 only", dict(PropAtomicCreate=True)),
  "PROPOSED_MIN_P5": ("MIN + P5", dict(MIN, PropAtomicCreate=True)),
  "PROPOSED_MIN_P5_crash": ("MIN + P5 + crashes", dict(MIN, PropAtomicCreate=True, **CRASH)),
  "RECOMMENDED": ("P1+P1e+P3+P4+P5 (P2 dropped)", REC),
  "RECOMMENDED_noP1": ("minimality: RECOMMENDED without P1/P1e", dict(REC, PropResilient=False, PropResilientEventMax=False)),
  "RECOMMENDED_noP1e": ("minimality: RECOMMENDED without P1e", dict(REC, PropResilientEventMax=False)),
  "RECOMMENDED_noP3": ("minimality: RECOMMENDED without P3", dict(REC, PropCancelGuard=False)),
  "RECOMMENDED_noP4": ("minimality: RECOMMENDED without P4", dict(REC, PropGuardStart=False)),
  "RECOMMENDED_noP5": ("minimality: RECOMMENDED without P5", dict(REC, PropAtomicCreate=False)),
  "RECOMMENDED_crash": ("RECOMMENDED + crashes", dict(REC, **CRASH)),
  "RECOMMENDED_crash_noGrace": ("RECOMMENDED + crashes, recovery grace window not assumed", dict(REC, GraceHolds=False, **CRASH)),
  "RECOMMENDED_D3": ("RECOMMENDED, three concurrent deliveries (reduced version sets)",
      dict(REC, D="{1, 2, 3}", CallerStamps="{3, 7, 8}", ExecVersions="{6, 8}")),
  # --- #1044 @ 9159765 (regression witness) ---
  "H9159765": ("#1044 @ 9159765, flag on (no P5, revive-terminal gap open)", H9159765),
  # --- #1044 @ f83173c ---
  "HEAD": ("#1044 @ f83173c, flag on (default)", HEAD),
  "HEAD_turbo": ("HEAD + turbo step writes after a failed backgrounded run_started (server EC status check as coded)",
      dict(HEAD, **TURBO)),
  "HEAD_turbo_noStepCheck": ("HEAD_turbo, hypothetical server accepting step writes on a pending run",
      dict(HEAD, StepStatusCheck=False, **TURBO)),
  "HEAD_turboFix": ("HEAD_turbo + server fix: the step write's running check reads consistently",
      dict(HEAD, StepCheckConsistent=True, **TURBO)),
  "HEAD_crash": ("HEAD + request crashes (recovery reachable)", dict(HEAD, **CRASH)),
  "HEAD_turbo_crash": ("HEAD_turbo + request crashes (reset-to-pending reachable)", dict(HEAD, **CRASH, **TURBO)),
  "HEAD_turboFix_crash": ("HEAD_turboFix + request crashes", dict(HEAD, StepCheckConsistent=True, **CRASH, **TURBO)),
  "HEAD_crash_settled": ("HEAD_crash, EC reads converged before a redelivery (progress premise)",
      dict(HEAD, StaleSettles=True, **CRASH)),
  "HEAD_turbo_crash_settled": ("HEAD_turbo_crash, EC reads converged before a redelivery",
      dict(HEAD, StaleSettles=True, **CRASH, **TURBO)),
  "HEAD_turboFix_crash_settled": ("HEAD_turboFix_crash, EC reads converged before a redelivery",
      dict(HEAD, StepCheckConsistent=True, StaleSettles=True, **CRASH, **TURBO)),
  "MAIN_turbo_crash_settled": ("MAIN + turbo writes + crashes, EC reads converged before a redelivery (pre-PR turbo reference)",
      dict(MAIN, StaleSettles=True, **CRASH, **TURBO)),
  "MAIN_turbo_crash_settled_slotStamps": ("MAIN_turbo_crash_settled with stamps >= 6 only (masks the S1 brick)",
      dict(MAIN, StaleSettles=True, CallerStamps="{6, 7, 8}", **CRASH, **TURBO)),
  "HEAD_noWindowPremise": ("HEAD, window retries may race in-flight requests", dict(HEAD, WindowHolds=False)),
  "HEAD_flagOff": ("HEAD with the kill switch WORKFLOW_FLAG_RUN_SPEC_VERSION_UPGRADE=0", dict(HEAD, FlagOn=False)),
  "HEAD_flagOff_crash": ("HEAD_flagOff + request crashes", dict(HEAD, FlagOn=False, **CRASH)),
  "MAIN": ("pre-PR reference: main with #1061 + #1065, no attestation, no P3, delete-and-rebuild", MAIN),
  "MAIN_crash": ("MAIN + request crashes", dict(MAIN, **CRASH)),
}
INVARIANTS = ["TypeOK", "NoMixedIdentityLog", "ExecutorReadable", "RunCreatedPresent",
              "RunCreatedFirstAndUnique", "RunCreatedSpecMatchesRow", "NoDoomedRun",
              "SpecNeverLowered", "ReplayNeverFails", "NoStuck"]
PROPERTIES = ["SpecMonotonic", "NoStructuralCrossAfterFirstNonCreatedEvent"]
def fmt(v):
    return ("TRUE" if v else "FALSE") if isinstance(v, bool) else str(v)
if __name__ == "__main__":
    for name, (desc, over) in CONFIGS.items():
        c = dict(BASE, **over)
        with open(os.path.join(HERE, name + ".cfg"), "w") as f:
            f.write(f"\\* ServerRaiseProtocol variant: {name} -- {desc}\n")
            f.write("\\* Generated by gen_cfgs.py (safety run); see ServerRaiseProtocol.tla header. Results: results/<config>*.txt\n")
            f.write("SPECIFICATION Spec\nCONSTANTS\n")
            for k, v in c.items():
                f.write(f"  {k} = {fmt(v)}\n")
            f.write("INVARIANTS\n" + "".join(f"  {i}\n" for i in INVARIANTS))
            f.write("PROPERTIES\n" + "".join(f"  {p}\n" for p in PROPERTIES))
            f.write("CHECK_DEADLOCK FALSE\n")
    print("\n".join(CONFIGS))
