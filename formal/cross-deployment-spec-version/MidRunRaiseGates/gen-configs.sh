#!/usr/bin/env bash
# Regenerates every MidRunRaiseGates *.cfg. Base = the atomic lattice setting
# (one delivery, caller run_created atomic, no stale reads, no terminal
# writer, no recovery); each config overrides some constants.
set -eu
cd "$(dirname "$0")"
source ./gen-lib.sh
LAT="TypeOK ReplayConsistent NoNeedlessRefusal ExecutorCanReplay"
ALL="TypeOK ExecutorCanReplay NoMixedIdentityLog CallerCanDecode ReplayConsistent"
S9=$'MaxV=9\nInitVersions={1, 2, 3, 4, 5, 6, 7, 8, 9}\nExecVersions={6, 7, 8, 9}\nReaderCode=9'

# --- A. version lattice: raise rule vs structural set (revision-1 configs) ---
gen Default_S67            "" "$LAT" "Monotone"
gen AllowList_S67          'Rule="allowlist"' "$LAT" "Monotone"
gen Default_S679           "$S9"$'\nStructuralSet={6, 7, 9}' "TypeOK ReplayConsistent ExecutorCanReplay" "Monotone"
gen AllowList_S679         "$S9"$'\nStructuralSet={6, 7, 9}\nRule="allowlist"' "$LAT" "Monotone"
gen Default_S67_Cap9       "$S9" "$LAT" "Monotone"
gen AllowList_S67_Cap9_Safety "$S9"$'\nRule="allowlist"' "TypeOK ReplayConsistent ExecutorCanReplay" "Monotone"
gen AllowList_S67_Cap9_Cost   "$S9"$'\nRule="allowlist"' "TypeOK NoNeedlessRefusal" "Monotone"
gen Default_S267_Legacy    'StructuralSet={2, 6, 7}' "$LAT" "Monotone"
gen Mutant_NoFreshCheck_S67 'Rule="none"' "TypeOK ReplayConsistent ExecutorCanReplay" "Monotone"

# --- B. G1: reader code, one gap per config (main target: reader 8, mints 6|8) ---
M=$'InitVersions={2, 3, 4, 5, 6, 7, 8}\nExecVersions={6, 8}\nMaxLog=5'
gen G1_NoAttest            "$M"$'\nExecVersions={0}' "TypeOK ExecutorCanReplay" ""
gen G1_Attest_Atomic       "$M" "TypeOK ExecutorCanReplay NoMixedIdentityLog" "Monotone"
gen G1_NotCommitted        "$M"$'\nCallerSplit=TRUE' "TypeOK ExecutorCanReplay" ""
gen G1_ResilientStart      "$M"$'\nResilientStart=TRUE' "TypeOK ExecutorCanReplay" ""
# --- C. G2/G4: split terminal write and head-read/transaction window ---
gen G2_CancelRace          "$M"$'\nCancelEnabled=TRUE' "TypeOK NoMixedIdentityLog" ""
gen G2_StaleStarters       "$M"$'\nD={1, 2}\nSerial=FALSE' "TypeOK NoMixedIdentityLog ExecutorCanReplay" ""
gen G2_StaleStarters_EC    "$M"$'\nD={1, 2}\nSerial=FALSE\nStaleReads=TRUE' "TypeOK NoMixedIdentityLog ExecutorCanReplay" ""
# --- D. G3: the caller decodes the output ---
gen G3_StableCaller        $'InitVersions={3}\nExecVersions={6, 8}\nCallerCode=3\nTurbo=TRUE\nMaxLog=5' "TypeOK CallerCanDecode ExecutorCanReplay" ""
gen G3_StableCaller_StampGate $'InitVersions={3}\nExecVersions={6, 8}\nCallerCode=3\nTurbo=TRUE\nMaxLog=5\nCompressGate="stamp"' "TypeOK CallerCanDecode ExecutorCanReplay" ""
gen G3_V5Caller            "$M"$'\nTurbo=TRUE\nCallerCode=7' "TypeOK CallerCanDecode" ""
# --- E. G5: missing-run-event recovery ---
gen G5_Recovery_Monotone   "$M"$'\nRecovery=TRUE\nInsertMayFail=TRUE' "TypeOK" "Monotone"
gen G5_Recovery_Mixed      "$M"$'\nRecovery=TRUE\nInsertMayFail=TRUE' "TypeOK NoMixedIdentityLog" ""
gen G5_Recovery_Fixed      "$M"$'\nRecovery=TRUE\nInsertMayFail=TRUE\nFixRecovery=TRUE\nFixResilient=TRUE' "TypeOK NoMixedIdentityLog ExecutorCanReplay" "Monotone"
# --- F. G6: terminal resurrection by a stale starter ---
gen G6_Resurrect           "$M"$'\nD={1, 2}\nSerial=FALSE\nCancelEnabled=TRUE' "TypeOK" "TerminalAbsorbing"
gen G6_Resurrect_Guarded   "$M"$'\nD={1, 2}\nSerial=FALSE\nCancelEnabled=TRUE\nFixGuardStart=TRUE' "TypeOK" "TerminalAbsorbing"

# --- G. everything at once: #1044 as-is, and with every proposed fix ---
F=$'InitVersions={3, 5, 6, 8}\nExecVersions={6, 8}\nD={1, 2}\nSerial=FALSE\nMaxLog=5\nMaxAttempts=2\nStaleReads=TRUE\nCallerSplit=TRUE\nResilientStart=TRUE\nCancelEnabled=TRUE\nTurbo=TRUE\nRecovery=TRUE\nInsertMayFail=TRUE'
FIX=$'\nFixResilient=TRUE\nFixRetrySkips=TRUE\nFixCancelGuard=TRUE\nFixGuardStart=TRUE\nFixRecovery=TRUE\nCompressGate="stamp"'
HARD="TypeOK ExecutorCanReplay NoMixedIdentityLog"
gen Full_Current           "$F" "$HARD ReplayConsistent" "Monotone TerminalAbsorbing"
for p in ExecutorCanReplay NoMixedIdentityLog ReplayConsistent; do
  gen "Full_Current__$p"   "$F" "TypeOK $p" ""
done
for p in Monotone TerminalAbsorbing; do
  gen "Full_Current__$p"   "$F" "TypeOK" "$p"
done
gen Full_Proposed          "$F$FIX" "$HARD" "Monotone TerminalAbsorbing"
gen Full_Proposed__ReplayConsistent "$F$FIX" "TypeOK ReplayConsistent" ""
gen G4_Window_Proposed_NoRecovery "$F$FIX"$'\nRecovery=FALSE' "$HARD ReplayConsistent" "Monotone TerminalAbsorbing"
gen Full_Proposed_StableCaller "$F$FIX"$'\nInitVersions={3}\nCallerCode=3' "$HARD CallerCanDecode" "Monotone TerminalAbsorbing"

# --- I. #1044 @ 9159765 (flag on), regression witness: allow-list rule, P1,
# bounded P2 (RetryBudget window retries, reread on a doomed skip), P3 on
# ULID-mode writes only, run_started guard status==held.status AND
# spec==held.spec, reset-to-pending recovery, terminal re-check after the
# upgrade on the main path only (revive-terminal gap), no #1061.
HEADK=$'\nRule="allowlist"\nFixResilient=TRUE\nFixCancelGuard=TRUE\nCancelGuardUlidOnly=TRUE\nHeadUpgrade=TRUE\nRetryBudget=2\nHeadGuardStart=TRUE\nRecoveryReset=TRUE'
gen Full_H9159765          "$F$HEADK" "$HARD" "Monotone TerminalAbsorbing"
gen Full_H9159765__TerminalAbsorbing "$F$HEADK" "TypeOK" "TerminalAbsorbing"

# --- J. #1044 @ f83173c (HEAD, flag on = default): I + #1061 (caller and
# resilient start commit run row + run_created atomically) + #1065
# (run_started where status == 'pending' AND spec == held.spec) + 09887ac
# (terminal re-check on the refetch path too) + 4b7b241 (reset only runs
# carrying raisedFromSpecVersion, others delete-and-rebuild).
HEADF="$HEADK"$'\nCallerSplit=FALSE\nAtomicRsCreate=TRUE\nGuardPendingOnly=TRUE\nFixReviveGap=TRUE\nResetOnlyRaised=TRUE'
gen Full_Head              "$F$HEADF" "$HARD" "Monotone TerminalAbsorbing"
# Full_Head checks the HARD invariants + both action properties together
# (so per-property and single-executor-version runs are implied); the
# revision-1 ReplayConsistent gets its own run, CallerCanDecode is checked
# with a stable caller below (CallerCode 8 decodes everything).
gen Full_Head__ReplayConsistent "$F$HEADF" "TypeOK ReplayConsistent" ""
gen Full_Head_StableCaller "$F$HEADF"$'\nInitVersions={3}\nCallerCode=3' "$HARD CallerCanDecode" "Monotone TerminalAbsorbing"
gen Full_Head_NoWindowPremise "$F$HEADF"$'\nWindowHolds=FALSE' "$HARD" "Monotone TerminalAbsorbing"
# kill switch WORKFLOW_FLAG_RUN_SPEC_VERSION_UPGRADE=0: attestation ignored
gen Full_Head_FlagOff      "$F$HEADF"$'\nExecVersions={0}' "$HARD" "Monotone TerminalAbsorbing"
# pre-PR reference: main with #1061 + #1065, no attestation, no P3, rebuild
gen Full_Main              "$F"$'\nCallerSplit=FALSE\nAtomicRsCreate=TRUE\nHeadGuardStart=TRUE\nGuardPendingOnly=TRUE\nExecVersions={0}' "$HARD" "Monotone TerminalAbsorbing"
# allow-list rule over the lattice with the HEAD request machinery
gen Head_AllowList_S679    "$S9"$'\nStructuralSet={6, 7, 9}'"$HEADF" "$LAT" "Monotone"

# --- H. ForceClaimGate.tla: the #4193 victim gate vs a concurrent raise ---
HEAD=$'VictimCode=7\nMinted={6, 7}'
STABLE=$'VictimCode=3\nMinted={3}'
genfc FC_Main_Probe             "" "TypeOK NoStrandedVictim GateSound" "Monotone"
genfc FC_Main_Explicit          $'ExplicitStamps={2, 3, 5, 6, 7, 8, 9}' "TypeOK NoStrandedVictim GateSound" "Monotone"
genfc FC_Head4327_Probe         "$HEAD" "TypeOK NoStrandedVictim GateSound" "Monotone"
genfc FC_Head4327_Explicit      "$HEAD"$'\nExplicitStamps={8}' "TypeOK NoStrandedVictim" "Monotone"
genfc FC_Stable_Probe           "$STABLE" "TypeOK NoStrandedVictim GateSound" "Monotone"
genfc FC_Stable_Explicit        "$STABLE"$'\nExplicitStamps={6, 7, 8, 9}' "TypeOK NoStrandedVictim" "Monotone"
genfc FC_Stable_Explicit_GateSound "$STABLE"$'\nExplicitStamps={6, 7, 8, 9}' "TypeOK GateSound" ""
genfc FC_Mutant_Gate7_Head4327  "$HEAD"$'\nGateThreshold=7' "TypeOK NoStrandedVictim" "Monotone"
genfc FC_Main_Resurrect         $'StaleStart=TRUE' "TypeOK NoStrandedVictim GateSound" "Monotone"
genfc FC_Main_Resurrect_Terminal $'StaleStart=TRUE' "TypeOK" "TerminalAbsorbing"
genfc FC_Main_Resurrect_Guarded $'StaleStart=TRUE\nFixGuardStart=TRUE' "TypeOK NoStrandedVictim GateSound" "Monotone TerminalAbsorbing"
genfc FC_Witness_ReadThenRaise  $'CallerWorlds={7}\nCliReuse=FALSE' "TypeOK W_ReadThenRaise_Refused" "Monotone"
genfc FC_Witness_RaiseThenTake  $'CallerWorlds={7}\nCliReuse=FALSE' "TypeOK W_RaiseThenTake" "Monotone"
