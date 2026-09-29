#!/usr/bin/env bash
# Regenerates every config (gen-configs.sh), reruns every TLC check of the
# MidRunRaiseGates and ForceClaimGate models, and compares each outcome with
# the expected one. Full TLC output goes to results/<cfg>.txt.
#   ./run.sh              all configs
#   ./run.sh CFG...       only the named configs
#   TLA2TOOLS  path to tla2tools.jar (default: ~/.local/opt/tla2tools.jar)
#   JAVA       java binary (default: java)
#   WORKERS    TLC workers (default: 2)
#   TLC_TIMEOUT seconds per run (default: 900)
set -u
cd "$(dirname "$0")"
HERE="$(pwd)"
TLA2TOOLS="${TLA2TOOLS:-$HOME/.local/opt/tla2tools.jar}"
JAVA="${JAVA:-java}"
WORKERS="${WORKERS:-2}"
TLC_TIMEOUT="${TLC_TIMEOUT:-900}"
mkdir -p results states
bash ./gen-configs.sh

# config:module:expected   (pass | violation)
RUNS=(
  # A. version lattice (serialized requests), revision-1 comparisons
  "Default_S67:MidRunRaiseGates:pass"
  "AllowList_S67:MidRunRaiseGates:pass"
  "Default_S679:MidRunRaiseGates:violation"
  "AllowList_S679:MidRunRaiseGates:pass"
  "Default_S67_Cap9:MidRunRaiseGates:pass"
  "AllowList_S67_Cap9_Safety:MidRunRaiseGates:pass"
  "AllowList_S67_Cap9_Cost:MidRunRaiseGates:violation"
  "Default_S267_Legacy:MidRunRaiseGates:pass"
  "Mutant_NoFreshCheck_S67:MidRunRaiseGates:violation"
  # B-F. one fidelity gap per config
  "G1_NoAttest:MidRunRaiseGates:violation"
  "G1_Attest_Atomic:MidRunRaiseGates:pass"
  "G1_NotCommitted:MidRunRaiseGates:violation"
  "G1_ResilientStart:MidRunRaiseGates:violation"
  "G2_CancelRace:MidRunRaiseGates:violation"
  "G2_StaleStarters:MidRunRaiseGates:violation"
  "G2_StaleStarters_EC:MidRunRaiseGates:violation"
  "G3_StableCaller:MidRunRaiseGates:violation"
  "G3_StableCaller_StampGate:MidRunRaiseGates:pass"
  "G3_V5Caller:MidRunRaiseGates:pass"
  "G5_Recovery_Monotone:MidRunRaiseGates:violation"
  "G5_Recovery_Mixed:MidRunRaiseGates:violation"
  "G5_Recovery_Fixed:MidRunRaiseGates:pass"
  "G6_Resurrect:MidRunRaiseGates:violation"
  "G6_Resurrect_Guarded:MidRunRaiseGates:pass"
  # G. everything at once
  "Full_Current:MidRunRaiseGates:violation"
  "Full_Current__ExecutorCanReplay:MidRunRaiseGates:violation"
  "Full_Current__NoMixedIdentityLog:MidRunRaiseGates:violation"
  "Full_Current__ReplayConsistent:MidRunRaiseGates:violation"
  "Full_Current__Monotone:MidRunRaiseGates:violation"
  "Full_Current__TerminalAbsorbing:MidRunRaiseGates:violation"
  "Full_Proposed:MidRunRaiseGates:pass"
  "Full_Proposed__ReplayConsistent:MidRunRaiseGates:violation"
  "G4_Window_Proposed_NoRecovery:MidRunRaiseGates:pass"
  "Full_Proposed_StableCaller:MidRunRaiseGates:pass"
  # I. #1044 @ 9159765 (flag on), regression witness
  "Full_H9159765:MidRunRaiseGates:violation"
  "Full_H9159765__TerminalAbsorbing:MidRunRaiseGates:violation"
  # J. #1044 @ f83173c (HEAD, flag on)
  "Head_AllowList_S679:MidRunRaiseGates:pass"
  "Full_Head:MidRunRaiseGates:pass"
  "Full_Head__ReplayConsistent:MidRunRaiseGates:violation"
  "Full_Head_StableCaller:MidRunRaiseGates:violation"
  "Full_Head_NoWindowPremise:MidRunRaiseGates:pass"
  "Full_Head_FlagOff:MidRunRaiseGates:violation"
  "Full_Main:MidRunRaiseGates:violation"
  # H. force-claim victim gate
  "FC_Main_Probe:ForceClaimGate:pass"
  "FC_Main_Explicit:ForceClaimGate:pass"
  "FC_Head4327_Probe:ForceClaimGate:pass"
  "FC_Head4327_Explicit:ForceClaimGate:violation"
  "FC_Stable_Probe:ForceClaimGate:pass"
  "FC_Stable_Explicit:ForceClaimGate:violation"
  "FC_Stable_Explicit_GateSound:ForceClaimGate:violation"
  "FC_Mutant_Gate7_Head4327:ForceClaimGate:violation"
  "FC_Main_Resurrect:ForceClaimGate:violation"
  "FC_Main_Resurrect_Terminal:ForceClaimGate:violation"
  "FC_Main_Resurrect_Guarded:ForceClaimGate:pass"
  "FC_Witness_ReadThenRaise:ForceClaimGate:violation"
  "FC_Witness_RaiseThenTake:ForceClaimGate:violation"
)

status=0
for r in "${RUNS[@]}"; do
  IFS=: read -r cfg mod expect <<<"$r"
  if [ $# -gt 0 ] && [[ " $* " != *" $cfg "* ]]; then continue; fi
  out="results/$cfg.txt"
  rm -rf "states/$cfg"
  echo ">>> $cfg ($mod.tla), expecting $expect"
  timeout "$TLC_TIMEOUT" "$JAVA" -XX:+UseParallelGC -Xmx2g -cp "$TLA2TOOLS" tlc2.TLC \
    -workers "$WORKERS" -metadir "$HERE/states/$cfg" -config "$cfg.cfg" "$mod.tla" >"$out" 2>&1
  rm -rf "states/$cfg"
  if grep -q "No error has been found" "$out"; then got=pass
  elif grep -qE "is violated" "$out"; then got=violation
  else got=error; fi
  grep -E "is violated|No error has been found|distinct states found" "$out" | tail -2 | sed 's/^/    /'
  if [ "$got" = "$expect" ]; then echo "    OK ($got)"; else echo "    UNEXPECTED: got $got"; status=1; fi
done
exit $status
